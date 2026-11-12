import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { BandModelSchema, type BandModel } from "../../../shared/readiness/bands";
import { bandModelKey, splitModelByProgram, type ProgramBandRow } from "../../../shared/readiness/bands-store";
import { COUNTED_TIER_CODES } from "../../../shared/readiness/outcomes";
import { sha256Hex } from "../../lib/crypto";
import type { Db } from "../client";
import { uuidv7 } from "../columns";
import * as s from "../schema";
import { LIVE_REVIEW_STATES, OUTCOME_HOLD_REASONS } from "../schema";
import { rowsPerInsert, chunked } from "../util";
import { jsonIds, runBatch, type Stmt } from "./common";

/**
 * Band models and Outcome cycle holds (plan 7.5.5, 7.9.1).
 *
 * - `band_models`: `bands.fit` output stored per program. A refit supersedes every live row of
 *   its model key in the same batch, so a program the new fit no longer covers loses its band.
 *   Rows hold coefficients, pooled cell counts and one program's centre and counts; never an
 *   Outcome row, account or report date.
 * - `outcome_cycle_holds`: at most one live hold per cycle and reason. Until `outcomes.quality`
 *   writes this table, a live `outcome_anomaly` task carrying `outcome_over_count` also holds the
 *   cycle (the rule server/api/v1/outcomes/d1.ts applies), so both are read here.
 * - Read-time facts for readiness: live rows, live approvals, held cycles and the counted report
 *   total. Gates are decided by shared/readiness/bands-store, not here.
 * - A founder approval names one model card, not a key: `payload.modelKey` and
 *   `payload.modelFingerprint` (`bandModelFingerprint`, a hash of the pooled fit). A refit that
 *   changes the coefficients, the cells or the training cycles needs a new approval; a monthly
 *   refit on unchanged data keeps its fingerprint and its approval.
 */

/** The reason outcomes.quality writes on its over-count task (server/api/v1/outcomes/d1.ts OVER_COUNT_REASON). */
export const LEGACY_OVER_COUNT_REASON = "outcome_over_count";

export type OutcomeHoldReason = (typeof OUTCOME_HOLD_REASONS)[number];

type BandRow = typeof s.bandModels.$inferSelect;

/** A stored row as readiness reads it; `model` is null when the JSON no longer parses. */
export type StoredProgramBand = ProgramBandRow<BandModel | null>;

export interface StoreBandModelInput {
  /** `{type}.{from}-{to}`; must match the model's own type and stages. */
  readonly key: string;
  /** UTC day of the fit. */
  readonly fittedOn: string;
  readonly algo: string;
  readonly model: BandModel;
}

const BAND_COLUMNS = 22;

/**
 * Stores one fitted model as one row per covered program, superseding the key's live rows in the
 * same batch. Programs that no longer exist are skipped. Returns the number of rows written.
 */
export async function storeProgramBandModels(db: Db, input: StoreBandModelInput, now: number): Promise<{ stored: number }> {
  const model = BandModelSchema.parse(input.model);
  const key = bandModelKey(model.opportunityType, model.fromStage, model.toStage);
  if (key !== input.key) throw new Error("band model key does not match the model's type and stages");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.fittedOn)) throw new Error("fittedOn must be YYYY-MM-DD");

  const ids = model.programs.map((p) => p.programId);
  const existing = ids.length
    ? await db.select({ id: s.programs.id }).from(s.programs).where(sql`${s.programs.id} IN ${jsonIds(ids)}`)
    : [];
  const known = new Set(existing.map((r) => r.id));
  const rows = splitModelByProgram(model, { fittedOn: input.fittedOn, algo: input.algo }).filter((r) => known.has(r.programId));

  const statements: Stmt[] = [
    db.update(s.bandModels).set({ supersededAt: now }).where(and(eq(s.bandModels.modelKey, key), isNull(s.bandModels.supersededAt))),
  ];
  const values = rows.map((r) => ({
    id: uuidv7(now),
    modelKey: r.modelKey,
    programId: r.programId,
    opportunityType: r.opportunityType,
    fromStage: r.fromStage,
    toStage: r.toStage,
    modelVersion: r.modelVersion,
    algo: r.algo,
    fittedOn: r.fittedOn,
    gatePooled: r.gates.pooled,
    gateHeldOut: r.gates.heldOut,
    gateRepresentativeness: r.gates.representativeness,
    gateFairness: r.gates.fairness,
    gateUsefulness: r.gates.usefulness,
    gateApproved: r.gates.approved,
    programEligible: r.programEligible,
    nEff: r.nEff,
    passReports: r.passReports,
    failReports: r.failReports,
    model: r.model as unknown as Record<string, unknown>,
    createdAt: now,
  }));
  for (const chunk of chunked(values, rowsPerInsert(BAND_COLUMNS))) statements.push(db.insert(s.bandModels).values(chunk));
  await runBatch(db, statements);
  return { stored: rows.length };
}

