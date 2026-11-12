import { and, eq, isNull, sql } from "drizzle-orm";
import { canTransitionCycle, type CycleStatus } from "@shared/taxonomy";
import { revisionChanged } from "@shared/time";
import type { EvidenceLocator } from "@shared/contracts/evidence";
import type { Db } from "@server/db/client";
import * as s from "@server/db/schema";
import { uuidv7 } from "@server/db/columns";
import { canonicalJson, iso } from "@server/db/util";
import { audit, isAlreadyApplied, isStaleVersion, isUniqueViolation, registry, runBatch, versionGuard, type Stmt } from "@server/db/repos";
import type { EvidenceInsert } from "@server/db/repos/registry";
import { actorFor, assertClaimHeld, isAssertionFailure, taskAudit } from "./audit";
import { snapshotText } from "./evidence";
import type { CuratorIdentity } from "./guard";
import { changedCycleFields, findSlot, highImpactReasons, needsOfficialLink, type CurrentCycle, type CurrentDeadline, type HighImpactReason } from "./impact";
import type { CuratorBucket } from "./ports";
import { firstApproverOf } from "./queue";
import { EditsSchema, type CycleEditField, type EvidenceEdit, type Edits } from "./schemas";
import { officialOpenedAt, subjectLinks, type TaskRow } from "./store";
import { locateQuote } from "./text";

/**
 * Approve, and the publish step (plan 04 4.10 "Publishing").
 *
 * A high-impact change stops at `second_review` with the first approval stored on the task. A
 * second, different Curator confirms it (or edits it, which makes theirs the new first approval).
 * Everything else, and every confirmed high-impact change, publishes as ONE D1 batch:
 *
 *   1. assertion: the approving Curator still holds the claim (else the batch throws)
 *   2. publish guard: INSERT publish_guards(task id, version check); a stale cycle version or a
 *      repeated task id throws, so nothing below commits twice or over a newer version
 *   3. the cycle update (changed fields, verification, version + 1)
 *   4. Deadline inserts, revisions (ICS SEQUENCE + 1) and withdrawals
 *   5. FieldEvidence: previous quotes superseded, new quotes inserted (Snapshot, offsets, URL)
 *   6. registry_audit rows with before and after values, and the task's own audit row
 *   7. ChangeEvents (deadline.changed, cycle.status_changed, program_cycle.verified): the outbox
 *      alerts.match fans out to students' Alerts
 *   8. each cited Source's baseline moves to the cited Snapshot (the detector diffs against it)
 *   9. a pending RegistryRelease, unless one is already pending, so release.build refreshes the
 *      browser index and MCP on its next tick
 *  10. the task: applied, with resolution, timer seconds and who approved
 *
 * A stale version re-opens the task (`apply_failed` in the plan's words) with the failure noted,
 * so the next claim sees a fresh diff.
 */

export type ApproveOutcome =
  | { status: "applied"; changeEvents: number; releaseRequested: boolean; changes: number }
  | { status: "second_review"; reasons: HighImpactReason[] }
  | { status: "error"; code: "validation_failed" | "conflict" | "version_conflict" | "precondition_failed"; detail: string; path?: string };

/** How recently the official link must have been opened for a changed deadline, status or URL. */
export const OFFICIAL_LINK_MAX_AGE_MS = 12 * 60 * 60_000;

type CycleRow = typeof s.programCycles.$inferSelect;
type DeadlineRow = typeof s.deadlines.$inferSelect;

const err = (code: Extract<ApproveOutcome, { status: "error" }>["code"], detail: string, path?: string): ApproveOutcome => ({ status: "error", code, detail, path });

interface CheckedEvidence {
  insert: Omit<EvidenceInsert, "entityType" | "entityId" | "fieldPath">;
  snapshotId: string | null;
  sourceId: string | null;
}

