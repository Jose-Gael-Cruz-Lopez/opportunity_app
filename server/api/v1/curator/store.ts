import { and, eq, inArray, sql } from "drizzle-orm";
import type { ReviewTask } from "@shared/contracts/ops";
import type { Db } from "@server/db/client";
import * as s from "@server/db/schema";
import { jobs as jobsRepo, registry, review, runBatch, type Stmt } from "@server/db/repos";
import { actorFor, assertClaimHeld, assertTaskUnchanged, isAssertionFailure, taskAudit } from "./audit";
import type { CuratorIdentity } from "./guard";
import { CLAIM_LEASE_MS, firstApproverOf, severityOf, snoozedUntil, type QueueRow } from "./queue";
import type { QueueView, RejectReason, TaskContext } from "./schemas";

/**
 * Reads and state changes of ReviewTasks for the Curator routes. Every change is one D1 batch
 * that starts with an assertion (claim held, or row unchanged for a claim) and ends with its
 * registry_audit row, so the change and its audit commit together or not at all.
 */

export type TaskRow = typeof s.reviewTasks.$inferSelect;

export type ActionResult = { ok: true } | { ok: false; error: "conflict"; detail: string };

const conflict = (detail: string): ActionResult => ({ ok: false, error: "conflict", detail });

export async function getTask(db: Db, id: string): Promise<TaskRow | null> {
  return (await db.query.reviewTasks.findFirst({ where: eq(s.reviewTasks.id, id) })) ?? null;
}

const VIEW_STATES: Record<QueueView, readonly string[]> = {
  queue: ["open", "claimed", "second_review", "snoozed"],
  mine: ["claimed"],
  second_review: ["second_review"],
  escalated: ["escalated"],
  snoozed: ["snoozed"],
};

/** Upper bound on rows read per listing; console v0 queues are hundreds, not thousands. */
export const CANDIDATE_LIMIT = 1000;

export async function candidateRows(db: Db, view: QueueView, kind?: string): Promise<TaskRow[]> {
  return db
    .select()
    .from(s.reviewTasks)
    .where(and(inArray(s.reviewTasks.state, [...VIEW_STATES[view]]), kind ? eq(s.reviewTasks.kind, kind) : sql`1 = 1`))
    .limit(CANDIDATE_LIMIT);
}

export function toQueueRow(row: TaskRow): QueueRow {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    priority: row.priority,
    dueAt: row.dueAt,
    createdAt: row.createdAt,
    claimedBy: row.claimedBy,
    claimExpiresAt: row.claimExpiresAt,
    payload: row.payload,
  };
}

export async function toWire(db: Db, rows: readonly TaskRow[]): Promise<ReviewTask[]> {
  const handles = await registry.curatorHandles(db);
  return rows.map((r) => review.toReviewTask(r, handles));
}

