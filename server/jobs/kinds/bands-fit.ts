import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import {
  aggregateBandCells,
  BandModelSchema,
  bandProbability,
  fairnessGate,
  fitBandModel,
  heldOutGates,
  heldOutScoredItems,
  nonTypicalShare,
  READINESS_CONFIG,
  toBandModel,
  type BandFeatureSpec,
  type BandLevels,
  type BandModel,
  type GroupScored,
  type HeldOutGateReport,
} from "@shared/readiness";
import {
  allBandGatesPass,
  consecutiveTransitions,
  decisionWindowClosed,
  INSTITUTION_LEVEL_CODES,
  OUTCOMES_CONFIG,
  tierWeight,
  transitionResult,
  type BandGateFlags,
  type CountStageCode,
  type OutcomeFacts,
} from "@shared/readiness/outcomes";
import type { Db } from "@server/db/client";
import { bandModelFingerprint, heldCycleIds, liveBandApprovals, liveBandModelKeys, retireBandModel, storeProgramBandModels } from "@server/db/repos/bands";
import * as s from "@server/db/schema";
import type { HandlerResult, JobContext } from "../types";

/**
 * `bands.fit` (plan 7.5.5-7.5.6, Phase 4 machinery): refits personal-competitiveness band models
 * from cell aggregates of verified Outcome reports, evaluates every gate, and stores the model
 * PRIVATELY. Personal bands stay off until every gate passes:
 *
 *   pooled sample size (n_eff >= 250, shrinkage >= 0.9, Riley)   fitBandModel
 *   held-out skill and calibration on the latest completed cycle  heldOutGates
 *   representativeness against the official recipients' mix     representativenessGate (fails closed
 *                                                                 until recipient mixes are stored)
 *   fairness by institution type only (never SensitiveAnswers)    fairnessGate
 *   usefulness (>= 5% of held-out applicants non-typical)          nonTypicalShare
 *   founder approval after a shadow cycle                          band_model_approval task
 *
 * Until all pass, readiness and every page show the official base rate only. This job never sets
 * `approved` itself, never writes Outcome rows anywhere, and stores only cell aggregates and
 * coefficients (no report, account or date).
 *
 * Runs monthly from the daily slot (idempotency `bands:{month}`): on the first day of a month,
 * or whenever started manually.
 *
 * - Reports from cycles under a live over-count hold (`outcome_cycle_holds`, or a live
 *   over-count `outcome_anomaly` task) are left out of the fit, as readiness leaves them out of
 *   its counts: a frozen cycle never trains a model pooled across its type.
 * - A founder approval names one model card (`payload.modelKey` and `payload.modelFingerprint`,
 *   server/db/repos/bands.ts `bandModelFingerprint`). The fit is approved only when its own
 *   fingerprint matches; a refit with new data needs a new review.
 * - After a complete run, every model key this run did not store (no data any more, a program
 *   whose type changed, official counts removed) is retired in band_models and its R2 copy
 *   deleted, so readiness never keeps using a band built from data that is gone.
 */

/** Feature specs (judgment): the allowlist of three, with levels as the profile stores them. */
export const BAND_SPECS: readonly BandFeatureSpec[] = [
  {
    key: "gpa_band",
    levels: ["under_2_0", "2_0_to_2_49", "2_5_to_2_74", "2_75_to_2_99", "3_0_to_3_24", "3_25_to_3_49", "3_5_to_3_74", "3_75_plus"],
    coding: "ordinal",
    monotone: "increasing",
  },
  { key: "class_standing", levels: ["first_year", "second_year", "third_year", "fourth_year"], coding: "nominal", monotone: "none" },
  { key: "prior_program", levels: ["no", "yes"], coding: "nominal", monotone: "none" },
];

export const BANDS_MODEL_PREFIX = "private/bands/models/";
export const BANDS_ALGO_VERSION = "bands-fit-v1";

/** One counted report as the fit sees it: allowlisted levels, a tier weight, no identity. */
export interface BandReportRow {
  readonly programId: string;
  readonly opportunityType: string;
  readonly cycleYear: number;
  readonly tier: string;
  readonly facts: OutcomeFacts;
  readonly windowClosed: boolean;
  readonly levels: BandLevels;
  /** Audit group for the fairness test only (shared/taxonomy institution level). Never a feature. */
  readonly institutionLevel: string | null;
}

