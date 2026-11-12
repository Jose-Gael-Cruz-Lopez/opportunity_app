import { z } from "zod";
import { READINESS_CONFIG } from "./config";
import { cholesky, choleskySolve, multiply, quadraticForm, spdInverse, subMatrix, zeroMatrix, type Matrix } from "./math/linalg";
import { clampProbability, expit, log1pExp, logit, Z80 } from "./math/special";
import { coxSnellR2, rileyMinimumN, vanHouwelingenShrinkage } from "./samplesize";
import type { Scored } from "./calibration";
import { UrlSchema } from "../contracts/common";
import type { CompetitivenessFactor } from "../contracts/readiness";
import { CountStageSchema, type ExperienceKind } from "../taxonomy";

/**
 * Personal competitiveness bands (plan 7.5.5, Phase 4): a continuation-ratio logit per stage
 * transition, fitted on weighted cell aggregates of verified Outcome reports.
 *
 *   logit P(pass s | reached s, x) = α_ps + β_s'(x − x̄_ps)
 *
 * - β_s is shared within an OpportunityType and stage (never per program, never across stages);
 *   prior β ~ N(0, 0.5²) on each centred 0/1 column (range-1 scaling, Gelman et al. 2008); at
 *   most three allowlisted features.
 * - Ordinal features use cumulative coding with sign-constrained increments (projected Newton),
 *   so a higher GPA band can never lower a band.
 * - Admits report more often. α̂ is fitted on reporters and then pinned to the official stage
 *   rate τ by King and Zeng's prior correction (Eq. 7):
 *     α* = α̂ − ln[((1 − τ)/τ) · (ȳ/(1 − ȳ))].
 *   x̄_ps is the applicant mix recovered from reporters with weights τ/ȳ (admits) and
 *   (1 − τ)/(1 − ȳ) (others); check: the mix-average of expit(α* + β'(x − x̄)) is within 0.1
 *   logit of τ.
 * - The band is decided on the contrast alone, Δ(x) = β'(x − x̄), with its 80% interval
 *   Δ ± 1.2816·sd: above typical if the lower end > ln 1.5, below typical if the upper end
 *   < −ln 1.5, else typical. Intercept noise is pinned away, which removed every false label in
 *   the study's no-effect simulation. sd uses the wider of the sandwich and posterior variances.
 * No band is ever shown as a number, and the features never include school, location,
 * demographics, SensitiveAnswers or Pell (REQ-043).
 */

export const BAND_FEATURE_KEYS = ["class_standing", "gpa_band", "prior_program"] as const;
export type BandFeatureKey = (typeof BAND_FEATURE_KEYS)[number];

/** Generic experience kinds answering "a summer research, insight or leadership program before this one?". */
export const PRIOR_PROGRAM_KINDS: readonly ExperienceKind[] = ["research", "insight_program", "leadership"];

export const BandFeatureSpecSchema = z
  .object({
    key: z.enum(BAND_FEATURE_KEYS),
    levels: z.array(z.string().min(1).max(40)).min(2).max(20),
    coding: z.enum(["ordinal", "nominal"]),
    monotone: z.enum(["increasing", "decreasing", "none"]),
  })
  .strict();
export type BandFeatureSpec = z.infer<typeof BandFeatureSpecSchema>;

export type BandLevels = Readonly<Partial<Record<BandFeatureKey, string>>>;

export interface BandColumn {
  readonly feature: BandFeatureKey;
  readonly name: string;
  readonly lower: number;
  readonly upper: number;
}

/** Rejects any feature outside the allowlist: the denylist is enforced by construction. */
export function assertAllowedSpecs(specs: readonly BandFeatureSpec[]): void {
  const allowed = new Set<string>(BAND_FEATURE_KEYS);
  const seen = new Set<string>();
  if (specs.length === 0 || specs.length > 3) throw new Error("band models use one to three allowlisted features");
  for (const spec of specs) {
    if (!allowed.has(spec.key)) throw new Error(`feature not on the band allowlist: ${String(spec.key)}`);
    if (seen.has(spec.key)) throw new Error(`duplicate band feature: ${spec.key}`);
    if (new Set(spec.levels).size !== spec.levels.length || spec.levels.length < 2) throw new Error(`feature ${spec.key} needs two or more distinct levels`);
    seen.add(spec.key);
  }
}

/** Columns: cumulative indicators 1[level ≥ k] for ordinal features, dummies for nominal ones. */
export function bandColumns(specs: readonly BandFeatureSpec[]): BandColumn[] {
  const columns: BandColumn[] = [];
  for (const spec of specs) {
    for (let k = 1; k < spec.levels.length; k++) {
      const ordinal = spec.coding === "ordinal";
      const lower = ordinal && spec.monotone === "increasing" ? 0 : -Infinity;
      const upper = ordinal && spec.monotone === "decreasing" ? 0 : Infinity;
      columns.push({ feature: spec.key, name: ordinal ? `${spec.key}>=${spec.levels[k]}` : `${spec.key}=${spec.levels[k]}`, lower, upper });
    }
  }
  return columns;
}