/** Resolves each task's subject to its program and cycle (for names, the wedge flag and edits). */
export async function subjectLinks(db: Db, rows: readonly Pick<TaskRow, "id" | "subjectType" | "subjectId">[]) {
  const cycleIds = new Set<string>();
  const programIds = new Set<string>();
  const deadlineIds: string[] = [];
  const requirementIds: string[] = [];
  for (const r of rows) {
    if (r.subjectType === "program_cycle") cycleIds.add(r.subjectId);
    else if (r.subjectType === "program") programIds.add(r.subjectId);
    else if (r.subjectType === "deadline") deadlineIds.push(r.subjectId);
    else if (r.subjectType === "requirement") requirementIds.push(r.subjectId);
  }
  const deadlineCycle = new Map<string, string>();
  if (deadlineIds.length) {
    for (const d of await db.select({ id: s.deadlines.id, cycleId: s.deadlines.programCycleId }).from(s.deadlines).where(inArray(s.deadlines.id, deadlineIds))) {
      deadlineCycle.set(d.id, d.cycleId);
      cycleIds.add(d.cycleId);
    }
  }
  const requirementCycle = new Map<string, string>();
  if (requirementIds.length) {
    for (const q of await db
      .select({ id: s.requirements.id, cycleId: s.requirements.programCycleId })
      .from(s.requirements)
      .where(inArray(s.requirements.id, requirementIds))) {
      requirementCycle.set(q.id, q.cycleId);
      cycleIds.add(q.cycleId);
    }
  }
  const cycles = cycleIds.size
    ? await db
        .select({ id: s.programCycles.id, programId: s.programCycles.programId, termLabel: s.programCycles.termLabel })
        .from(s.programCycles)
        .where(inArray(s.programCycles.id, [...cycleIds]))
    : [];
  for (const c of cycles) programIds.add(c.programId);
  const programs = programIds.size
    ? await db
        .select({ id: s.programs.id, name: s.programs.name, slug: s.programs.slug, isSample: s.programs.isSample, isWedge: s.programs.isWedge })
        .from(s.programs)
        .where(inArray(s.programs.id, [...programIds]))
    : [];
  const cycleById = new Map(cycles.map((c) => [c.id, c]));
  const programById = new Map(programs.map((p) => [p.id, p]));

  const out = new Map<string, { cycleId: string | null; programId: string | null; program: (typeof programs)[number] | null; termLabel: string | null }>();
  for (const r of rows) {
    let cycleId: string | null = null;
    let programId: string | null = null;
    if (r.subjectType === "program_cycle") cycleId = r.subjectId;
    else if (r.subjectType === "deadline") cycleId = deadlineCycle.get(r.subjectId) ?? null;
    else if (r.subjectType === "requirement") cycleId = requirementCycle.get(r.subjectId) ?? null;
    else if (r.subjectType === "program") programId = r.subjectId;
    const cycle = cycleId ? cycleById.get(cycleId) : undefined;
    if (cycle) programId = cycle.programId;
    out.set(r.id, {
      cycleId: cycle ? cycleId : null,
      programId,
      program: programId ? (programById.get(programId) ?? null) : null,
      termLabel: cycle?.termLabel ?? null,
    });
  }
  return out;
}

export async function taskContexts(db: Db, rows: readonly TaskRow[], now: number): Promise<Map<string, TaskContext & { wedge: boolean }>> {
  const links = await subjectLinks(db, rows);
  const handles = await registry.curatorHandles(db);
  const out = new Map<string, TaskContext & { wedge: boolean }>();
  for (const r of rows) {
    const link = links.get(r.id);
    const first = firstApproverOf(r);
    out.set(r.id, {
      programName: link?.program?.name ?? null,
      programSlug: link?.program?.slug ?? null,
      termLabel: link?.termLabel ?? null,
      isSample: link?.program?.isSample ?? false,
      severity: severityOf(r.kind),
      overdue: r.dueAt !== null && r.dueAt < now,
      secondReviewOf: first ? (handles.get(first) ?? null) : null,
      wedge: link?.program?.isWedge ?? false,
    });
  }
  return out;
}

// =============================================================================================
// State changes
// =============================================================================================

async function run(statements: readonly Stmt[], db: Db, lost: string): Promise<ActionResult> {
  try {
    await runBatch(db, statements);
    return { ok: true };
  } catch (err) {
    if (isAssertionFailure(err)) return conflict(lost);
    throw err;
  }
}

const NOT_HELD = "You no longer hold this task (the 15-minute claim expired or someone else took it).";

/** Claims under a 15-minute lease. The caller checked `claimable`; the batch re-checks the row. */
export async function claimTask(db: Db, row: TaskRow, who: CuratorIdentity, now: number): Promise<ActionResult> {
  const actor = actorFor(who.handle, who.isAdmin);
  return run(
    [
      assertTaskUnchanged(db, row.id, row.updatedAt),
      db
        .update(s.reviewTasks)
        .set({ state: "claimed", claimedBy: who.id, claimExpiresAt: now + CLAIM_LEASE_MS, updatedAt: now })
        .where(eq(s.reviewTasks.id, row.id)),
      taskAudit(db, { task: row, actor, action: "claim", before: { state: row.state }, after: { state: "claimed" }, now }),
    ],
    db,
    "Someone else changed this task first. Reload the queue.",
  );
}

