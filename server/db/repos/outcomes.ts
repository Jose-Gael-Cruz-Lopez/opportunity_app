import { and, eq, isNull, sql } from "drizzle-orm";
import {
  OutcomeReportCreateSchema,
  OutcomeReportUpdateSchema,
  type OutcomeReport,
  type OutcomeReportCreate,
  type OutcomeReportUpdate,
} from "../../../shared/contracts/advisor";
import type { StudentProfile } from "../../../shared/contracts/student";
import type { Db } from "../client";
import * as s from "../schema";
import { uuidv7 } from "../columns";
import { iso } from "../util";
import { classifyWriteError, fail, ok, runBatch, type RepoResult, type Stmt } from "./common";

/**
 * Self-reported outcomes. A student reads and edits only their own report (by public id); every
 * other read is an aggregate in which any cell below `MIN_CELL` (5) is suppressed, plus a second
 * cell when one suppressed cell could be recovered from the total. Sensitive-audience programs
 * get no outcome rows at all (trigger), and flagged reports are left out of aggregates.
 */

export const MIN_CELL = 5;

type OutcomeRow = typeof s.outcomes.$inferSelect;

export function toOutcomeReport(row: OutcomeRow, stages: readonly { stage: string; onDate: string | null }[]): OutcomeReport {
  return {
    publicId: row.publicId,
    programCycleId: row.programCycleId,
    tier: row.tier as OutcomeReport["tier"],
    stages: stages.map((st) => ({ stage: st.stage as OutcomeReport["stages"][number]["stage"], on: st.onDate })),
    decision: row.decision as OutcomeReport["decision"],
    decidedOn: row.decidedOn,
    snapshot: {
      classYear: row.classYear as OutcomeReport["snapshot"]["classYear"],
      gpaBand: row.gpaBand as OutcomeReport["snapshot"]["gpaBand"],
      majorFamily: row.majorFamily as OutcomeReport["snapshot"]["majorFamily"],
      institutionType: row.institutionType as OutcomeReport["snapshot"]["institutionType"],
      priorFeeder: row.priorFeeder as OutcomeReport["snapshot"]["priorFeeder"],
    },
    qualityState: row.qualityState as OutcomeReport["qualityState"],
    createdAt: iso(row.createdAt),
  };
}

async function stagesFor(db: Db, outcomeId: string) {
  return db.select({ stage: s.outcomeStages.stage, onDate: s.outcomeStages.onDate }).from(s.outcomeStages).where(eq(s.outcomeStages.outcomeId, outcomeId));
}

/** Snapshot of non-sensitive context at report time (no first-generation or other status answer). */
export function outcomeSnapshot(profile: StudentProfile | null) {
  return {
    classYear: profile?.classYear ?? null,
    gpaBand: profile?.gpaBand && profile.gpaBand !== "prefer_not" ? profile.gpaBand : null,
    majorFamily: profile?.majorFamily ?? null,
    institutionType: profile?.institutionLevel ?? null,
  };
}

export async function createOutcome(
  db: Db,
  userId: string,
  input: OutcomeReportCreate,
  profile: StudentProfile | null,
  now: number,
): Promise<RepoResult<OutcomeReport>> {
  const parsed = OutcomeReportCreateSchema.safeParse(input);
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => i.message).join("; "));
  const data = parsed.data;
  const id = uuidv7(now);
  const stmts: Stmt[] = [
    db.insert(s.outcomes).values({
      id,
      userId,
      programCycleId: data.programCycleId,
      decision: data.decision,
      decidedOn: data.decidedOn,
      ...outcomeSnapshot(profile),
      priorFeeder: data.priorFeeder,
      createdAt: now,
      updatedAt: now,
    }),
  ];
  if (data.stages.length) stmts.push(db.insert(s.outcomeStages).values(data.stages.map((st) => ({ outcomeId: id, stage: st.stage, onDate: st.on, createdAt: now }))));
  try {
    await runBatch(db, stmts);
  } catch (err) {
    return classifyWriteError(err);
  }
  return getOwnOutcomeById(db, userId, id);
}

async function getOwnOutcomeById(db: Db, userId: string, id: string): Promise<RepoResult<OutcomeReport>> {
  const row = await db.query.outcomes.findFirst({ where: and(eq(s.outcomes.id, id), eq(s.outcomes.userId, userId), isNull(s.outcomes.deletedAt)) });
  if (!row) return fail("not_found");
  return ok(toOutcomeReport(row, await stagesFor(db, row.id)));
}

export async function listOwnOutcomes(db: Db, userId: string): Promise<OutcomeReport[]> {
  const rows = await db.select().from(s.outcomes).where(and(eq(s.outcomes.userId, userId), isNull(s.outcomes.deletedAt)));
  return Promise.all(rows.map(async (r) => toOutcomeReport(r, await stagesFor(db, r.id))));
}

export async function getOwnOutcome(db: Db, userId: string, publicId: string): Promise<OutcomeReport | null> {
  const row = await db.query.outcomes.findFirst({ where: and(eq(s.outcomes.publicId, publicId), eq(s.outcomes.userId, userId), isNull(s.outcomes.deletedAt)) });
  return row ? toOutcomeReport(row, await stagesFor(db, row.id)) : null;
}