/** Coded column values for a set of levels, or null when a level is missing or unknown. */
export function codeLevels(specs: readonly BandFeatureSpec[], levels: BandLevels): number[] | null {
  const x: number[] = [];
  for (const spec of specs) {
    const level = levels[spec.key];
    const index = level === undefined ? -1 : spec.levels.indexOf(level);
    if (index < 0) return null;
    for (let k = 1; k < spec.levels.length; k++) x.push(spec.coding === "ordinal" ? (index >= k ? 1 : 0) : index === k ? 1 : 0);
  }
  return x;
}

/** The disclosure cell a student falls in ("class_standing=second_year|gpa_band=3_5_to_3_74"). */
export function bandCellKey(specs: readonly BandFeatureSpec[], levels: BandLevels): string | null {
  const parts: string[] = [];
  for (const spec of specs) {
    const level = levels[spec.key];
    if (level === undefined || !spec.levels.includes(level)) return null;
    parts.push(`${spec.key}=${level}`);
  }
  return parts.join("|");
}

/** Weighted aggregates of counted Outcome reports in one program × feature cell. */
export interface BandCell {
  readonly programId: string;
  readonly levels: BandLevels;
  /** Σ tier weights of reports that passed the stage, and of those that did not. */
  readonly passWeight: number;
  readonly failWeight: number;
  /** Σ squared weights (for the sandwich variance and Kish's n_eff). */
  readonly passWeightSq: number;
  readonly failWeightSq: number;
  /** Unweighted counted reports (for the disclosure and per-outcome gates). */
  readonly passReports: number;
  readonly failReports: number;
}

/** Aggregates individual reports into cells (the fit never touches Outcome rows one by one). */
export function aggregateBandCells(
  reports: readonly { readonly programId: string; readonly levels: BandLevels; readonly passed: boolean; readonly weight: number }[],
  specs: readonly BandFeatureSpec[],
): BandCell[] {
  const cells = new Map<string, { programId: string; levels: BandLevels; pw: number; fw: number; pq: number; fq: number; pn: number; fn: number }>();
  // Sum in a canonical order: floating-point addition is not associative, and the fit must be
  // byte-identical however the reports were listed.
  const keyed = reports
    .filter((r) => r.weight > 0)
    .map((r) => ({ r, key: bandCellKey(specs, r.levels) }))
    .filter((x): x is { r: (typeof reports)[number]; key: string } => x.key !== null)
    .map((x) => ({ ...x, id: `${x.r.programId}#${x.key}` }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : Number(a.r.passed) - Number(b.r.passed) || a.r.weight - b.r.weight));
  for (const { r, id } of keyed) {
    const cell = cells.get(id) ?? { programId: r.programId, levels: r.levels, pw: 0, fw: 0, pq: 0, fq: 0, pn: 0, fn: 0 };
    if (r.passed) {
      cell.pw += r.weight;
      cell.pq += r.weight * r.weight;
      cell.pn += 1;
    } else {
      cell.fw += r.weight;
      cell.fq += r.weight * r.weight;
      cell.fn += 1;
    }
    cells.set(id, cell);
  }
  return [...cells.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, c]) => ({
      programId: c.programId,
      levels: Object.fromEntries(specs.map((s) => [s.key, c.levels[s.key]])) as BandLevels,
      passWeight: c.pw,
      failWeight: c.fw,
      passWeightSq: c.pq,
      failWeightSq: c.fq,
      passReports: c.pn,
      failReports: c.fn,
    }));
}

// ---------------------------------------------------------------------------------------------
// Penalized, sign-constrained logistic regression on cell aggregates (projected Newton).
// ---------------------------------------------------------------------------------------------

interface FitRow {
  readonly group: number;
  readonly z: readonly number[];
  readonly w1: number;
  readonly w0: number;
  readonly q1: number;
  readonly q0: number;
}

interface FitProblem {
  readonly rows: readonly FitRow[];
  readonly groups: number;
  readonly columns: number;
  /** Prior precision per parameter (intercepts first). */
  readonly precision: readonly number[];
  readonly lower: readonly number[];
  readonly upper: readonly number[];
}

interface FitResult {
  readonly theta: number[];
  readonly hessian: Matrix;
  readonly meat: Matrix;
  readonly free: boolean[];
  readonly logLik: number;
  readonly converged: boolean;
  readonly iterations: number;
}

function linearPredictor(row: FitRow, theta: readonly number[], groups: number): number {
  let eta = theta[row.group]!;
  for (let k = 0; k < row.z.length; k++) eta += theta[groups + k]! * row.z[k]!;
  return eta;
}

function logLikelihood(problem: FitProblem, theta: readonly number[]): number {
  let ll = 0;
  for (const row of problem.rows) {
    const eta = linearPredictor(row, theta, problem.groups);
    ll += row.w1 * eta - (row.w1 + row.w0) * log1pExp(eta);
  }
  return ll;
}

function objective(problem: FitProblem, theta: readonly number[]): number {
  let penalty = 0;
  for (let i = 0; i < theta.length; i++) penalty += 0.5 * problem.precision[i]! * theta[i]! * theta[i]!;
  return -logLikelihood(problem, theta) + penalty;
}

