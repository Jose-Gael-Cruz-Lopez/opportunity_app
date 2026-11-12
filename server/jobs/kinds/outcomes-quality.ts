import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { release } from "@shared/disclosure";
import { assessCycleQuality, type CycleQualityResult, type OutcomePrivateConfig, type QualityReportRow } from "@shared/readiness/outcomes";
import { OVER_COUNT_REASON, readCycleFacts, readPrivateConfig } from "@server/api/v1/outcomes/d1";
import { seasonStartMs } from "@server/api/v1/outcomes/routes";
import type { Db } from "@server/db/client";
import { uuidv7 } from "@server/db/columns";
import { holdCycle } from "@server/db/repos/bands";
import { mergeTask } from "@server/db/repos/review";
import * as s from "@server/db/schema";
import { LIVE_REVIEW_STATES } from "@server/db/schema";
import type { HandlerResult, JobContext } from "../types";

/**
 * `outcomes.quality` (plan 7.8, daily slot, before `aggregates.publish`). Per cycle with live
 * Outcome reports it:
 *
 * 1. re-runs the deterministic validators and writes `quality_state` / `flag_codes` (codes are
 *    only added; a Curator clears them on the outcome_anomaly task);
 * 2. holds the cycle's displayed aggregates when counted selections exceed the PRIVATE fraction
 *    of the official award count (an `outcome_anomaly` task with reason `outcome_over_count`;
 *    the summary route releases nothing for a held cycle until a Curator resolves it);
 * 3. opens or updates one `outcome_anomaly` task per cycle with flagged reports, carrying
 *    pseudonymous counts only (by flag code), never a report, feature, exact date or account;
 * 4. drafts an Outcome-derived decision week for a Curator (`cycle_update`, reason
 *    `outcome_decision_week`) once 10 distinct counted accounts report a decision in one week.
 *    The account count in the payload is a shared/disclosure label, never a raw number.
 *
 * Status-defined programs have no Outcome rows (trigger) and are skipped again here. The job
 * logs counts only.
 */

export const QUALITY_REASONS = {
  overCount: OVER_COUNT_REASON,
  flagged: "outcome_flagged",
  decisionWeek: "outcome_decision_week",
} as const;

/** D1 calls per cycle (judgment): facts, reports, stages, others, counts, writes. */
const CALLS_PER_CYCLE = 10;

/** Cycles with at least one live report, in a stable order. */
async function cyclesWithReports(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: s.outcomes.programCycleId })
    .from(s.outcomes)
    .where(isNull(s.outcomes.deletedAt))
    .orderBy(s.outcomes.programCycleId);
  return rows.map((r) => r.id);
}