/** Official counts at two consecutive stages of one program cycle (official_publication, exact). */
export interface OfficialStageRate {
  readonly programId: string;
  readonly cycleYear: number;
  readonly from: CountStageCode;
  readonly to: CountStageCode;
  readonly k: number;
  readonly n: number;
}

export interface BandGroupInput {
  readonly opportunityType: string;
  readonly from: CountStageCode;
  readonly to: CountStageCode;
  readonly reports: readonly BandReportRow[];
  readonly rates: readonly OfficialStageRate[];
  /** Official recipients' institution-level mix (shares summing to 1); null when not recorded. */
  readonly recipientMix: Readonly<Record<string, number>> | null;
  readonly approved: boolean;
  readonly modelVersion: string;
  readonly methodologyUrl: string | null;
  readonly resamples?: number;
  readonly seed?: number;
  /** Override the feature specs (tests and synthetic audits). */
  readonly specs?: readonly BandFeatureSpec[];
}

export interface BandGroupResult {
  readonly key: string;
  readonly status: "fitted" | "insufficient_data";
  readonly model: BandModel | null;
  readonly gates: BandGateFlags;
  /** True only when every gate passes, approval included. */
  readonly live: boolean;
  readonly heldOutYear: number | null;
  readonly heldOut: Pick<HeldOutGateReport, "n" | "clusters" | "outcome" | "failures"> | null;
  readonly fairnessGroups: readonly { readonly group: string; readonly n: number; readonly passes: boolean }[];
  readonly counts: { readonly trainReports: number; readonly heldOutReports: number; readonly programs: number };
}

export function modelKey(opportunityType: string, from: string, to: string): string {
  return `${opportunityType}.${from}-${to}`;
}

const CLOSED: BandGateFlags = { pooled: false, heldOut: "not_evaluated", representativeness: false, fairness: false, usefulness: false, approved: false };

function ratesFor(rates: readonly OfficialStageRate[], years: (y: number) => boolean): Record<string, number> {
  const acc = new Map<string, { k: number; n: number }>();
  for (const r of rates) {
    if (!years(r.cycleYear) || !(r.n > 0) || r.k < 0 || r.k > r.n) continue;
    const a = acc.get(r.programId) ?? { k: 0, n: 0 };
    a.k += r.k;
    a.n += r.n;
    acc.set(r.programId, a);
  }
  const out: Record<string, number> = {};
  for (const [id, a] of acc) if (a.k > 0 && a.k < a.n) out[id] = a.k / a.n;
  return out;
}

/**
 * Representativeness (plan 7.5.5 step 3): Novus-reported admits must resemble the official
 * recipients by institution level within 10 points, with at least 20 admits. Without a recorded
 * recipient mix there is nothing to compare with, so the gate fails (bands stay off).
 */
export function representativenessGate(admitLevels: readonly (string | null)[], recipientMix: Readonly<Record<string, number>> | null): boolean {
  const cfg = OUTCOMES_CONFIG.representativeness;
  if (!recipientMix) return false;
  const known = admitLevels.filter((l): l is string => l !== null);
  if (known.length < cfg.minAdmits) return false;
  for (const level of INSTITUTION_LEVEL_CODES) {
    const share = known.filter((l) => l === level).length / known.length;
    if (Math.abs(share - (recipientMix[level] ?? 0)) > cfg.maxShareGap) return false;
  }
  return true;
}