/** Gradient and Hessian of the penalized objective; the meat uses squared weights per outcome. */
function derivatives(problem: FitProblem, theta: readonly number[]): { g: number[]; h: Matrix; meat: Matrix } {
  const n = theta.length;
  const g = theta.map((t, i) => problem.precision[i]! * t);
  const h = zeroMatrix(n);
  const meat = zeroMatrix(n);
  for (let i = 0; i < n; i++) h[i]![i] = problem.precision[i]!;
  const u = new Array<number>(n).fill(0);
  for (const row of problem.rows) {
    const eta = linearPredictor(row, theta, problem.groups);
    const pi = expit(eta);
    const m = row.w1 + row.w0;
    const resid = row.w1 - m * pi;
    const curv = m * pi * (1 - pi);
    const scoreVar = row.q1 * (1 - pi) * (1 - pi) + row.q0 * pi * pi;
    u.fill(0);
    u[row.group] = 1;
    for (let k = 0; k < row.z.length; k++) u[problem.groups + k] = row.z[k]!;
    for (let i = 0; i < n; i++) {
      const ui = u[i]!;
      if (ui === 0) continue;
      g[i] = g[i]! - resid * ui;
      const hi = h[i]!;
      const mi = meat[i]!;
      for (let j = 0; j < n; j++) {
        const uj = u[j]!;
        if (uj === 0) continue;
        hi[j] = hi[j]! + curv * ui * uj;
        mi[j] = mi[j]! + scoreVar * ui * uj;
      }
    }
  }
  return { g, h, meat };
}

function project(theta: readonly number[], problem: FitProblem): number[] {
  return theta.map((t, i) => Math.min(problem.upper[i]!, Math.max(problem.lower[i]!, t)));
}

function activeSet(theta: readonly number[], g: readonly number[], problem: FitProblem): boolean[] {
  const eps = 1e-9;
  return theta.map((t, i) => (t <= problem.lower[i]! + eps && g[i]! > 0) || (t >= problem.upper[i]! - eps && g[i]! < 0));
}

/** Bertsekas-style projected Newton for a strictly convex objective with bound constraints. */
function fitPenalizedLogit(problem: FitProblem): FitResult {
  const size = problem.groups + problem.columns;
  let theta = project(new Array<number>(size).fill(0), problem);
  let converged = false;
  let iterations = 0;
  for (; iterations < 200; iterations++) {
    const { g, h } = derivatives(problem, theta);
    const projectedGradient = Math.max(0, ...theta.map((t, i) => Math.abs(t - Math.min(problem.upper[i]!, Math.max(problem.lower[i]!, t - g[i]!)))));
    if (projectedGradient < 1e-9) {
      converged = true;
      break;
    }
    const active = activeSet(theta, g, problem);
    const free = active.map((a, i) => (a ? -1 : i)).filter((i) => i >= 0);
    const l = cholesky(subMatrix(h, free));
    if (!l) break;
    const stepFree = choleskySolve(l, free.map((i) => -g[i]!));
    const direction = new Array<number>(size).fill(0);
    free.forEach((i, k) => (direction[i] = stepFree[k]!));
    const f0 = objective(problem, theta);
    let t = 1;
    let next: number[] | null = null;
    for (let ls = 0; ls < 60; ls++) {
      const candidate = project(theta.map((v, i) => v + t * direction[i]!), problem);
      const decrease = candidate.reduce((s, v, i) => s + g[i]! * (v - theta[i]!), 0);
      if (objective(problem, candidate) <= f0 + 1e-4 * decrease) {
        next = candidate;
        break;
      }
      t /= 2;
    }
    if (!next) {
      converged = true;
      break;
    }
    const moved = Math.max(...next.map((v, i) => Math.abs(v - theta[i]!)));
    theta = next;
    if (moved < 1e-12) {
      converged = true;
      break;
    }
  }
  const { g, h, meat } = derivatives(problem, theta);
  const active = activeSet(theta, g, problem);
  return { theta, hessian: h, meat, free: active.map((a) => !a), logLik: logLikelihood(problem, theta), converged, iterations };
}

/**
 * Covariances over every parameter, including any held at a monotonicity bound. A coefficient
 * pinned at zero is still uncertain (the data only say it is not clearly positive), and giving it
 * zero variance made the contrast look precise: in the no-effect simulation it doubled the false
 * labels at 30 reports. The full Hessian keeps that uncertainty, which errs toward "typical".
 */
function covariances(fit: FitResult): { sandwich: Matrix; posterior: Matrix } {
  const n = fit.theta.length;
  const inv = spdInverse(fit.hessian);
  if (!inv) return { sandwich: zeroMatrix(n), posterior: zeroMatrix(n) };
  return { sandwich: multiply(multiply(inv, fit.meat), inv), posterior: inv };
}

// ---------------------------------------------------------------------------------------------
// The band model fit.
// ---------------------------------------------------------------------------------------------

export interface ProgramBandStats {
  readonly programId: string;
  /** Kish effective size of the program's counted reports at this stage. */
  readonly nEff: number;
  readonly passReports: number;
  readonly failReports: number;
  /** Tier-weighted admit share among reporters. */
  readonly ybar: number;
  /** Official stage rate the intercept is pinned to. */
  readonly tau: number;
  readonly alphaHat: number;
  readonly alphaStar: number;
  /** Applicant-mix mean of the coded columns (the "typical applicant" at this stage). */
  readonly center: readonly number[];
  /** logit(mix-average probability) − logit(τ); must be within ±0.1. */
  readonly kingZengLogitGap: number;
  /** Per-program gates: n_eff ≥ 30, 8+ counted reports of each outcome, King-Zeng check. */
  readonly eligible: boolean;
}