export async function updateOwnOutcome(db: Db, userId: string, publicId: string, update: OutcomeReportUpdate, now: number): Promise<RepoResult<OutcomeReport>> {
  const parsed = OutcomeReportUpdateSchema.safeParse(update);
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => i.message).join("; "));
  const row = await db.query.outcomes.findFirst({ where: and(eq(s.outcomes.publicId, publicId), eq(s.outcomes.userId, userId), isNull(s.outcomes.deletedAt)) });
  if (!row) return fail("not_found");
  const data = parsed.data;
  const set: Partial<typeof s.outcomes.$inferInsert> = { updatedAt: now };
  if (data.decision !== undefined) set.decision = data.decision;
  if (data.decidedOn !== undefined) set.decidedOn = data.decidedOn;
  if (data.priorFeeder !== undefined) set.priorFeeder = data.priorFeeder;
  const stmts: Stmt[] = [db.update(s.outcomes).set({ ...set, version: sql`${s.outcomes.version} + 1` }).where(eq(s.outcomes.id, row.id))];
  if (data.stages !== undefined) {
    stmts.push(db.delete(s.outcomeStages).where(eq(s.outcomeStages.outcomeId, row.id)));
    if (data.stages.length) stmts.push(db.insert(s.outcomeStages).values(data.stages.map((st) => ({ outcomeId: row.id, stage: st.stage, onDate: st.on, createdAt: now }))));
  }
  await runBatch(db, stmts);
  return getOwnOutcomeById(db, userId, row.id);
}

/** Hard delete (the deletion ledger records it so a restore cannot bring it back). */
export async function deleteOwnOutcome(db: Db, userId: string, publicId: string): Promise<boolean> {
  const row = await db.query.outcomes.findFirst({ where: and(eq(s.outcomes.publicId, publicId), eq(s.outcomes.userId, userId)) });
  if (!row) return false;
  await runBatch(db, [db.delete(s.outcomeStages).where(eq(s.outcomeStages.outcomeId, row.id)), db.delete(s.outcomes).where(eq(s.outcomes.id, row.id))]);
  return true;
}

// =============================================================================================
// Aggregates
// =============================================================================================

export interface Cell<K extends string> {
  key: K;
  /** Null when suppressed. */
  n: number | null;
}

/**
 * Small-cell suppression: cells under `min` become null; if exactly one cell is suppressed while
 * the total is shown, the next-smallest cell is suppressed too, so the hidden value cannot be
 * recovered by subtraction.
 */
export function suppressCells<K extends string>(counts: ReadonlyMap<K, number>, min: number = MIN_CELL): { total: number | null; cells: Cell<K>[] } {
  const entries = [...counts.entries()].filter(([, n]) => n > 0);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (total < min) return { total: null, cells: entries.map(([key]) => ({ key, n: null })) };
  const hidden = new Set(entries.filter(([, n]) => n < min).map(([k]) => k));
  if (hidden.size === 1) {
    const next = entries.filter(([k]) => !hidden.has(k)).sort((a, b) => a[1] - b[1])[0];
    if (next) hidden.add(next[0]);
  }
  return { total, cells: entries.map(([key, n]) => ({ key, n: hidden.has(key) ? null : n })) };
}

export interface OutcomeAggregate {
  programCycleId: string;
  reports: number | null;
  decisions: Cell<string>[];
  stages: Cell<string>[];
  minCell: number;
}

/**
 * Aggregate outcomes for one cycle. The SQL already returns nothing for a cycle with fewer
 * than `min` usable reports; `suppressCells` then handles small cells.
 */
export async function outcomeAggregate(db: Db, programCycleId: string, min: number = MIN_CELL): Promise<OutcomeAggregate> {
  const usable = and(
    eq(s.outcomes.programCycleId, programCycleId),
    isNull(s.outcomes.deletedAt),
    eq(s.outcomes.qualityState, "ok"),
    sql`NOT EXISTS (SELECT 1 FROM program_cycles c JOIN programs p ON p.id = c.program_id WHERE c.id = outcomes.program_cycle_id AND p.sensitive_audience = 1)`,
  );
  const totalRows = await db.select({ n: sql<number>`count(*)` }).from(s.outcomes).where(usable);
  const total = Number(totalRows[0]?.n ?? 0);
  if (total < min) return { programCycleId, reports: null, decisions: [], stages: [], minCell: min };
  const [decisions, stages] = await db.batch([
    db
      .select({ key: sql<string>`coalesce(${s.outcomes.decision}, 'undecided')`, n: sql<number>`count(*)` })
      .from(s.outcomes)
      .where(usable)
      .groupBy(sql`coalesce(${s.outcomes.decision}, 'undecided')`),
    db
      .select({ key: s.outcomeStages.stage, n: sql<number>`count(*)` })
      .from(s.outcomeStages)
      .innerJoin(s.outcomes, eq(s.outcomes.id, s.outcomeStages.outcomeId))
      .where(usable)
      .groupBy(s.outcomeStages.stage),
  ]);
  const decisionCells = suppressCells(new Map(decisions.map((d) => [d.key, Number(d.n)])), min);
  // Stage cells are not a partition of the total (a report can list several stages), so only
  // primary suppression applies.
  const stageCells = stages.map((st) => ({ key: st.key, n: Number(st.n) >= min ? Number(st.n) : null }));
  return { programCycleId, reports: total, decisions: decisionCells.cells, stages: stageCells, minCell: min };
}

export async function flagOutcome(db: Db, outcomeId: string, codes: readonly string[], now: number): Promise<void> {
  await db.update(s.outcomes).set({ qualityState: "flagged", flagCodes: [...codes], updatedAt: now }).where(eq(s.outcomes.id, outcomeId));
}