/** Where a released task goes: back to second review when it has a first approval, else open. */
export function releaseState(row: Pick<TaskRow, "payload">): "open" | "second_review" {
  return firstApproverOf(row) ? "second_review" : "open";
}

export async function releaseTask(db: Db, row: TaskRow, who: CuratorIdentity, now: number, activeSeconds: number): Promise<ActionResult> {
  const to = releaseState(row);
  return run(
    [
      assertClaimHeld(db, row.id, who.id, now),
      db
        .update(s.reviewTasks)
        .set({ state: to, claimedBy: null, claimExpiresAt: null, activeSeconds: sql`${s.reviewTasks.activeSeconds} + ${activeSeconds}`, updatedAt: now })
        .where(eq(s.reviewTasks.id, row.id)),
      taskAudit(db, { task: row, actor: actorFor(who.handle, who.isAdmin), action: "release", before: { state: "claimed" }, after: { state: to }, now }),
    ],
    db,
    NOT_HELD,
  );
}

export async function rejectTask(
  db: Db,
  row: TaskRow,
  who: CuratorIdentity,
  input: { reason: RejectReason; note: string; activeSeconds: number },
  now: number,
): Promise<ActionResult> {
  const resolution = (input.note.trim() ? `${input.reason}: ${input.note.trim()}` : input.reason).slice(0, 500);
  return run(
    [
      assertClaimHeld(db, row.id, who.id, now),
      db
        .update(s.reviewTasks)
        .set({
          state: "rejected",
          resolution,
          resolvedAt: now,
          claimExpiresAt: null,
          payload: { ...row.payload, rejectReason: input.reason, resolvedBy: who.handle },
          activeSeconds: sql`${s.reviewTasks.activeSeconds} + ${input.activeSeconds}`,
          updatedAt: now,
        })
        .where(eq(s.reviewTasks.id, row.id)),
      taskAudit(db, { task: row, actor: actorFor(who.handle, who.isAdmin), action: "reject", before: { state: "claimed" }, after: { state: "rejected", reason: input.reason }, now }),
    ],
    db,
    NOT_HELD,
  );
}

export async function snoozeTask(
  db: Db,
  row: TaskRow,
  who: CuratorIdentity,
  input: { until: number; note: string; activeSeconds: number },
  now: number,
): Promise<ActionResult> {
  const untilIso = new Date(input.until).toISOString();
  return run(
    [
      assertClaimHeld(db, row.id, who.id, now),
      db
        .update(s.reviewTasks)
        .set({
          state: "snoozed",
          resolution: input.note.trim().slice(0, 500),
          claimedBy: null,
          claimExpiresAt: null,
          payload: { ...row.payload, snoozedUntil: untilIso, snoozedBy: who.handle },
          activeSeconds: sql`${s.reviewTasks.activeSeconds} + ${input.activeSeconds}`,
          updatedAt: now,
        })
        .where(eq(s.reviewTasks.id, row.id)),
      taskAudit(db, { task: row, actor: actorFor(who.handle, who.isAdmin), action: "snooze", before: { state: "claimed" }, after: { state: "snoozed", until: untilIso }, now }),
    ],
    db,
    NOT_HELD,
  );
}

export async function escalateTask(db: Db, row: TaskRow, who: CuratorIdentity, input: { note: string; activeSeconds: number }, now: number): Promise<ActionResult> {
  return run(
    [
      assertClaimHeld(db, row.id, who.id, now),
      db
        .update(s.reviewTasks)
        .set({
          state: "escalated",
          resolution: input.note.trim().slice(0, 500),
          claimedBy: null,
          claimExpiresAt: null,
          payload: { ...row.payload, escalatedBy: who.handle },
          activeSeconds: sql`${s.reviewTasks.activeSeconds} + ${input.activeSeconds}`,
          updatedAt: now,
        })
        .where(eq(s.reviewTasks.id, row.id)),
      taskAudit(db, { task: row, actor: actorFor(who.handle, who.isAdmin), action: "escalate", before: { state: "claimed" }, after: { state: "escalated" }, now }),
    ],
    db,
    NOT_HELD,
  );
}