export interface PooledBandStats {
  readonly reports: number;
  readonly nEff: number;
  readonly parameters: number;
  readonly lrChi2: number;
  readonly shrinkage: number;
  readonly coxSnellR2: number;
  readonly adjustedR2: number;
  readonly rileyMinN: number;
  /** n_eff ≥ 250, van Houwelingen shrinkage ≥ 0.9 and Riley criterion 1 met. */
  readonly passes: boolean;
}

export interface BandModelFit {
  readonly specs: readonly BandFeatureSpec[];
  readonly columns: readonly BandColumn[];
  readonly beta: readonly number[];
  readonly covSandwich: Matrix;
  readonly covPosterior: Matrix;
  readonly programs: readonly ProgramBandStats[];
  readonly excludedPrograms: readonly string[];
  readonly pooled: PooledBandStats;
  /** Counted reports per feature cell, pooled across programs (for the disclosure rule). */
  readonly cellReports: Readonly<Record<string, number>>;
  readonly converged: boolean;
  readonly iterations: number;
}

export interface BandFitInput {
  readonly cells: readonly BandCell[];
  readonly specs: readonly BandFeatureSpec[];
  /** Official stage rate τ per program for the fitted cycles. */
  readonly officialRates: Readonly<Record<string, number>>;
  readonly priorSd?: number;
  readonly interceptPriorSd?: number;
}

function sumOver<T>(items: readonly T[], f: (t: T) => number): number {
  return items.reduce((s, t) => s + f(t), 0);
}