/** Pure: fit one opportunity type and stage transition and evaluate every gate. */
export function fitBandGroup(input: BandGroupInput): BandGroupResult {
  const key = modelKey(input.opportunityType, input.from, input.to);
  const specs = input.specs ?? BAND_SPECS;
  const scored = input.reports
    .filter((r) => r.opportunityType === input.opportunityType && tierWeight(r.tier) > 0)
    .map((r) => ({ r, result: transitionResult(r.facts, input.from, input.to, r.windowClosed) }))
    .filter((x): x is { r: BandReportRow; result: "pass" | "fail" } => x.result !== null);
  const rateYears = new Set(input.rates.map((r) => r.cycleYear));
  const reportYears = [...new Set(scored.map((x) => x.r.cycleYear))].filter((y) => rateYears.has(y)).sort((a, b) => a - b);
  // Fit on earlier cycles, score the latest completed one (never leave-one-year-out).
  const heldOutYear = reportYears.length >= 2 ? reportYears[reportYears.length - 1]! : null;
  const train = scored.filter((x) => (heldOutYear === null ? true : x.r.cycleYear < heldOutYear));
  const held = heldOutYear === null ? [] : scored.filter((x) => x.r.cycleYear === heldOutYear);
  const asReport = (x: (typeof scored)[number]) => ({ programId: x.r.programId, levels: x.r.levels, passed: x.result === "pass", weight: tierWeight(x.r.tier) });

  const trainRates = ratesFor(input.rates, (y) => (heldOutYear === null ? true : y < heldOutYear));
  const heldRates = ratesFor(input.rates, (y) => y === heldOutYear);
  const trainCells = aggregateBandCells(train.map(asReport), specs);
  const counts = { trainReports: train.length, heldOutReports: held.length, programs: new Set(scored.map((x) => x.r.programId)).size };
  if (trainCells.length === 0 || Object.keys(trainRates).length === 0) {
    return { key, status: "insufficient_data", model: null, gates: { ...CLOSED, approved: input.approved }, live: false, heldOutYear, heldOut: null, fairnessGroups: [], counts };
  }

  const fit = fitBandModel({ cells: trainCells, specs, officialRates: trainRates });
  const heldCells = aggregateBandCells(held.map(asReport), specs);

  let heldOut: BandGroupResult["heldOut"] = null;
  let heldOutOutcome: BandGateFlags["heldOut"] = "not_evaluated";
  const items = heldCells.length > 0 ? heldOutScoredItems(fit, heldCells, heldRates) : [];
  if (items.length > 0) {
    const report = heldOutGates(items, (it) => heldRates[it.cluster ?? ""] ?? 0.5, { resamples: input.resamples, seed: input.seed });
    heldOut = { n: report.n, clusters: report.clusters, outcome: report.outcome, failures: report.failures };
    heldOutOutcome = report.outcome;
  }

  // Fairness on held-out reports, grouped by institution level only (aggregate, non-sensitive).
  const groupItems: GroupScored[] = [];
  const byProgram = new Map<string, { w1: number; w0: number }>();
  for (const x of held) {
    const a = byProgram.get(x.r.programId) ?? { w1: 0, w0: 0 };
    if (x.result === "pass") a.w1 += tierWeight(x.r.tier);
    else a.w0 += tierWeight(x.r.tier);
    byProgram.set(x.r.programId, a);
  }
  for (const x of held) {
    const tau = heldRates[x.r.programId];
    const w = byProgram.get(x.r.programId)!;
    const level = x.r.institutionLevel;
    if (tau === undefined || !(w.w1 > 0) || !(w.w0 > 0) || !level || !(INSTITUTION_LEVEL_CODES as readonly string[]).includes(level)) continue;
    const p = bandProbability(fit, x.r.programId, x.r.levels);
    if (p === null) continue;
    const ybar = w.w1 / (w.w1 + w.w0);
    const weight = (x.result === "pass" ? tau / ybar : (1 - tau) / (1 - ybar)) * tierWeight(x.r.tier);
    groupItems.push({ p, y: x.result === "pass" ? 1 : 0, w: weight, cluster: x.r.programId, group: `institution_level:${level}` });
  }
  const fairness = groupItems.length > 0 ? fairnessGate(groupItems, { resamples: input.resamples, seed: input.seed }) : { groups: [], passes: false };

  const admits = (held.length > 0 ? held : train).filter((x) => x.result === "pass").map((x) => x.r.institutionLevel);
  const usefulness = heldCells.length > 0 && nonTypicalShare(fit, heldCells) >= READINESS_CONFIG.bands.minNonTypicalShare;
  const gates = {
    heldOut: heldOutOutcome,
    representativeness: representativenessGate(admits, input.recipientMix),
    fairness: fairness.passes,
    usefulness,
    approved: input.approved,
  };
  const model = BandModelSchema.parse(
    toBandModel(fit, {
      modelVersion: input.modelVersion,
      opportunityType: input.opportunityType,
      fromStage: input.from,
      toStage: input.to,
      cycles: [...new Set(train.map((x) => x.r.cycleYear))].sort((a, b) => a - b).slice(-10),
      gates,
      methodologyUrl: input.methodologyUrl,
    }),
  );
  return {
    key,
    status: "fitted",
    model,
    gates: model.gates,
    live: allBandGatesPass(model.gates),
    heldOutYear,
    heldOut,
    fairnessGroups: fairness.groups.map((g) => ({ group: g.group, n: g.n, passes: g.passes })),
    counts,
  };
}