function toStored(row: BandRow): StoredProgramBand {
  const parsed = BandModelSchema.safeParse(row.model);
  return {
    modelKey: row.modelKey,
    programId: row.programId,
    opportunityType: row.opportunityType,
    fromStage: row.fromStage,
    toStage: row.toStage,
    modelVersion: row.modelVersion,
    algo: row.algo,
    fittedOn: row.fittedOn,
    gates: {
      pooled: row.gatePooled,
      heldOut: row.gateHeldOut as StoredProgramBand["gates"]["heldOut"],
      representativeness: row.gateRepresentativeness,
      fairness: row.gateFairness,
      usefulness: row.gateUsefulness,
      approved: row.gateApproved,
    },
    programEligible: row.programEligible,
    nEff: row.nEff,
    passReports: row.passReports,
    failReports: row.failReports,
    model: parsed.success ? parsed.data : null,
  };
}

/** Live (not superseded) rows for one program, in model-key order. */
export async function currentProgramBands(db: Db, programId: string): Promise<StoredProgramBand[]> {
  const rows = await db
    .select()
    .from(s.bandModels)
    .where(and(eq(s.bandModels.programId, programId), isNull(s.bandModels.supersededAt)))
    .orderBy(asc(s.bandModels.modelKey));
  return rows.map(toStored);
}

/** Supersedes every live row of a model key (a retired model); returns the rows changed. */
export async function retireBandModel(db: Db, modelKey: string, now: number): Promise<number> {
  const changed = await db
    .update(s.bandModels)
    .set({ supersededAt: now })
    .where(and(eq(s.bandModels.modelKey, modelKey), isNull(s.bandModels.supersededAt)))
    .returning({ id: s.bandModels.id });
  return changed.length;
}

/** Rounds away float noise from summation order, so the same data gives the same fingerprint. */
function stable(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toPrecision(10)) : String(value);
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

type FingerprintedModel = Pick<BandModel, "opportunityType" | "fromStage" | "toStage" | "cycles" | "specs" | "beta" | "cellReports">;

/**
 * The model card a founder approves, as 32 hex characters: a SHA-256 of the pooled fit (type,
 * stages, training cycles, feature specs, coefficients, cell counts). Program slices of one fit
 * share it; gate flags, the version label and the fit date are not part of it.
 */
export async function bandModelFingerprint(model: FingerprintedModel): Promise<string> {
  const card = stable({
    type: model.opportunityType,
    from: model.fromStage,
    to: model.toStage,
    cycles: [...model.cycles].sort((a, b) => a - b),
    specs: model.specs,
    beta: model.beta,
    cells: model.cellReports,
  });
  return (await sha256Hex(JSON.stringify(card))).slice(0, 32);
}

/** Live founder approvals: (modelKey, modelFingerprint) pairs from approved or applied tasks. */
export async function liveBandApprovals(db: Db): Promise<{ modelKey: string; modelFingerprint: string }[]> {
  const rows = await db
    .select({ payload: s.reviewTasks.payload })
    .from(s.reviewTasks)
    .where(and(eq(s.reviewTasks.kind, "band_model_approval"), inArray(s.reviewTasks.state, ["approved", "applied"])));
  const out: { modelKey: string; modelFingerprint: string }[] = [];
  for (const r of rows) {
    const p = (r.payload ?? {}) as { modelKey?: unknown; modelFingerprint?: unknown };
    // An approval without a fingerprint names no model card, so it approves nothing.
    if (typeof p.modelKey === "string" && typeof p.modelFingerprint === "string") out.push({ modelKey: p.modelKey, modelFingerprint: p.modelFingerprint });
  }
  return out;
}