export function fitBandModel(input: BandFitInput): BandModelFit {
  assertAllowedSpecs(input.specs);
  const cfg = READINESS_CONFIG.bands;
  const specs = input.specs;
  const columns = bandColumns(specs);
  const p = columns.length;

  // Group cells by program; keep programs with an official rate and both outcomes reported.
  const byProgram = new Map<string, { cell: BandCell; x: number[] }[]>();
  for (const cell of input.cells) {
    const x = codeLevels(specs, cell.levels);
    if (!x || cell.passWeight + cell.failWeight <= 0) continue;
    const list = byProgram.get(cell.programId) ?? [];
    list.push({ cell, x });
    byProgram.set(cell.programId, list);
  }
  const programIds = [...byProgram.keys()].sort();
  const included: string[] = [];
  const excluded: string[] = [];
  for (const id of programIds) {
    const cells = byProgram.get(id)!;
    const w1 = sumOver(cells, (c) => c.cell.passWeight);
    const w0 = sumOver(cells, (c) => c.cell.failWeight);
    const tau = input.officialRates[id];
    if (tau === undefined || !(tau > 0 && tau < 1) || !(w1 > 0) || !(w0 > 0)) excluded.push(id);
    else included.push(id);
  }

  const allCells = included.flatMap((id) => byProgram.get(id)!);
  const totalW = sumOver(allCells, (c) => c.cell.passWeight + c.cell.failWeight);
  const totalQ = sumOver(allCells, (c) => c.cell.passWeightSq + c.cell.failWeightSq);
  const nEffPooled = totalQ > 0 ? (totalW * totalW) / totalQ : 0;
  // Scale tier weights so they sum to Kish's n_eff: the prior then meets the data at its true size.
  const kappa = totalW > 0 ? nEffPooled / totalW : 1;

  const programInfo = included.map((id) => {
    const cells = byProgram.get(id)!;
    const w1 = sumOver(cells, (c) => c.cell.passWeight);
    const w0 = sumOver(cells, (c) => c.cell.failWeight);
    const q = sumOver(cells, (c) => c.cell.passWeightSq + c.cell.failWeightSq);
    const tau = input.officialRates[id]!;
    const ybar = w1 / (w1 + w0);
    const lambda1 = tau / ybar;
    const lambda0 = (1 - tau) / (1 - ybar);
    const mass = cells.map((c) => lambda1 * c.cell.passWeight + lambda0 * c.cell.failWeight);
    const massTotal = sumOver(mass, (m) => m);
    const center = new Array<number>(p).fill(0);
    cells.forEach((c, i) => c.x.forEach((v, k) => (center[k] = center[k]! + (mass[i]! * v) / massTotal)));
    return {
      id,
      cells,
      mass,
      tau,
      ybar,
      center,
      nEff: q > 0 ? ((w1 + w0) * (w1 + w0)) / q : 0,
      passReports: sumOver(cells, (c) => c.cell.passReports),
      failReports: sumOver(cells, (c) => c.cell.failReports),
    };
  });

  // Column spreads in the pooled applicant mix: they tell which columns carry information (for
  // the parameter count), not the prior's scale.
  const sd = new Array<number>(p).fill(0);
  let massAll = 0;
  for (const info of programInfo) {
    info.cells.forEach((c, i) => {
      massAll += info.mass[i]!;
      c.x.forEach((v, k) => (sd[k] = sd[k]! + info.mass[i]! * (v - info.center[k]!) ** 2));
    });
  }
  for (let k = 0; k < p; k++) sd[k] = massAll > 0 ? Math.sqrt(sd[k]! / massAll) : 0;

  const priorSd = input.priorSd ?? cfg.priorSd;
  const interceptPriorSd = input.interceptPriorSd ?? cfg.interceptPriorSd;
  const rows: FitRow[] = programInfo.flatMap((info, group) =>
    info.cells.map((c) => ({
      group,
      z: c.x.map((v, k) => v - info.center[k]!),
      w1: kappa * c.cell.passWeight,
      w0: kappa * c.cell.failWeight,
      q1: kappa * kappa * c.cell.passWeightSq,
      q0: kappa * kappa * c.cell.failWeightSq,
    })),
  );
  const groups = programInfo.length;
  // Every column is a 0/1 indicator, standardized as Gelman et al. (2008) do for binary inputs:
  // centred, range 1, so the prior sd applies to the indicator's own coefficient. Scaling by the
  // sample sd instead made the prior weakest exactly where a level had one or two reports (in the
  // no-effect simulation at 30 reports, 2.4% of students got a false band that way).
  const precision = [
    ...new Array<number>(groups).fill(1 / (interceptPriorSd * interceptPriorSd)),
    ...new Array<number>(p).fill(1 / (priorSd * priorSd)),
  ];
  const lower = [...new Array<number>(groups).fill(-Infinity), ...columns.map((c) => c.lower)];
  const upper = [...new Array<number>(groups).fill(Infinity), ...columns.map((c) => c.upper)];
  const problem: FitProblem = { rows, groups, columns: p, precision, lower, upper };

  const fit = groups > 0 ? fitPenalizedLogit(problem) : null;
  const beta = fit ? fit.theta.slice(groups) : new Array<number>(p).fill(0);
  const cov = fit ? covariances(fit) : { sandwich: zeroMatrix(groups + p), posterior: zeroMatrix(groups + p) };
  const betaIdx = columns.map((_, k) => groups + k);
  const covSandwich = subMatrix(cov.sandwich, betaIdx);
  const covPosterior = subMatrix(cov.posterior, betaIdx);

  // Null model (intercepts only) for the likelihood-ratio statistic, on the same scaled weights.
  const nullProblem: FitProblem = { rows: rows.map((r) => ({ ...r, z: [] })), groups, columns: 0, precision: precision.slice(0, groups), lower: lower.slice(0, groups), upper: upper.slice(0, groups) };
  const nullFit = groups > 0 ? fitPenalizedLogit(nullProblem) : null;
  const lrChi2 = fit && nullFit ? Math.max(0, 2 * (fit.logLik - nullFit.logLik)) : 0;
  const identifiable = sd.filter((s) => s > 1e-9).length;
  const shrinkage = vanHouwelingenShrinkage(lrChi2, identifiable);
  const r2 = coxSnellR2(lrChi2, nEffPooled);
  const adjustedR2 = shrinkage > 0 ? shrinkage * r2 : 0;
  const rileyMinN = rileyMinimumN(identifiable, adjustedR2, cfg.pooled.minShrinkage);
  const pooled: PooledBandStats = {
    reports: sumOver(allCells, (c) => c.cell.passReports + c.cell.failReports),
    nEff: nEffPooled,
    parameters: identifiable,
    lrChi2,
    shrinkage,
    coxSnellR2: r2,
    adjustedR2,
    rileyMinN,
    passes: nEffPooled >= cfg.pooled.minNEff && shrinkage >= cfg.pooled.minShrinkage && nEffPooled >= rileyMinN,
  };

  const programs: ProgramBandStats[] = programInfo.map((info, group) => {
    const alphaHat = fit ? fit.theta[group]! : logit(info.ybar);
    const alphaStar = alphaHat - Math.log(((1 - info.tau) / info.tau) * (info.ybar / (1 - info.ybar)));
    const massTotal = sumOver(info.mass, (m) => m);
    const avg = info.cells.reduce((s, c, i) => {
      let eta = alphaStar;
      c.x.forEach((v, k) => (eta += beta[k]! * (v - info.center[k]!)));
      return s + (info.mass[i]! * expit(eta)) / massTotal;
    }, 0);
    const gap = logit(clampProbability(avg)) - logit(info.tau);
    const eligible =
      info.nEff >= cfg.perProgram.minNEff &&
      info.passReports >= cfg.perProgram.minEachOutcome &&
      info.failReports >= cfg.perProgram.minEachOutcome &&
      Math.abs(gap) <= cfg.kingZengToleranceLogit;
    return {
      programId: info.id,
      nEff: info.nEff,
      passReports: info.passReports,
      failReports: info.failReports,
      ybar: info.ybar,
      tau: info.tau,
      alphaHat,
      alphaStar,
      center: info.center,
      kingZengLogitGap: gap,
      eligible,
    };
  });

  const cellReports: Record<string, number> = {};
  for (const { cell } of allCells) {
    const key = bandCellKey(specs, cell.levels);
    if (key !== null) cellReports[key] = (cellReports[key] ?? 0) + cell.passReports + cell.failReports;
  }

  return {
    specs,
    columns,
    beta,
    covSandwich,
    covPosterior,
    programs,
    excludedPrograms: excluded,
    pooled,
    cellReports,
    converged: fit?.converged ?? false,
    iterations: fit?.iterations ?? 0,
  };
}