/** Validates one quote: the Snapshot exists, belongs to this program, and contains the quote verbatim. */
async function checkEvidence(
  db: Db,
  bucket: CuratorBucket | null,
  e: EvidenceEdit,
  programId: string,
  curatorId: string,
  path: string,
): Promise<{ ok: true; value: CheckedEvidence } | { ok: false; outcome: ApproveOutcome }> {
  if (e.basis === "manual_note" || e.snapshotId === null) {
    return {
      ok: true,
      value: { insert: { basis: "manual_note", snapshotId: null, url: e.url, quote: e.quote, locator: null, match: "manual", verifiedBy: curatorId }, snapshotId: null, sourceId: null },
    };
  }
  const found = await snapshotText(db, bucket, e.snapshotId);
  if (!found) return { ok: false, outcome: err("validation_failed", "The cited Snapshot does not exist.", path) };
  const source = await db.query.sources.findFirst({ where: eq(s.sources.id, found.snapshot.sourceId) });
  if (!source || source.programId !== programId) return { ok: false, outcome: err("validation_failed", "The cited Snapshot belongs to another program.", path) };
  const isPdf = found.snapshot.contentType.toLowerCase().includes("pdf");
  let locator: EvidenceLocator | null = null;
  let match: "exact" | "manual" = "manual";
  if (found.text !== null) {
    const range = locateQuote(found.text, e.quote);
    if (!range) return { ok: false, outcome: err("validation_failed", "The quote is not in the Snapshot text. Copy it verbatim from the page.", path) };
    // The stored quote is the canonical Snapshot text at the located span, not the typed copy.
    const canonical = found.text.slice(range.start, range.end);
    locator = isPdf && e.page !== null ? { kind: "pdf_text", page: e.page, start: range.start, end: range.end } : { kind: "html", start: range.start, end: range.end };
    match = "exact";
    return {
      ok: true,
      value: {
        insert: { basis: "snapshot", snapshotId: found.snapshot.id, url: e.url, quote: canonical, locator, match, verifiedBy: curatorId },
        snapshotId: found.snapshot.id,
        sourceId: found.snapshot.sourceId,
      },
    };
  }
  return {
    ok: true,
    value: { insert: { basis: "snapshot", snapshotId: found.snapshot.id, url: e.url, quote: e.quote, locator, match, verifiedBy: curatorId }, snapshotId: found.snapshot.id, sourceId: found.snapshot.sourceId },
  };
}

function currentCycle(row: CycleRow): CurrentCycle {
  return { status: row.status as CycleStatus, applicationUrl: row.applicationUrl, applicationFeeCents: row.applicationFeeCents, opensOn: row.opensOn };
}

function currentDeadline(row: DeadlineRow): CurrentDeadline {
  return { id: row.id, kind: row.kind, scope: row.scope, institutionId: row.institutionId, roundLabel: row.roundLabel, localDate: row.localDate };
}

function hasChanges(cycle: CurrentCycle | null, edits: Edits): boolean {
  return edits.deadlines.length > 0 || changedCycleFields(cycle, edits).length > 0;
}

/**
 * A pending RegistryRelease unless one is already pending (release.build builds only the newest
 * unpublished one). With a pending release the computed number IS that release, so the insert
 * hits the primary key and does nothing.
 */
function requestRelease(db: Db, now: number): Stmt {
  return db
    .insert(s.registryReleases)
    .values({
      number: sql`(SELECT coalesce((SELECT min(number) FROM registry_releases WHERE state = 'pending'), (SELECT coalesce(max(number), 0) + 1 FROM registry_releases)))`,
      state: "pending",
      createdAt: now,
    })
    .onConflictDoNothing();
}

export interface ApproveInput {
  edits: Edits | undefined;
  resolution: string;
  subjectVersion: number | null;
  activeSeconds: number;
}