/**
 * Model keys with a founder approval in force now for the model each row actually holds: a
 * band_model_approval task in `approved` or `applied` whose `payload.modelKey` and
 * `payload.modelFingerprint` match the row. Read at request time, so a revoked approval turns
 * bands off without waiting for the next fit, and a refit with new coefficients is unapproved
 * until a founder reviews its card.
 */
export async function approvedBandModelKeys(db: Db, rows: readonly { readonly modelKey: string; readonly model: FingerprintedModel | null }[]): Promise<string[]> {
  if (rows.length === 0) return [];
  const approvals = await liveBandApprovals(db);
  const out = new Set<string>();
  for (const row of rows) {
    if (!row.model) continue;
    const fingerprint = await bandModelFingerprint(row.model);
    if (approvals.some((a) => a.modelKey === row.modelKey && a.modelFingerprint === fingerprint)) out.add(row.modelKey);
  }
  return [...out].sort();
}

/** Model keys with at least one live (not superseded) row. */
export async function liveBandModelKeys(db: Db): Promise<string[]> {
  const rows = await db.selectDistinct({ key: s.bandModels.modelKey }).from(s.bandModels).where(isNull(s.bandModels.supersededAt));
  return rows.map((r) => r.key).sort();
}

/** The program's current opportunity type slugs. */
export async function programOpportunityTypes(db: Db, programId: string): Promise<string[]> {
  const rows = await db.select({ slug: s.programTypes.typeSlug }).from(s.programTypes).where(eq(s.programTypes.programId, programId));
  return rows.map((r) => r.slug).sort();
}

// ---------------------------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------------------------

export interface HoldInput {
  readonly programCycleId: string;
  readonly reason: OutcomeHoldReason;
  readonly reviewTaskId?: string | null;
}

/** Opens a hold unless one is already live for the cycle and reason (idempotent). */
export async function holdCycle(db: Db, input: HoldInput, now: number): Promise<{ id: string; created: boolean }> {
  const live = await db.query.outcomeCycleHolds.findFirst({
    where: and(eq(s.outcomeCycleHolds.programCycleId, input.programCycleId), eq(s.outcomeCycleHolds.reason, input.reason), isNull(s.outcomeCycleHolds.releasedAt)),
  });
  if (live) return { id: live.id, created: false };
  const id = uuidv7(now);
  const inserted = await db
    .insert(s.outcomeCycleHolds)
    .values({ id, programCycleId: input.programCycleId, reason: input.reason, reviewTaskId: input.reviewTaskId ?? null, frozenAt: now, createdAt: now })
    .onConflictDoNothing()
    .returning({ id: s.outcomeCycleHolds.id });
  if (inserted.length > 0) return { id, created: true };
  // A concurrent writer opened it between the read and the insert.
  const again = await db.query.outcomeCycleHolds.findFirst({
    where: and(eq(s.outcomeCycleHolds.programCycleId, input.programCycleId), eq(s.outcomeCycleHolds.reason, input.reason), isNull(s.outcomeCycleHolds.releasedAt)),
  });
  return { id: again?.id ?? id, created: false };
}

/** Releases the cycle's live holds (one reason, or all); returns how many were released. */
export async function releaseCycleHolds(db: Db, programCycleId: string, now: number, reason?: OutcomeHoldReason): Promise<number> {
  const where = and(
    eq(s.outcomeCycleHolds.programCycleId, programCycleId),
    isNull(s.outcomeCycleHolds.releasedAt),
    reason ? eq(s.outcomeCycleHolds.reason, reason) : undefined,
  );
  // Never before the freeze (the order check), even with a skewed clock.
  const changed = await db
    .update(s.outcomeCycleHolds)
    .set({ releasedAt: sql`max(${now}, ${s.outcomeCycleHolds.frozenAt})` })
    .where(where)
    .returning({ id: s.outcomeCycleHolds.id });
  return changed.length;
}

/** Live holds on these cycles (table only). */
export async function liveCycleHolds(db: Db, programCycleIds: readonly string[]): Promise<{ id: string; programCycleId: string; reason: string; frozenAt: number }[]> {
  if (programCycleIds.length === 0) return [];
  return db
    .select({ id: s.outcomeCycleHolds.id, programCycleId: s.outcomeCycleHolds.programCycleId, reason: s.outcomeCycleHolds.reason, frozenAt: s.outcomeCycleHolds.frozenAt })
    .from(s.outcomeCycleHolds)
    .where(and(sql`${s.outcomeCycleHolds.programCycleId} IN ${jsonIds(programCycleIds)}`, isNull(s.outcomeCycleHolds.releasedAt)))
    .orderBy(asc(s.outcomeCycleHolds.programCycleId), asc(s.outcomeCycleHolds.reason));
}