// ---------------------------------------------------------------------------------------------
// The contrast rule and per-student decisions.
// ---------------------------------------------------------------------------------------------

export type BandLabel = "above_typical" | "typical" | "below_typical";

/** The odds-scale rule on the contrast's 80% interval. */
export function decideBand(delta: number, sd: number, opts: { z?: number; threshold?: number } = {}): BandLabel {
  const z = opts.z ?? Z80;
  const threshold = opts.threshold ?? READINESS_CONFIG.bands.thresholdLogOdds;
  if (delta - z * sd > threshold) return "above_typical";
  if (delta + z * sd < -threshold) return "below_typical";
  return "typical";
}

interface ContrastSource {
  readonly specs: readonly BandFeatureSpec[];
  readonly beta: readonly number[];
  readonly covSandwich: Matrix;
  readonly covPosterior: Matrix;
}

export interface FeatureContribution {
  readonly feature: BandFeatureKey;
  readonly contribution: number;
  readonly sd: number;
}

export interface StudentContrast {
  readonly delta: number;
  readonly sd: number;
  readonly perFeature: readonly FeatureContribution[];
}

/** Δ = β'(x − x̄) with the wider of the sandwich and posterior standard deviations. */
export function studentContrast(model: ContrastSource, center: readonly number[], levels: BandLevels): StudentContrast | null {
  const x = codeLevels(model.specs, levels);
  if (!x) return null;
  const c = x.map((v, k) => v - center[k]!);
  const delta = c.reduce((s, v, k) => s + v * model.beta[k]!, 0);
  const variance = Math.max(quadraticForm(c, model.covSandwich), quadraticForm(c, model.covPosterior));
  const columns = bandColumns(model.specs);
  const perFeature = model.specs.map((spec) => {
    const part = c.map((v, k) => (columns[k]!.feature === spec.key ? v : 0));
    const contribution = part.reduce((s, v, k) => s + v * model.beta[k]!, 0);
    const v = Math.max(quadraticForm(part, model.covSandwich), quadraticForm(part, model.covPosterior));
    return { feature: spec.key, contribution, sd: Math.sqrt(Math.max(0, v)) };
  });
  return { delta, sd: Math.sqrt(Math.max(0, variance)), perFeature };
}

/** Pool-calibrated probability for a held-out applicant (offline evaluation only). */
export function bandProbability(fit: BandModelFit, programId: string, levels: BandLevels): number | null {
  const program = fit.programs.find((p) => p.programId === programId);
  const x = codeLevels(fit.specs, levels);
  if (!program || !x) return null;
  let eta = program.alphaStar;
  x.forEach((v, k) => (eta += fit.beta[k]! * (v - program.center[k]!)));
  return expit(eta);
}

/**
 * Held-out reporter cells as scored items that stand for the applicant pool: admits weighted by
 * τ/ȳ and others by (1 − τ)/(1 − ȳ) for the completed cycle, clustered by program.
 */