export async function approveTask(
  db: Db,
  bucket: CuratorBucket | null,
  row: TaskRow,
  who: CuratorIdentity,
  input: ApproveInput,
  now: number,
): Promise<ApproveOutcome> {
  const actor = actorFor(who.handle, who.isAdmin);

  // ---- Second review: the first approver cannot confirm their own change -------------------
  const firstBy = firstApproverOf(row);
  const stored = row.payload.firstApproval as { edits?: unknown; subjectVersion?: unknown } | undefined;
  if (firstBy === who.id) return err("conflict", "A second Curator must confirm this change.");
  let edits: Edits;
  let confirming = false;
  if (firstBy && stored) {
    const storedEdits = EditsSchema.parse(stored.edits ?? {});
    if (!input.edits || canonicalJson(input.edits) === canonicalJson(storedEdits)) {
      edits = storedEdits;
      confirming = true;
    } else {
      edits = input.edits;
    }
  } else {
    edits = input.edits ?? EditsSchema.parse({});
  }
  const subjectVersion = input.subjectVersion ?? (confirming && typeof stored?.subjectVersion === "number" ? stored.subjectVersion : null);

  // ---- Subject: program and cycle ------------------------------------------------------------
  const link = (await subjectLinks(db, [row])).get(row.id);
  const programId = link?.programId ?? null;
  let cycleId = link?.cycleId ?? null;
  if (edits.cycleId) {
    if (cycleId && edits.cycleId !== cycleId) return err("validation_failed", "Edits name a different cycle than the task.", "edits.cycleId");
    cycleId = edits.cycleId;
  }
  const cycleRow = cycleId ? await registry.getCycle(db, cycleId) : undefined;
  if (cycleId && (!cycleRow || (programId && cycleRow.programId !== programId))) return err("validation_failed", "That cycle does not belong to this task's program.", "edits.cycleId");

  // ---- No cycle: an attestation-only approval (nothing to publish) -----------------------------
  if (!cycleRow) {
    if (hasChanges(null, edits)) return err("validation_failed", "Edits need a cycle: name one with edits.cycleId.", "edits.cycleId");
    return finishWithoutPublish(db, row, who, input, now);
  }

  const cycle = currentCycle(cycleRow);
  const liveDeadlines = await db
    .select()
    .from(s.deadlines)
    .where(and(eq(s.deadlines.programCycleId, cycleRow.id), isNull(s.deadlines.withdrawnAt)));
  const current = liveDeadlines.map(currentDeadline);
  const changes = hasChanges(cycle, edits);
  if (!changes && !edits.verify) return finishWithoutPublish(db, row, who, input, now);

  if (subjectVersion === null) return err("validation_failed", "Send the cycle version you reviewed (subjectVersion).", "subjectVersion");

  // ---- Field rules ------------------------------------------------------------------------------
  const changedFields = changedCycleFields(cycle, edits);
  for (const f of changedFields) {
    if (f === "status") {
      const to = edits.cycle.status!;
      if (!canTransitionCycle(cycle.status, to)) return err("validation_failed", `A cycle cannot move from ${cycle.status} to ${to}.`, "edits.cycle.status");
    }
    if (!edits.cycleEvidence[f as CycleEditField]) return err("validation_failed", `A changed ${f} needs a quote from the official page.`, `edits.cycleEvidence.${f}`);
  }
  if (needsOfficialLink(cycle, edits)) {
    const opened = officialOpenedAt(row, who.id);
    if (opened === null || now - opened > OFFICIAL_LINK_MAX_AGE_MS) {
      return err("precondition_failed", "Open the live official page before approving a changed deadline, status or URL.");
    }
  }

  // ---- Evidence checks (before any write) ---------------------------------------------------
  const cycleEvidence = new Map<string, CheckedEvidence>();
  for (const f of changedFields) {
    const checked = await checkEvidence(db, bucket, edits.cycleEvidence[f as CycleEditField]!, cycleRow.programId, who.id, `edits.cycleEvidence.${f}`);
    if (!checked.ok) return checked.outcome;
    cycleEvidence.set(f, checked.value);
  }

  interface PlannedDeadline {
    kind: "upsert" | "withdraw";
    id: string;
    before: DeadlineRow | null;
    row?: typeof s.deadlines.$inferInsert;
    changed: boolean;
    evidence: CheckedEvidence | null;
  }
  const planned: PlannedDeadline[] = [];
  for (const [i, op] of edits.deadlines.entries()) {
    const path = `edits.deadlines.${i}`;
    if (op.op === "withdraw") {
      const before = liveDeadlines.find((d) => d.id === op.deadlineId);
      if (!before) return err("validation_failed", "That deadline is not live on this cycle.", `${path}.deadlineId`);
      let ev: CheckedEvidence | null = null;
      if (op.evidence) {
        const checked = await checkEvidence(db, bucket, op.evidence, cycleRow.programId, who.id, `${path}.evidence`);
        if (!checked.ok) return checked.outcome;
        ev = checked.value;
      }
      planned.push({ kind: "withdraw", id: before.id, before, changed: true, evidence: ev });
      continue;
    }
    const slotRef = findSlot(current, op.deadline);
    const before = slotRef ? (liveDeadlines.find((d) => d.id === slotRef.id) ?? null) : null;
    if (planned.some((p) => p.kind === "upsert" && before && p.id === before.id)) return err("validation_failed", "Two edits target the same deadline slot.", path);
    const id = before?.id ?? uuidv7(now);
    const inputRow = {
      programCycleId: cycleRow.id,
      kind: op.deadline.kind,
      scope: op.deadline.scope,
      institutionId: op.deadline.institutionId,
      roundLabel: op.deadline.roundLabel,
      basis: op.deadline.basis,
      precision: op.deadline.precision,
      tzMode: op.deadline.tzMode,
      localDate: op.deadline.localDate,
      localTime: op.deadline.localTime,
      windowStart: null,
      windowEnd: null,
      timeZone: op.deadline.timeZone,
      tzSource: op.deadline.tzSource,
      verificationState: "verified" as const,
    };
    const changed = !before || revisionChanged({ ...before, withdrawnAt: null } as Parameters<typeof revisionChanged>[0], { ...inputRow, withdrawnAt: null } as Parameters<typeof revisionChanged>[1]);
    const prepared = registry.prepareDeadlineRow(inputRow, id, before ? before.revision + (changed ? 1 : 0) : 1, now);
    if (!prepared.ok) return err("validation_failed", prepared.detail ?? "The deadline does not pass its rules.", `${path}.deadline`);
    const checked = await checkEvidence(db, bucket, op.evidence, cycleRow.programId, who.id, `${path}.evidence`);
    if (!checked.ok) return checked.outcome;
    planned.push({ kind: "upsert", id, before, row: prepared.value, changed, evidence: checked.value });
  }

  // ---- REQ-063: no community hint is approved without an official Snapshot behind it --------
  if (row.kind === "community_hint") {
    const cited = [...cycleEvidence.values(), ...planned.map((p) => p.evidence)].some((e) => e?.snapshotId);
    if (!cited) return err("validation_failed", "A community hint is approved only with a quote from an official Snapshot. Reject it, or re-check the official page first.", "edits");
  }

  // ---- High impact: stop at second review unless this approval confirms the first -------------
  const reasons = highImpactReasons(cycle, current, edits);
  if (reasons.length > 0 && !confirming) {
    const firstApproval = { by: who.id, at: iso(now), reasons, edits, subjectVersion };
    try {
      await runBatch(db, [
        assertClaimHeld(db, row.id, who.id, now),
        db
          .update(s.reviewTasks)
          .set({
            state: "second_review",
            claimedBy: null,
            claimExpiresAt: null,
            payload: { ...row.payload, firstApproval },
            activeSeconds: sql`${s.reviewTasks.activeSeconds} + ${input.activeSeconds}`,
            updatedAt: now,
          })
          .where(eq(s.reviewTasks.id, row.id)),
        taskAudit(db, { task: row, actor, action: "first_approval", before: { state: "claimed" }, after: { state: "second_review", reasons }, now }),
      ]);
    } catch (e) {
      if (isAssertionFailure(e)) return err("conflict", "You no longer hold this task.");
      throw e;
    }
    return { status: "second_review", reasons };
  }

  // ---- The publish batch -----------------------------------------------------------------------
  const pubAudit = (entityType: "program_cycle" | "deadline", entityId: string, field: string, before: unknown, after: unknown, snapshotIds: string[] = []): Stmt =>
    audit.registryAuditInsert(db, { at: now, actor, entityType, entityId, field, before, after, taskId: row.id, snapshotIds });
  const changeEvent = (type: string, key: string, payload: Record<string, unknown>): Stmt =>
    db
      .insert(s.changeEvents)
      .values({ id: uuidv7(now), type, programCycleId: cycleRow.id, payload, taskId: row.id, idempotencyKey: key, createdAt: now })
      .onConflictDoNothing();

  const stmts: Stmt[] = [assertClaimHeld(db, row.id, who.id, now), versionGuard(db, row.id, "program_cycles", cycleRow.id, subjectVersion, now)];
  let events = 0;

  const cycleSet: Partial<typeof s.programCycles.$inferInsert> = {};
  for (const f of changedFields) {
    const ev = cycleEvidence.get(f)!;
    const after = edits.cycle[f as CycleEditField] ?? null;
    if (f === "status") {
      cycleSet.status = after as CycleStatus;
      cycleSet.statusChangedAt = now;
      cycleSet.statusChangedBy = who.id;
    } else if (f === "applicationUrl") cycleSet.applicationUrl = after as string | null;
    else if (f === "applicationFeeCents") cycleSet.applicationFeeCents = after as number | null;
    else if (f === "opensOn") cycleSet.opensOn = after as string | null;
  }
  if (edits.verify) {
    cycleSet.verificationState = "verified";
    cycleSet.lastVerifiedAt = now;
    cycleSet.verifiedBy = who.id;
  }
  stmts.push(
    db
      .update(s.programCycles)
      .set({ ...cycleSet, updatedAt: now, version: sql`${s.programCycles.version} + 1` })
      .where(eq(s.programCycles.id, cycleRow.id)),
  );

  const citedSnapshots = new Map<string, string>(); // snapshotId -> sourceId
  const cite = (ev: CheckedEvidence | null) => {
    if (ev?.snapshotId && ev.sourceId) citedSnapshots.set(ev.snapshotId, ev.sourceId);
  };

  for (const f of changedFields) {
    const ev = cycleEvidence.get(f)!;
    cite(ev);
    const before = cycle[f as keyof CurrentCycle] ?? null;
    const after = edits.cycle[f as CycleEditField] ?? null;
    stmts.push(registry.supersedeEvidenceStatement(db, "program_cycle", cycleRow.id, f, now));
    stmts.push(registry.evidenceInsertStatement(db, [{ ...ev.insert, entityType: "program_cycle", entityId: cycleRow.id, fieldPath: f }], now)!);
    stmts.push(pubAudit("program_cycle", cycleRow.id, f, before, after, ev.snapshotId ? [ev.snapshotId] : []));
    if (f === "status") {
      stmts.push(changeEvent("cycle.status_changed", `${row.id}:cycle.status_changed:${cycleRow.id}`, { from: before, to: after }));
      events++;
      if (after === "ended") stmts.push(db.update(s.programs).set({ lifecycle: "ended", updatedAt: now }).where(eq(s.programs.id, cycleRow.programId)));
    }
  }

  for (const p of planned) {
    cite(p.evidence);
    const evidenceIds = p.evidence?.snapshotId ? [p.evidence.snapshotId] : [];
    if (p.kind === "withdraw") {
      const before = p.before!;
      stmts.push(db.update(s.deadlines).set({ withdrawnAt: now, revision: before.revision + 1, updatedAt: now }).where(eq(s.deadlines.id, p.id)));
      stmts.push(pubAudit("deadline", p.id, "withdrawn_at", null, iso(now), evidenceIds));
      stmts.push(
        changeEvent("deadline.changed", `${row.id}:deadline.changed:${cycleRow.id}:${p.id}`, {
          deadlineId: p.id,
          kind: before.kind,
          scope: before.scope,
          institutionId: before.institutionId ?? null,
          withdrawn: true,
          previousLocalDate: before.localDate,
          revision: before.revision + 1,
        }),
      );
      events++;
      if (p.evidence) stmts.push(registry.evidenceInsertStatement(db, [{ ...p.evidence.insert, entityType: "deadline", entityId: p.id, fieldPath: "withdrawn" }], now)!);
      continue;
    }
    const r = p.row!;
    if (p.before) {
      const { id: _id, createdAt: _c, ...rest } = r;
      stmts.push(db.update(s.deadlines).set({ ...rest, updatedAt: now }).where(eq(s.deadlines.id, p.id)));
    } else {
      stmts.push(db.insert(s.deadlines).values(r));
    }
    stmts.push(registry.supersedeEvidenceStatement(db, "deadline", p.id, "localDate", now));
    stmts.push(registry.evidenceInsertStatement(db, [{ ...p.evidence!.insert, entityType: "deadline", entityId: p.id, fieldPath: "localDate" }], now)!);
    if (p.changed) {
      stmts.push(
        pubAudit(
          "deadline",
          p.id,
          "deadline",
          p.before ? { kind: p.before.kind, localDate: p.before.localDate, localTime: p.before.localTime, timeZone: p.before.timeZone, precision: p.before.precision, revision: p.before.revision } : null,
          { kind: r.kind, localDate: r.localDate, localTime: r.localTime, timeZone: r.timeZone, precision: r.precision, revision: r.revision },
          evidenceIds,
        ),
      );
      stmts.push(
        // Fan-out needs the scope (campus rows reach only that campus's students), the kind (copy
        // and priority differ for decision dates), and the instants and clock times on both
        // sides, so an earlier time on the same date is still P0.
        changeEvent("deadline.changed", `${row.id}:deadline.changed:${cycleRow.id}:${p.id}`, {
          deadlineId: p.id,
          kind: r.kind,
          scope: r.scope,
          institutionId: r.institutionId ?? null,
          localDate: r.localDate ?? null,
          localTime: r.localTime ?? null,
          timeZone: r.timeZone ?? null,
          dueAt: r.dueAt ?? null,
          previousLocalDate: p.before?.localDate ?? null,
          previousLocalTime: p.before?.localTime ?? null,
          previousTimeZone: p.before?.timeZone ?? null,
          previousDueAt: p.before?.dueAt ?? null,
          revision: r.revision,
        }),
      );
      events++;
    }
  }

  if (edits.verify) {
    stmts.push(
      db
        .update(s.deadlines)
        .set({ verificationState: "verified", updatedAt: now })
        .where(and(eq(s.deadlines.programCycleId, cycleRow.id), isNull(s.deadlines.withdrawnAt), sql`${s.deadlines.basis} <> 'predicted'`)),
      db
        .update(s.requirements)
        .set({ verificationState: "verified", updatedAt: now })
        .where(and(eq(s.requirements.programCycleId, cycleRow.id), isNull(s.requirements.withdrawnAt))),
      pubAudit("program_cycle", cycleRow.id, "verification_state", cycleRow.verificationState, "verified"),
      changeEvent("program_cycle.verified", `${row.id}:program_cycle.verified:${cycleRow.id}`, {}),
    );
    events++;
  }

  for (const [snapshotId, sourceId] of citedSnapshots) {
    stmts.push(db.update(s.sources).set({ baselineSnapshotId: snapshotId, updatedAt: now }).where(eq(s.sources.id, sourceId)));
  }
  stmts.push(requestRelease(db, now));

  const approvedBy = confirming ? { firstApprover: firstBy, secondApprover: who.id } : { approver: who.id };
  stmts.push(
    db
      .update(s.reviewTasks)
      .set({
        state: "applied",
        resolution: input.resolution.slice(0, 500) || (changes ? "Approved with changes" : "Verified unchanged"),
        resolvedAt: now,
        claimExpiresAt: null,
        payload: { ...row.payload, approval: { ...approvedBy, at: iso(now), changes: changedFields.length + planned.length } },
        activeSeconds: sql`${s.reviewTasks.activeSeconds} + ${input.activeSeconds}`,
        updatedAt: now,
      })
      .where(eq(s.reviewTasks.id, row.id)),
    taskAudit(db, {
      task: row,
      actor,
      action: "approve",
      before: { state: "claimed", cycleVersion: subjectVersion },
      after: { state: "applied", changes: changedFields.length + planned.length, secondReview: confirming },
      now,
      snapshotIds: [...citedSnapshots.keys()],
    }),
  );

  try {
    await runBatch(db, stmts);
  } catch (e) {
    if (isAssertionFailure(e)) return err("conflict", "You no longer hold this task.");
    if (isStaleVersion(e)) {
      await reopenAfterStale(db, row, who, now);
      return err("version_conflict", "The cycle changed since you opened it. The task is back in the queue with a fresh diff.");
    }
    if (isAlreadyApplied(e)) return err("conflict", "This task was already applied.");
    if (isUniqueViolation(e)) return err("conflict", "Another live deadline already holds that slot.");
    throw e;
  }
  return { status: "applied", changeEvents: events, releaseRequested: true, changes: changedFields.length + planned.length };
}

