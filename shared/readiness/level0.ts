import { READINESS_CONFIG } from "./config";
import { wilsonInterval, type Interval } from "./math/intervals";
import { expit, logit, normalQuantile } from "./math/special";

/**
 * Level 0: next-cycle official odds from past official counts (plan 7.5.4), a random-effects
 * logit with recency weights. Program-level only, shown on the Program page once the
 * forward-chaining gate passes; readiness never turns it into a number about a student.
 *
 *   ℓ_y = logit((k + 0.5)/(n + 1)),   v_y = 1/(k + 0.5) + 1/(n − k + 0.5)
 *   τ²  = max(0, pooled within-program variance of ℓ − mean v)   (programs with 3+ cycles; else 0.09)
 *   w_y = 0.7^age / (τ² + v_y),       θ̂ = Σ w ℓ / Σ w,   Var θ̂ = Σ w²(τ² + v) / (Σ w)²
 *   v_next = 1 / (n̂ p̂ (1 − p̂)),      next ~ N(θ̂, Var θ̂ + τ² + v_next)
 *   80% interval: expit(θ̂ ± q·sd), q = 1.2816, or the split-conformal quantile once 60+ forecasts exist.
 */

export interface StageHistoryPoint {
  readonly cycleYear: number;
  readonly k: number;
  readonly n: number;
}

export interface LevelZeroForecast {
  readonly thetaHat: number;
  readonly varTheta: number;
  readonly tau2: number;
  readonly vNext: number;
  readonly predictiveSd: number;
  /** Quantile multiplier used (normal or conformal). */
  readonly q: number;
  readonly p50: number;
  readonly lo: number;
  readonly hi: number;
  /** The plain historical range shown first, with no gate. */
  readonly range: { readonly minRate: number; readonly maxRate: number; readonly firstYear: number; readonly lastYear: number };
}

export function empiricalLogit(k: number, n: number): number {
  return logit((k + 0.5) / (n + 1));
}

export function empiricalLogitVariance(k: number, n: number): number {
  return 1 / (k + 0.5) + 1 / (n - k + 0.5);
}

function validPoints(history: readonly StageHistoryPoint[]): StageHistoryPoint[] {
  return history
    .filter((h) => Number.isFinite(h.k) && Number.isFinite(h.n) && h.n > 0 && h.k >= 0 && h.k <= h.n)
    .slice()
    .sort((a, b) => a.cycleYear - b.cycleYear);
}

/**
 * τ² from programs with at least `minCycles` cycles: the pooled within-program variance of the
 * empirical logits minus their mean sampling variance; null when no program qualifies.
 */
export function pooledTau2(programs: readonly (readonly StageHistoryPoint[])[], minCycles: number = READINESS_CONFIG.level0.minCyclesForTau2): number | null {
  let ss = 0;
  let df = 0;
  let vSum = 0;
  let vCount = 0;
  for (const raw of programs) {
    const pts = validPoints(raw);
    if (pts.length < minCycles) continue;
    const ls = pts.map((p) => empiricalLogit(p.k, p.n));
    const mean = ls.reduce((s, l) => s + l, 0) / ls.length;
    ss += ls.reduce((s, l) => s + (l - mean) ** 2, 0);
    df += ls.length - 1;
    for (const p of pts) {
      vSum += empiricalLogitVariance(p.k, p.n);
      vCount += 1;
    }
  }
  if (df === 0) return null;
  return Math.max(0, ss / df - vSum / vCount);
}

export interface LevelZeroOptions {
  /** τ² from pooledTau2, else the 0.09 fallback (half-normal prior, sd 0.3 on the logit scale). */
  readonly tau2?: number | null;
  readonly decay?: number;
  readonly level?: number;
  /** Split-conformal quantile replacing the normal multiplier once enough forecasts exist. */
  readonly conformalQ?: number | null;
  /** Expected next pool size; defaults to the latest one. */
  readonly nextPoolSize?: number | null;
}