export function heldOutScoredItems(fit: BandModelFit, cells: readonly BandCell[], officialRates: Readonly<Record<string, number>>): Scored[] {
  const byProgram = new Map<string, BandCell[]>();
  for (const c of cells) byProgram.set(c.programId, [...(byProgram.get(c.programId) ?? []), c]);
  const items: Scored[] = [];
  for (const [programId, list] of [...byProgram.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const tau = officialRates[programId];
    const w1 = sumOver(list, (c) => c.passWeight);
    const w0 = sumOver(list, (c) => c.failWeight);
    if (tau === undefined || !(w1 > 0) || !(w0 > 0)) continue;
    const ybar = w1 / (w1 + w0);
    for (const cell of list) {
      const p = bandProbability(fit, programId, cell.levels);
      if (p === null) continue;
      if (cell.passWeight > 0) items.push({ p, y: 1, w: (tau / ybar) * cell.passWeight, cluster: programId });
      if (cell.failWeight > 0) items.push({ p, y: 0, w: ((1 - tau) / (1 - ybar)) * cell.failWeight, cluster: programId });
    }
  }
  return items;
}

export interface BandCalibrationRow {
  readonly band: BandLabel;
  /** Applicant-mix weight of held-out reports in the band. */
  readonly weight: number;
  readonly reports: number;
  /** Weighted observed pass rate (reporters reweighted to the applicant pool). */
  readonly observedRate: number;
  /** Weighted mean pool-calibrated probability. */
  readonly meanPredicted: number;
}

/**
 * The model card's "observed rate per band" on held-out cycles: each held-out cell is assigned
 * the band the contrast rule gives it, and reporters are reweighted to the applicant pool with
 * τ/ȳ and (1 − τ)/(1 − ȳ). Published only per completed cycle, through shared/disclosure.
 */
export function observedRateByBand(fit: BandModelFit, cells: readonly BandCell[], officialRates: Readonly<Record<string, number>>): BandCalibrationRow[] {
  const acc = new Map<BandLabel, { w: number; wy: number; wp: number; n: number }>();
  const byProgram = new Map<string, BandCell[]>();
  for (const c of cells) byProgram.set(c.programId, [...(byProgram.get(c.programId) ?? []), c]);
  for (const [programId, list] of [...byProgram.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const program = fit.programs.find((p) => p.programId === programId);
    const tau = officialRates[programId];
    const w1 = sumOver(list, (c) => c.passWeight);
    const w0 = sumOver(list, (c) => c.failWeight);
    if (!program || tau === undefined || !(w1 > 0) || !(w0 > 0)) continue;
    const ybar = w1 / (w1 + w0);
    for (const cell of list) {
      const contrast = studentContrast(fit, program.center, cell.levels);
      const p = bandProbability(fit, programId, cell.levels);
      if (!contrast || p === null) continue;
      const band = decideBand(contrast.delta, contrast.sd);
      const pass = (tau / ybar) * cell.passWeight;
      const fail = ((1 - tau) / (1 - ybar)) * cell.failWeight;
      const row = acc.get(band) ?? { w: 0, wy: 0, wp: 0, n: 0 };
      row.w += pass + fail;
      row.wy += pass;
      row.wp += (pass + fail) * p;
      row.n += cell.passReports + cell.failReports;
      acc.set(band, row);
    }
  }
  const order: BandLabel[] = ["below_typical", "typical", "above_typical"];
  return order
    .filter((band) => (acc.get(band)?.w ?? 0) > 0)
    .map((band) => {
      const row = acc.get(band)!;
      return { band, weight: row.w, reports: row.n, observedRate: row.wy / row.w, meanPredicted: row.wp / row.w };
    });
}

/** Applicant-mix share of held-out cells that would get a non-typical band (the usefulness check). */
export function nonTypicalShare(fit: BandModelFit, cells: readonly BandCell[]): number {
  let total = 0;
  let flagged = 0;
  for (const cell of cells) {
    const program = fit.programs.find((p) => p.programId === cell.programId);
    if (!program) continue;
    const contrast = studentContrast(fit, program.center, cell.levels);
    if (!contrast) continue;
    const mass = cell.passWeight + cell.failWeight;
    total += mass;
    if (decideBand(contrast.delta, contrast.sd) !== "typical") flagged += mass;
  }
  return total > 0 ? flagged / total : 0;
}

// ---------------------------------------------------------------------------------------------
// The stored, approved model (band_models) and the decision for one student.
// ---------------------------------------------------------------------------------------------

const MatrixSchema = z.array(z.array(z.number()));

export const BandModelSchema = z
  .object({
    modelVersion: z.string().min(1).max(40),
    opportunityType: z.string().min(1).max(60),
    fromStage: CountStageSchema,
    toStage: CountStageSchema,
    cycles: z.array(z.number().int()).max(10),
    specs: z.array(BandFeatureSpecSchema).min(1).max(3),
    beta: z.array(z.number()),
    covSandwich: MatrixSchema,
    covPosterior: MatrixSchema,
    programs: z.array(
      z
        .object({
          programId: z.string().min(1).max(80),
          center: z.array(z.number()),
          nEff: z.number().nonnegative(),
          passReports: z.number().int().nonnegative(),
          failReports: z.number().int().nonnegative(),
          kingZengLogitGap: z.number(),
          eligible: z.boolean(),
        })
        .strict(),
    ),
    cellReports: z.record(z.number().int().nonnegative()),
    nEffPooled: z.number().nonnegative(),
    gates: z
      .object({
        pooled: z.boolean(),
        heldOut: z.enum(["pass", "fail_skill", "fail_calibration", "not_evaluated"]),
        representativeness: z.boolean(),
        fairness: z.boolean(),
        usefulness: z.boolean(),
        /** Founder approval of the model card after one shadow cycle (band_model_approval). */
        approved: z.boolean(),
      })
      .strict(),
    methodologyUrl: UrlSchema.nullable(),
  })
  .strict()
  .superRefine((m, ctx) => {
    const p = bandColumns(m.specs).length;
    const square = (x: number[][]) => x.length === p && x.every((r) => r.length === p);
    if (m.beta.length !== p || !square(m.covSandwich) || !square(m.covPosterior)) {
      ctx.addIssue({ code: "custom", path: ["beta"], message: "coefficients and covariances must match the coded columns" });
    }
    if (m.programs.some((pr) => pr.center.length !== p)) ctx.addIssue({ code: "custom", path: ["programs"], message: "center length mismatch" });
  });
export type BandModel = z.infer<typeof BandModelSchema>;

export interface BandModelMeta {
  readonly modelVersion: string;
  readonly opportunityType: string;
  readonly fromStage: BandModel["fromStage"];
  readonly toStage: BandModel["toStage"];
  readonly cycles: readonly number[];
  readonly gates: Omit<BandModel["gates"], "pooled">;
  readonly methodologyUrl: string | null;
}

/** The serializable model the bands job stores and readiness reads. */
export function toBandModel(fit: BandModelFit, meta: BandModelMeta): BandModel {
  return {
    modelVersion: meta.modelVersion,
    opportunityType: meta.opportunityType,
    fromStage: meta.fromStage,
    toStage: meta.toStage,
    cycles: [...meta.cycles],
    specs: fit.specs.map((s) => ({ ...s, levels: [...s.levels] })),
    beta: [...fit.beta],
    covSandwich: fit.covSandwich.map((r) => [...r]),
    covPosterior: fit.covPosterior.map((r) => [...r]),
    programs: fit.programs.map((p) => ({
      programId: p.programId,
      center: [...p.center],
      nEff: p.nEff,
      passReports: p.passReports,
      failReports: p.failReports,
      kingZengLogitGap: p.kingZengLogitGap,
      eligible: p.eligible,
    })),
    cellReports: { ...fit.cellReports },
    nEffPooled: fit.pooled.nEff,
    gates: { pooled: fit.pooled.passes, ...meta.gates },
    methodologyUrl: meta.methodologyUrl,
  };
}

export type BandOutcome =
  | {
      readonly kind: "band";
      readonly band: BandLabel;
      readonly factors: readonly CompetitivenessFactor[];
      readonly nEff: number;
      /** True when the student's feature cell was too small to show anything but "typical". */
      readonly smallCell: boolean;
    }
  | { readonly kind: "same_for_everyone"; readonly nEff: number }
  | { readonly kind: "official_odds_only"; readonly failures: readonly string[] }
  | { readonly kind: "insufficient_data"; readonly reason: "too_few_reports" | "profile_incomplete" };

const FACTOR_LABELS: Record<BandFeatureKey, string> = {
  class_standing: "Your class standing",
  gpa_band: "Your GPA band",
  prior_program: "An earlier summer research, insight or leadership program",
};

/** Direction-only factors: a feature counts when its own 80% interval excludes zero. */
function factorsFor(contrast: StudentContrast): CompetitivenessFactor[] {
  return contrast.perFeature.map((f) => {
    const helps = f.contribution - Z80 * f.sd > 0;
    const hurts = f.contribution + Z80 * f.sd < 0;
    return {
      code: `BAND_FACTOR_${f.feature.toUpperCase()}`,
      label: FACTOR_LABELS[f.feature],
      direction: helps ? "helps" : hurts ? "hurts" : "neutral",
    } as const;
  });
}

/**
 * The band for one student, or why there is none. Order matters: model-level gates first
 * (a failed calibration shows official odds only; failed skill or usefulness shows "same for
 * everyone"), then the program's own gates, then the profile, then the disclosure rule.
 */
export function bandForStudent(model: BandModel, programId: string, levels: BandLevels): BandOutcome {
  const { gates } = model;
  const failures: string[] = [];
  if (!gates.approved) failures.push("not_approved");
  if (!gates.pooled) failures.push("pooled_sample_size");
  if (!gates.representativeness) failures.push("representativeness");
  if (!gates.fairness) failures.push("fairness");
  if (gates.heldOut === "fail_calibration" || gates.heldOut === "not_evaluated") failures.push(`held_out_${gates.heldOut}`);
  if (failures.length > 0) return { kind: "official_odds_only", failures };

  const program = model.programs.find((p) => p.programId === programId);
  if (!program || !program.eligible) return { kind: "insufficient_data", reason: "too_few_reports" };
  if (gates.heldOut === "fail_skill" || !gates.usefulness) return { kind: "same_for_everyone", nEff: program.nEff };

  const contrast = studentContrast(model, program.center, levels);
  const cell = bandCellKey(model.specs, levels);
  if (!contrast || cell === null) return { kind: "insufficient_data", reason: "profile_incomplete" };
  // Disclosure: a rare feature combination could point at a named winner, so it reads "typical".
  if ((model.cellReports[cell] ?? 0) < READINESS_CONFIG.bands.minCellReports) {
    return { kind: "band", band: "typical", factors: [], nEff: program.nEff, smallCell: true };
  }
  const band = decideBand(contrast.delta, contrast.sd);
  return { kind: "band", band, factors: band === "typical" ? [] : factorsFor(contrast), nEff: program.nEff, smallCell: false };
}

/** Feature levels from the non-sensitive profile fields the allowlist names, and nothing else. */
export function bandLevelsFromProfile(profile: {
  readonly classYear?: string | null;
  readonly gpaBand?: string | null;
  readonly priorExperience?: readonly string[] | null;
}): BandLevels {
  const levels: Partial<Record<BandFeatureKey, string>> = {};
  if (profile.classYear) levels.class_standing = profile.classYear;
  if (profile.gpaBand && profile.gpaBand !== "none_yet" && profile.gpaBand !== "prefer_not") levels.gpa_band = profile.gpaBand;
  // Null means the student has not answered, which is not the same as "no".
  const experience = profile.priorExperience;
  if (experience) levels.prior_program = experience.some((k) => (PRIOR_PROGRAM_KINDS as readonly string[]).includes(k)) ? "yes" : "no";
  return levels;
}

/** Coefficients rounded to 0.05 for the public model card (published once per completed cycle). */
export function modelCardCoefficients(model: Pick<BandModel, "specs" | "beta">): { readonly column: string; readonly coefficient: number }[] {
  return bandColumns(model.specs).map((c, k) => ({ column: c.name, coefficient: Math.round(model.beta[k]! / 0.05) * 0.05 }));
}