// ---------------------------------------------------------------------------------------------
// D1 loading and R2 storage
// ---------------------------------------------------------------------------------------------

/** First four-digit year in a cycle key ("ay-2026-27" -> 2026). */
export function cycleYearOf(cycleKey: string): number | null {
  const m = /(\d{4})/.exec(cycleKey);
  return m ? Number(m[1]) : null;
}

export interface BandFitData {
  readonly reports: BandReportRow[];
  readonly rates: OfficialStageRate[];
}

/**
 * Loads counted (non-self-reported), unflagged, live Outcome reports with their snapshot levels,
 * and official exact counts. Status-defined programs have no Outcome rows (trigger), and they are
 * filtered again here. Nothing leaves this function except allowlisted levels and stage facts.
 */
export async function loadBandFitData(db: Db, today: string): Promise<BandFitData> {
  const rows = await db
    .select({
      id: s.outcomes.id,
      tier: s.outcomes.tier,
      decision: s.outcomes.decision,
      decidedOn: s.outcomes.decidedOn,
      classYear: s.outcomes.classYear,
      gpaBand: s.outcomes.gpaBand,
      priorFeeder: s.outcomes.priorFeeder,
      institutionLevel: s.outcomes.institutionType,
      programId: s.programs.id,
      programCycleId: s.outcomes.programCycleId,
      cycleKey: s.programCycles.cycleKey,
      decisionWindowStart: s.programCycles.decisionWindowStart,
      decisionWindowEnd: s.programCycles.decisionWindowEnd,
      sensitive: s.programs.sensitiveAudience,
    })
    .from(s.outcomes)
    .innerJoin(s.programCycles, eq(s.programCycles.id, s.outcomes.programCycleId))
    .innerJoin(s.programs, eq(s.programs.id, s.programCycles.programId))
    .where(and(isNull(s.outcomes.deletedAt), eq(s.outcomes.qualityState, "ok"), ne(s.outcomes.tier, "self_reported")));
  // A cycle under a live over-count hold is frozen: its reports are suspected inflated and never
  // train a pooled model (the same rule as readiness's countedProgramReports).
  const held = new Set(await heldCycleIds(db, [...new Set(rows.map((r) => r.programCycleId))]));
  const usable = rows.filter((r) => !r.sensitive && !held.has(r.programCycleId));
  const ids = usable.map((r) => r.id);
  const stages = ids.length
    ? await db.select({ outcomeId: s.outcomeStages.outcomeId, stage: s.outcomeStages.stage, onDate: s.outcomeStages.onDate }).from(s.outcomeStages).where(inArray(s.outcomeStages.outcomeId, ids))
    : [];
  const programIds = [...new Set(usable.map((r) => r.programId))];
  const types = programIds.length
    ? await db.select({ programId: s.programTypes.programId, typeSlug: s.programTypes.typeSlug, isPrimary: s.programTypes.isPrimary }).from(s.programTypes).where(inArray(s.programTypes.programId, programIds))
    : [];
  const typeOf = (programId: string): string | null => {
    const mine = types.filter((t) => t.programId === programId).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.typeSlug.localeCompare(b.typeSlug));
    return mine[0]?.typeSlug ?? null;
  };

  const reports: BandReportRow[] = [];
  for (const r of usable) {
    const year = cycleYearOf(r.cycleKey);
    const type = typeOf(r.programId);
    if (year === null || type === null) continue;
    const levels: Partial<Record<"gpa_band" | "class_standing" | "prior_program", string>> = {};
    if (r.gpaBand && r.gpaBand !== "none_yet" && r.gpaBand !== "prefer_not") levels.gpa_band = r.gpaBand;
    if (r.classYear) levels.class_standing = r.classYear;
    if (r.priorFeeder) levels.prior_program = r.priorFeeder;
    reports.push({
      programId: r.programId,
      opportunityType: type,
      cycleYear: year,
      tier: r.tier,
      facts: {
        stages: stages.filter((st) => st.outcomeId === r.id).map((st) => ({ stage: st.stage as OutcomeFacts["stages"][number]["stage"], on: st.onDate })),
        decision: r.decision as OutcomeFacts["decision"],
        decidedOn: r.decidedOn,
      },
      windowClosed: decisionWindowClosed({ decisionWindowStart: r.decisionWindowStart, decisionWindowEnd: r.decisionWindowEnd }, today),
      levels,
      institutionLevel: r.institutionLevel,
    });
  }

  const counts = programIds.length
    ? await db
        .select({ programId: s.programCycles.programId, cycleKey: s.programCycles.cycleKey, stage: s.programCycleCounts.stage, count: s.programCycleCounts.count, kind: s.programCycleCounts.kind })
        .from(s.programCycleCounts)
        .innerJoin(s.programCycles, eq(s.programCycles.id, s.programCycleCounts.programCycleId))
        .where(and(eq(s.programCycleCounts.provenance, "official_publication"), inArray(s.programCycles.programId, programIds)))
    : [];
  const rates: OfficialStageRate[] = [];
  const byCycle = new Map<string, typeof counts>();
  for (const c of counts) byCycle.set(`${c.programId}|${c.cycleKey}`, [...(byCycle.get(`${c.programId}|${c.cycleKey}`) ?? []), c]);
  for (const list of byCycle.values()) {
    const year = cycleYearOf(list[0]!.cycleKey);
    if (year === null) continue;
    // Exact counts only: a lower-bound pool would understate τ and overstate every band.
    const exact = list.filter((c) => c.kind === "exact");
    for (const t of consecutiveTransitions(exact.map((c) => c.stage as CountStageCode))) {
      const n = exact.find((c) => c.stage === t.from)!.count;
      const k = exact.find((c) => c.stage === t.to)!.count;
      if (n > 0 && k >= 0 && k <= n) rates.push({ programId: list[0]!.programId, cycleYear: year, from: t.from, to: t.to, k, n });
    }
  }
  return { reports, rates };
}