/** Cycles among these held by a live over-count outcome_anomaly task (the interim rule). */
async function legacyHeldCycleIds(db: Db, programCycleIds: readonly string[]): Promise<string[]> {
  if (programCycleIds.length === 0) return [];
  const rows = await db
    .select({ subjectId: s.reviewTasks.subjectId, reasons: s.reviewTasks.reasonCodes })
    .from(s.reviewTasks)
    .where(
      and(
        eq(s.reviewTasks.kind, "outcome_anomaly"),
        eq(s.reviewTasks.subjectType, "program_cycle"),
        sql`${s.reviewTasks.subjectId} IN ${jsonIds(programCycleIds)}`,
        inArray(s.reviewTasks.state, [...LIVE_REVIEW_STATES]),
      ),
    );
  return rows.filter((r) => (r.reasons ?? []).includes(LEGACY_OVER_COUNT_REASON)).map((r) => r.subjectId);
}

/** Held cycles among these: a live hold row, or a live over-count task. Sorted, distinct. */
export async function heldCycleIds(db: Db, programCycleIds: readonly string[]): Promise<string[]> {
  const [table, legacy] = await Promise.all([liveCycleHolds(db, programCycleIds), legacyHeldCycleIds(db, programCycleIds)]);
  return [...new Set([...table.map((h) => h.programCycleId), ...legacy])].sort();
}

export async function cycleHeld(db: Db, programCycleId: string): Promise<boolean> {
  return (await heldCycleIds(db, [programCycleId])).length > 0;
}

/** Every held cycle of one program. */
export async function heldCycleIdsForProgram(db: Db, programId: string): Promise<string[]> {
  const cycles = await db.select({ id: s.programCycles.id }).from(s.programCycles).where(eq(s.programCycles.programId, programId));
  return heldCycleIds(db, cycles.map((c) => c.id));
}

// ---------------------------------------------------------------------------------------------
// Counted reports (the input to readiness's reportsBanded, released through shared/disclosure)
// ---------------------------------------------------------------------------------------------

/**
 * Counted (institution_email and up), unflagged, live Outcome reports for a program, created
 * before `beforeMs` (fixed daily windows) and outside the given held cycles. A count only; the
 * caller releases it through shared/disclosure before anything is shown.
 */
export async function countedProgramReports(db: Db, programId: string, beforeMs: number, excludeCycleIds: readonly string[] = []): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(s.outcomes)
    .innerJoin(s.programCycles, eq(s.programCycles.id, s.outcomes.programCycleId))
    .where(
      and(
        eq(s.programCycles.programId, programId),
        isNull(s.outcomes.deletedAt),
        eq(s.outcomes.qualityState, "ok"),
        inArray(s.outcomes.tier, [...COUNTED_TIER_CODES]),
        lt(s.outcomes.createdAt, beforeMs),
        excludeCycleIds.length > 0 ? sql`${s.outcomes.programCycleId} NOT IN ${jsonIds(excludeCycleIds)}` : undefined,
      ),
    );
  return Number(row?.n ?? 0);
}

/** Everything readiness needs to decide a band for one program, read in one place. */
export interface ProgramBandFacts {
  readonly rows: readonly StoredProgramBand[];
  readonly opportunityTypes: readonly string[];
  readonly approvedModelKeys: readonly string[];
  readonly heldCycleIds: readonly string[];
  /** Counted reports before today's UTC midnight, held cycles excluded. */
  readonly countedReports: number;
}

/** UTC midnight of the day containing `nowMs`. */
export function utcMidnight(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000) * 86_400_000;
}

export async function readProgramBandFacts(db: Db, programId: string, nowMs: number): Promise<ProgramBandFacts> {
  const [rows, opportunityTypes, held] = await Promise.all([
    currentProgramBands(db, programId),
    programOpportunityTypes(db, programId),
    heldCycleIdsForProgram(db, programId),
  ]);
  const [approved, countedReports] = await Promise.all([
    approvedBandModelKeys(db, rows),
    countedProgramReports(db, programId, utcMidnight(nowMs), held),
  ]);
  return { rows, opportunityTypes, approvedModelKeys: approved, heldCycleIds: held, countedReports };
}