/** Approve with nothing to publish (no cycle, or nothing changed and no verification). */
async function finishWithoutPublish(db: Db, row: TaskRow, who: CuratorIdentity, input: ApproveInput, now: number): Promise<ApproveOutcome> {
  try {
    await runBatch(db, [
      assertClaimHeld(db, row.id, who.id, now),
      db
        .update(s.reviewTasks)
        .set({
          state: "applied",
          resolution: input.resolution.slice(0, 500) || "Approved",
          resolvedAt: now,
          claimExpiresAt: null,
          payload: { ...row.payload, approval: { approver: who.id, at: iso(now), changes: 0 } },
          activeSeconds: sql`${s.reviewTasks.activeSeconds} + ${input.activeSeconds}`,
          updatedAt: now,
        })
        .where(eq(s.reviewTasks.id, row.id)),
      taskAudit(db, { task: row, actor: actorFor(who.handle, who.isAdmin), action: "approve", before: { state: "claimed" }, after: { state: "applied", changes: 0 }, now }),
    ]);
  } catch (e) {
    if (isAssertionFailure(e)) return err("conflict", "You no longer hold this task.");
    throw e;
  }
  return { status: "applied", changeEvents: 0, releaseRequested: false, changes: 0 };
}

/** A stale version: the task re-opens (plan: apply_failed re-opens it with a fresh diff). */
async function reopenAfterStale(db: Db, row: TaskRow, who: CuratorIdentity, now: number): Promise<void> {
  const { firstApproval: _drop, ...rest } = row.payload;
  await runBatch(db, [
    db
      .update(s.reviewTasks)
      .set({ state: "open", claimedBy: null, claimExpiresAt: null, payload: { ...rest, lastApplyFailure: { at: iso(now), reason: "stale_version" } }, updatedAt: now })
      .where(and(eq(s.reviewTasks.id, row.id), eq(s.reviewTasks.state, "claimed"), eq(s.reviewTasks.claimedBy, who.id))),
    taskAudit(db, { task: row, actor: actorFor(who.handle, who.isAdmin), action: "apply_failed", before: { state: "claimed" }, after: { state: "open", reason: "stale_version" }, now }),
  ]);
}