/** Logs that the Curator opened the live official page (plan 4.10: required before changing a deadline, status or URL). */
export async function recordOfficialOpened(
  db: Db,
  row: TaskRow,
  who: CuratorIdentity,
  input: { snapshotId: string | null; page: number | null },
  now: number,
): Promise<ActionResult> {
  const opened = { ...((row.payload.officialOpened as Record<string, unknown> | undefined) ?? {}), [who.id]: new Date(now).toISOString() };
  return run(
    [
      assertClaimHeld(db, row.id, who.id, now),
      db
        .update(s.reviewTasks)
        .set({ payload: { ...row.payload, officialOpened: opened }, updatedAt: now })
        .where(eq(s.reviewTasks.id, row.id)),
      taskAudit(db, {
        task: row,
        actor: actorFor(who.handle, who.isAdmin),
        action: "official_link_opened",
        before: null,
        after: { snapshotId: input.snapshotId, page: input.page },
        now,
        snapshotIds: input.snapshotId ? [input.snapshotId] : [],
      }),
    ],
    db,
    NOT_HELD,
  );
}

/** When this Curator opened the official link for this task, as epoch ms, or null. */
export function officialOpenedAt(row: Pick<TaskRow, "payload">, curatorId: string): number | null {
  const map = row.payload.officialOpened;
  if (!map || typeof map !== "object") return null;
  const v = (map as Record<string, unknown>)[curatorId];
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * Requests a fresh fetch of the program's approved Sources (one job per Source, priority 1 when
 * urgent), then records the request on the task. Jobs carry ids and the public Source URL only.
 */
export async function requestRecheck(
  db: Db,
  row: TaskRow,
  who: CuratorIdentity,
  input: { programId: string | null; cycleId: string | null; urgent: boolean; note: string },
  now: number,
): Promise<ActionResult & { jobs?: number }> {
  if (!input.programId) return conflict("This task has no program to re-check.");
  const sources = await db
    .select({ id: s.sources.id, url: s.sources.url, host: s.sources.host, kind: s.sources.kind, approval: s.sources.approval })
    .from(s.sources)
    .where(and(eq(s.sources.programId, input.programId), eq(s.sources.approval, "approved")));
  if (sources.length === 0) return conflict("This program has no approved Source to fetch.");
  // Hold the claim check before enqueueing, so a Curator who lost the task cannot add jobs.
  const held = await run([assertClaimHeld(db, row.id, who.id, now)], db, NOT_HELD);
  if (!held.ok) return held;
  const slot = Math.floor(now / 600_000);
  let created = 0;
  for (const src of sources) {
    const res = await jobsRepo.enqueueJob(
      db,
      {
        kind: "fetch",
        idempotencyKey: `recheck:${src.id}:${slot}`,
        concurrencyKey: `host:${src.host}`,
        priority: input.urgent ? 1 : 3,
        payload: { sourceId: src.id, url: src.url, kind: src.kind, approval: src.approval, programCycleId: input.cycleId, recheckTaskId: row.id },
      },
      now,
    );
    if (res.created) created++;
  }
  const recheck = { at: new Date(now).toISOString(), by: who.handle, urgent: input.urgent, sources: sources.length, note: input.note.slice(0, 300) };
  const done = await run(
    [
      assertClaimHeld(db, row.id, who.id, now),
      db
        .update(s.reviewTasks)
        .set({ payload: { ...row.payload, recheck }, updatedAt: now })
        .where(eq(s.reviewTasks.id, row.id)),
      taskAudit(db, { task: row, actor: actorFor(who.handle, who.isAdmin), action: "recheck", before: null, after: { urgent: input.urgent, sources: sources.length }, now }),
    ],
    db,
    NOT_HELD,
  );
  return done.ok ? { ok: true, jobs: created } : done;
}

export { snoozedUntil };