/** Rotates the starting cycle by day, so a budget-limited run cannot starve the tail. */
export function rotateFrom<T>(items: readonly T[], slot: string | null): T[] {
  if (items.length === 0) return [];
  let h = 0;
  for (const ch of slot ?? "") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const start = h % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

async function loadReports(db: Db, programCycleId: string, roundDeadline: string | null, today: string): Promise<QualityReportRow[]> {
  const rows = await db
    .select({
      id: s.outcomes.id,
      userId: s.outcomes.userId,
      tier: s.outcomes.tier,
      qualityState: s.outcomes.qualityState,
      flagCodes: s.outcomes.flagCodes,
      decision: s.outcomes.decision,
      decidedOn: s.outcomes.decidedOn,
      classYear: s.outcomes.classYear,
    })
    .from(s.outcomes)
    .where(and(eq(s.outcomes.programCycleId, programCycleId), isNull(s.outcomes.deletedAt)));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const userIds = [...new Set(rows.map((r) => r.userId))];
  const [stages, others] = await db.batch([
    db.select({ outcomeId: s.outcomeStages.outcomeId, stage: s.outcomeStages.stage, onDate: s.outcomeStages.onDate }).from(s.outcomeStages).where(inArray(s.outcomeStages.outcomeId, ids)),
    db
      .select({ userId: s.outcomes.userId, n: sql<number>`count(*)` })
      .from(s.outcomes)
      .where(and(inArray(s.outcomes.userId, userIds), isNull(s.outcomes.deletedAt), gte(s.outcomes.createdAt, seasonStartMs(today)), sql`${s.outcomes.programCycleId} <> ${programCycleId}`))
      .groupBy(s.outcomes.userId),
  ]);
  return rows.map((r) => ({
    id: r.id,
    // In memory only, for distinct-account counts; never written or logged.
    accountKey: r.userId,
    tier: r.tier,
    qualityState: r.qualityState === "flagged" ? "flagged" : "ok",
    flagCodes: r.flagCodes ?? [],
    snapshotClassYear: r.classYear,
    roundDeadline,
    otherReportsThisSeason: Number(others.find((o) => o.userId === r.userId)?.n ?? 0),
    stages: stages.filter((st) => st.outcomeId === r.id).map((st) => ({ stage: st.stage as QualityReportRow["stages"][number]["stage"], on: st.onDate })),
    decision: r.decision as QualityReportRow["decision"],
    decidedOn: r.decidedOn,
  }));
}

async function officialAwards(db: Db, programCycleId: string): Promise<number | null> {
  const [row] = await db
    .select({ count: s.programCycleCounts.count })
    .from(s.programCycleCounts)
    .where(and(eq(s.programCycleCounts.programCycleId, programCycleId), eq(s.programCycleCounts.stage, "awards"), eq(s.programCycleCounts.provenance, "official_publication")))
    .limit(1);
  return row ? row.count : null;
}

/**
 * Upserts the one live task per `{kind}:program_cycle:{id}` (the review_tasks_live_uq key),
 * merging reasons like server/db/repos/review.ts. Written directly because the outcome reason
 * codes are not in shared/contracts' REVIEW_REASON_CODES yet (listed for the contracts owner).
 */
export async function upsertCycleTask(
  db: Db,
  input: { kind: "outcome_anomaly" | "cycle_update"; programCycleId: string; reason: string; priority: number; payload: Record<string, unknown> },
  now: number,
): Promise<string> {
  const dedupeKey = `${input.kind}:program_cycle:${input.programCycleId}`;
  const existing = await db.query.reviewTasks.findFirst({ where: and(eq(s.reviewTasks.dedupeKey, dedupeKey), inArray(s.reviewTasks.state, [...LIVE_REVIEW_STATES])) });
  if (existing) {
    const merged = mergeTask(existing, { reasonCodes: [input.reason], evidence: [], priority: input.priority, dueAt: null });
    await db
      .update(s.reviewTasks)
      .set({ ...merged, payload: { ...existing.payload, ...input.payload }, updatedAt: now })
      .where(eq(s.reviewTasks.id, existing.id));
    return existing.id;
  }
  const id = uuidv7(now);
  await db.insert(s.reviewTasks).values({
    id,
    kind: input.kind,
    subjectType: "program_cycle",
    subjectId: input.programCycleId,
    dedupeKey,
    reasonCodes: [input.reason],
    evidenceIds: [],
    priority: input.priority,
    payload: input.payload,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** A count as the public would see it ("10-19", "25"): payloads never carry raw small counts. */
export function bandedCount(n: number, period: string): string {
  const [t] = release([{ period, grain: "cycle", cycleKey: period, categories: {}, n }], { audience: "public", grain: "cycle", dims: [] });
  return t && !t.suppressed ? t.total : "fewer than 5";
}

export interface CycleQualityOutcome {
  readonly result: CycleQualityResult;
  readonly writes: number;
}

/** Applies one cycle's checks. Exported for tests. */
export async function processCycle(db: Db, programCycleId: string, today: string, privateConfig: OutcomePrivateConfig, now: number): Promise<CycleQualityOutcome | null> {
  const facts = await readCycleFacts(db, programCycleId);
  if (!facts || facts.sensitiveAudience) return null;
  const reports = await loadReports(db, programCycleId, facts.earliestRoundDeadline, today);
  if (reports.length === 0) return null;
  const result = assessCycleQuality({
    today,
    cycle: { decisionWindowStart: facts.decisionWindowStart, decisionWindowEnd: facts.decisionWindowEnd, rollingDecisions: facts.rollingDecisions, classYears: facts.classYears },
    nominationRequired: facts.nominationRequired,
    reports,
    officialAwards: await officialAwards(db, programCycleId),
    privateConfig,
  });

  let writes = 0;
  for (const u of result.flagUpdates) {
    await db.update(s.outcomes).set({ qualityState: "flagged", flagCodes: [...u.flagCodes], updatedAt: now }).where(eq(s.outcomes.id, u.id));
    writes++;
  }
  const byFlag = Object.fromEntries(Object.entries(result.counts.byFlag).map(([code, n]) => [code, bandedCount(n, facts.cycleKey)]));
  if (result.hold) {
    const reviewTaskId = await upsertCycleTask(db, { kind: "outcome_anomaly", programCycleId, reason: QUALITY_REASONS.overCount, priority: 1, payload: { hold: { reason: "over_count", frozenOn: today }, byFlag } }, now);
    // The hold row (outcome_cycle_holds) freezes the cycle's counts until a Curator resolves the task.
    await holdCycle(db, { programCycleId, reason: "over_count", reviewTaskId }, now);
    writes += 2;
  }
  if (result.flagUpdates.length > 0) {
    await upsertCycleTask(db, { kind: "outcome_anomaly", programCycleId, reason: QUALITY_REASONS.flagged, priority: 4, payload: { byFlag, checkedOn: today } }, now);
    writes++;
  }
  if (result.historyDraft) {
    await upsertCycleTask(
      db,
      {
        kind: "cycle_update",
        programCycleId,
        reason: QUALITY_REASONS.decisionWeek,
        priority: 6,
        // Week precision only; the account count is a disclosure label.
        payload: { decisionWeekDraft: { weekStart: result.historyDraft.weekStart, precision: "week", observation: "reported", accounts: bandedCount(result.historyDraft.accounts, facts.cycleKey) } },
      },
      now,
    );
    writes++;
  }
  return { result, writes };
}

export async function outcomesQuality(ctx: JobContext): Promise<HandlerResult> {
  if (!ctx.budget.allows(3)) return { processed: 0, outcome: "partial" };
  const now = ctx.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const [cycles, privateConfig] = await Promise.all([cyclesWithReports(ctx.db), readPrivateConfig(ctx.db)]);
  ctx.budget.spend(2);
  let processed = 0;
  let holds = 0;
  let flagged = 0;
  for (const id of rotateFrom(cycles, ctx.slot)) {
    if (!ctx.budget.allows(CALLS_PER_CYCLE)) {
      ctx.log("warn", "outcomes.quality_partial", { processed, remaining: cycles.length - processed });
      return { processed, outcome: "partial", detail: { holds, flagged } };
    }
    const out = await processCycle(ctx.db, id, today, privateConfig, now);
    ctx.budget.spend(CALLS_PER_CYCLE);
    processed++;
    if (out?.result.hold) holds++;
    flagged += out?.result.flagUpdates.length ?? 0;
  }
  // Counts only: no cycle, program or account is named in the log.
  ctx.log("info", "outcomes.quality_done", { cycles: processed, holds, newlyFlagged: flagged });
  return { processed, outcome: "ok", detail: { holds, flagged } };
}