/** The next-cycle forecast from a program's past official counts, or null with no history. */
export function levelZeroForecast(history: readonly StageHistoryPoint[], opts: LevelZeroOptions = {}): LevelZeroForecast | null {
  const pts = validPoints(history);
  if (pts.length === 0) return null;
  const cfg = READINESS_CONFIG.level0;
  const tau2 = opts.tau2 ?? cfg.tau2Fallback;
  const decay = opts.decay ?? cfg.decay;
  const newest = pts[pts.length - 1]!.cycleYear;
  let sw = 0;
  let swl = 0;
  let sw2v = 0;
  for (const p of pts) {
    const v = empiricalLogitVariance(p.k, p.n);
    const w = Math.pow(decay, newest - p.cycleYear) / (tau2 + v);
    sw += w;
    swl += w * empiricalLogit(p.k, p.n);
    sw2v += w * w * (tau2 + v);
  }
  const thetaHat = swl / sw;
  const varTheta = sw2v / (sw * sw);
  const pHat = expit(thetaHat);
  const nHat = Math.max(1, opts.nextPoolSize ?? pts[pts.length - 1]!.n);
  const vNext = 1 / (nHat * pHat * (1 - pHat));
  const predictiveSd = Math.sqrt(varTheta + tau2 + vNext);
  const level = opts.level ?? cfg.level;
  const q = opts.conformalQ ?? normalQuantile(0.5 + level / 2);
  const rates = pts.map((p) => p.k / p.n);
  return {
    thetaHat,
    varTheta,
    tau2,
    vNext,
    predictiveSd,
    q,
    p50: pHat,
    lo: expit(thetaHat - q * predictiveSd),
    hi: expit(thetaHat + q * predictiveSd),
    range: { minRate: Math.min(...rates), maxRate: Math.max(...rates), firstYear: pts[0]!.cycleYear, lastYear: newest },
  };
}

export interface ForwardForecast {
  readonly programId: string;
  readonly cycleYear: number;
  readonly observedRate: number;
  readonly lo: number;
  readonly hi: number;
  readonly covered: boolean;
  /** (ℓ_t − θ̂) / sd_t, the standardized residual used for conformal calibration. */
  readonly standardizedResidual: number;
  readonly absError: number;
}

/**
 * Forward chaining: for each program and each year from its third on, fit on earlier years and
 * forecast that year. Leave-one-year-out is not used: it would forecast from later years and
 * hide drift such as growing pools.
 */
export function forwardChainLevelZero(
  programs: readonly { readonly id: string; readonly history: readonly StageHistoryPoint[] }[],
  opts: LevelZeroOptions = {},
): ForwardForecast[] {
  const out: ForwardForecast[] = [];
  for (const program of [...programs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const pts = validPoints(program.history);
    for (let t = 2; t < pts.length; t++) {
      const target = pts[t]!;
      const forecast = levelZeroForecast(pts.slice(0, t), { ...opts, nextPoolSize: target.n });
      if (!forecast) continue;
      const observed = target.k / target.n;
      out.push({
        programId: program.id,
        cycleYear: target.cycleYear,
        observedRate: observed,
        lo: forecast.lo,
        hi: forecast.hi,
        covered: observed >= forecast.lo && observed <= forecast.hi,
        standardizedResidual: (empiricalLogit(target.k, target.n) - forecast.thetaHat) / forecast.predictiveSd,
        absError: Math.abs(observed - forecast.p50),
      });
    }
  }
  return out;
}

/**
 * Split-conformal multiplier: the ⌈(m + 1)·level⌉-th smallest |z| of m held-out standardized
 * residuals, which gives distribution-free marginal coverage (Angelopoulos and Bates).
 * Infinity when m is too small for the requested level.
 */
export function conformalQuantile(absResiduals: readonly number[], level = 0.8): number {
  const sorted = absResiduals.map((r) => Math.abs(r)).filter((r) => Number.isFinite(r)).sort((a, b) => a - b);
  const rank = Math.ceil((sorted.length + 1) * level);
  return rank <= sorted.length ? sorted[rank - 1]! : Infinity;
}

export interface CoverageGate {
  readonly n: number;
  readonly covered: number;
  readonly coverage: number;
  readonly wilson90: Interval;
  readonly passes: boolean;
}

/**
 * The display gate for the 80% next-cycle interval: at least 60 pooled forecasts, coverage in
 * [0.70, 0.90] and 0.80 inside the 90% Wilson interval.
 */
export function levelZeroGate(forecasts: readonly Pick<ForwardForecast, "covered">[]): CoverageGate {
  const cfg = READINESS_CONFIG.level0;
  const n = forecasts.length;
  const covered = forecasts.filter((f) => f.covered).length;
  const coverage = n > 0 ? covered / n : 0;
  const wilson90 = wilsonInterval(covered, n, 0.9);
  const passes =
    n >= cfg.minPooledForecasts &&
    coverage >= cfg.coverageBand[0] &&
    coverage <= cfg.coverageBand[1] &&
    wilson90.lo <= cfg.level &&
    wilson90.hi >= cfg.level;
  return { n, covered, coverage, wilson90, passes };
}