/**
 * Marks a fitted group approved when a live founder approval names this exact model card (its
 * key and fingerprint). Gate values are otherwise unchanged; `live` is recomputed.
 */
export async function applyApproval(result: BandGroupResult, approvals: readonly { modelKey: string; modelFingerprint: string }[]): Promise<BandGroupResult & { fingerprint: string | null }> {
  if (!result.model) return { ...result, fingerprint: null };
  const fingerprint = await bandModelFingerprint(result.model);
  const approved = approvals.some((a) => a.modelKey === result.key && a.modelFingerprint === fingerprint);
  if (!approved) return { ...result, fingerprint };
  const model = BandModelSchema.parse({ ...result.model, gates: { ...result.model.gates, approved: true } });
  return { ...result, model, gates: model.gates, live: allBandGatesPass(model.gates), fingerprint };
}

/** The R2 surface this job needs (a structural subset of R2Bucket). */
export interface BandModelBucket {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list?(options?: { prefix?: string }): Promise<{ objects: { key: string }[] }>;
  delete?(key: string): Promise<unknown>;
}

export interface StoredBandModel {
  readonly key: string;
  readonly fittedOn: string;
  readonly algo: string;
  readonly live: boolean;
  readonly model: BandModel;
  /** The model card a founder approves (`payload.modelFingerprint`); absent on older objects. */
  readonly fingerprint?: string;
}

export function bandModelObjectKey(key: string): string {
  return `${BANDS_MODEL_PREFIX}${key}.json`;
}

/** Stored privately: the bucket prefix is never served by the pages router. */
export async function storeBandModel(bucket: BandModelBucket, entry: StoredBandModel): Promise<void> {
  await bucket.put(bandModelObjectKey(entry.key), JSON.stringify(entry), { httpMetadata: { contentType: "application/json" } });
}

/**
 * Retires every model key this run did not store: supersedes its live band_models rows and
 * deletes its R2 copy (every listed object under the prefix that is not one of `kept`).
 */
export async function retireUnfittedModels(db: Db, bucket: BandModelBucket, kept: ReadonlySet<string>, now: number): Promise<{ keys: number; rows: number; objects: number }> {
  let keys = 0;
  let rows = 0;
  for (const key of await liveBandModelKeys(db)) {
    if (kept.has(key)) continue;
    rows += await retireBandModel(db, key, now);
    keys++;
  }
  let objects = 0;
  if (bucket.list && bucket.delete) {
    const listed = await bucket.list({ prefix: BANDS_MODEL_PREFIX });
    const keptObjects = new Set([...kept].map(bandModelObjectKey));
    for (const { key } of listed.objects) {
      if (keptObjects.has(key)) continue;
      await bucket.delete(key);
      objects++;
    }
  }
  return { keys, rows, objects };
}

// ---------------------------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------------------------

export function shouldRunThisSlot(slot: string | null, trigger: JobContext["trigger"]): boolean {
  if (trigger === "manual") return true;
  return slot !== null && /^\d{4}-\d{2}-01$/.test(slot);
}

export async function bandsFit(ctx: JobContext): Promise<HandlerResult> {
  if (!shouldRunThisSlot(ctx.slot, ctx.trigger)) return { processed: 0, outcome: "ok", detail: { skipped: "not_month_start" } };
  const bucket = ctx.env.STORE as unknown as BandModelBucket | undefined;
  if (!bucket) return { processed: 0, outcome: "deferred" };
  if (!ctx.budget.allows(8)) return { processed: 0, outcome: "partial" };
  const today = new Date(ctx.now()).toISOString().slice(0, 10);
  const data = await loadBandFitData(ctx.db, today);
  const approvals = await liveBandApprovals(ctx.db);
  ctx.budget.spend(6);

  const groups = new Map<string, { type: string; from: CountStageCode; to: CountStageCode }>();
  const typeOfProgram = new Map(data.reports.map((r) => [r.programId, r.opportunityType]));
  for (const rate of data.rates) {
    const type = typeOfProgram.get(rate.programId);
    if (type) groups.set(modelKey(type, rate.from, rate.to), { type, from: rate.from, to: rate.to });
  }
  const month = today.slice(0, 7);
  let processed = 0;
  let live = 0;
  const stored = new Set<string>();
  for (const [key, g] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    // A partial run retires nothing: keys it did not reach are not known to be gone.
    if (!ctx.budget.allows(1)) return { processed, outcome: "partial" };
    const fitted = fitBandGroup({
      opportunityType: g.type,
      from: g.from,
      to: g.to,
      reports: data.reports,
      rates: data.rates.filter((r) => typeOfProgram.get(r.programId) === g.type && r.from === g.from && r.to === g.to),
      recipientMix: null,
      approved: false,
      modelVersion: `${BANDS_ALGO_VERSION}.${month}`,
      methodologyUrl: ctx.env.APP_ORIGIN ? `${ctx.env.APP_ORIGIN.replace(/\/$/, "")}/methods` : null,
    });
    const result = await applyApproval(fitted, approvals);
    if (result.model) {
      stored.add(key);
      await storeBandModel(bucket, { key, fittedOn: today, algo: BANDS_ALGO_VERSION, live: result.live, model: result.model, fingerprint: result.fingerprint ?? undefined });
      ctx.budget.spend();
      // The D1 copy readiness reads (band_models); read-time gates decide whether it is used.
      await storeProgramBandModels(ctx.db, { key, fittedOn: today, algo: BANDS_ALGO_VERSION, model: result.model }, ctx.now());
      ctx.budget.spend();
    }
    if (result.live) live++;
    // Counts and gate outcomes only: no program, report or account in the log.
    ctx.log("info", "bands.fit_group", { status: result.status, live: result.live, heldOut: result.gates.heldOut, fairness: result.gates.fairness, pooled: result.gates.pooled });
    processed++;
  }
  if (!ctx.budget.allows(2)) return { processed, outcome: "partial" };
  const retired = await retireUnfittedModels(ctx.db, bucket, stored, ctx.now());
  ctx.budget.spend(2);
  if (retired.keys + retired.objects > 0) ctx.log("info", "bands.retired", retired);
  return { processed, outcome: "ok", detail: { groups: processed, live, reports: data.reports.length, retired: retired.keys } };
}
