import { READINESS_CONFIG } from "./config";
import { jeffreysInterval } from "./math/intervals";
import { betaQuantile, digamma, log1pExp, logBeta, trigamma } from "./math/special";

/**
 * Pooling stage rates across similar programs (same OpportunityType and stage), for rates that
 * come from verified Outcome reports. These rates are selection-biased (admits report more), so
 * they are never displayed as a program's odds; they serve as priors for unannounced cycles and
 * for applicant bounds, and official counts are never shrunk (plan D2).
 *
 * Model (BDA3 ch. 5): k_j ~ Bin(n_j, p_j), p_j ~ Beta(μM, (1 − μ)M), p(a, b) ∝ (a + b)^(−5/2),
 * which is p(μ, log M) ∝ M^(−1/2). The hyperposterior is evaluated on a 60 × 60 grid over
 * μ ∈ (0, 1) and log M ∈ [−1, 8]; p_j's posterior is the grid-weighted mixture of
 * Beta(a + k_j, b + n_j − k_j). A plug-in empirical-Bayes fit (hyperparameters treated as known)
 * is also provided for comparison: it covered only 0.68 of the time for a nominal 0.80 in the
 * study simulation, which is why the full hierarchy is the default.
 */

export interface PoolGroup {
  readonly id: string;
  /** Successes; may be fractional after tier weighting (k* = Σw·y · n_eff / Σw). */
  readonly k: number;
  /** Trials; Kish's n_eff after tier weighting. */
  readonly n: number;
}

export interface PooledEstimate {
  readonly id: string;
  readonly k: number;
  readonly n: number;
  readonly mean: number;
  readonly lo: number;
  readonly hi: number;
  readonly method: "pooled" | "jeffreys" | "empirical_bayes";
  /** Leave-one-out posterior-predictive two-sided p-value for k_j; null when not computed. */
  readonly conflictP: number | null;
}

export interface HierarchicalResult {
  /** False when fewer than the minimum number of programs exist (every estimate is Jeffreys). */
  readonly pooled: boolean;
  readonly hyper: { readonly muMean: number; readonly logMMean: number } | null;
  readonly groups: readonly PooledEstimate[];
}

/** Kish's effective sample size (Σw)² / Σw². */
export function kishEffectiveSize(weights: readonly number[]): number {
  let s = 0;
  let s2 = 0;
  for (const w of weights) {
    if (!(w > 0)) continue;
    s += w;
    s2 += w * w;
  }
  return s2 > 0 ? (s * s) / s2 : 0;
}

/** Tier-weighted counts rescaled to the effective size: n* = n_eff, k* = Σw·y · n_eff / Σw. */
export function weightedStageCounts(reports: readonly { readonly weight: number; readonly passed: boolean }[]): {
  readonly nEff: number;
  readonly kStar: number;
  readonly nStar: number;
  readonly ybar: number;
} {
  const weights = reports.map((r) => r.weight);
  const nEff = kishEffectiveSize(weights);
  const sw = reports.reduce((s, r) => s + (r.weight > 0 ? r.weight : 0), 0);
  const swy = reports.reduce((s, r) => s + (r.weight > 0 && r.passed ? r.weight : 0), 0);
  const ybar = sw > 0 ? swy / sw : 0;
  return { nEff, kStar: ybar * nEff, nStar: nEff, ybar };
}

interface Grid {
  readonly a: Float64Array;
  readonly b: Float64Array;
  readonly mu: Float64Array;
  readonly logM: Float64Array;
  readonly logPrior: Float64Array;
}

function buildGrid(gridMu: number, gridLogM: number, range: readonly [number, number]): Grid {
  const size = gridMu * gridLogM;
  const a = new Float64Array(size);
  const b = new Float64Array(size);
  const mu = new Float64Array(size);
  const logM = new Float64Array(size);
  const logPrior = new Float64Array(size);
  let g = 0;
  for (let i = 0; i < gridMu; i++) {
    const m = (i + 0.5) / gridMu;
    for (let j = 0; j < gridLogM; j++) {
      const lm = range[0] + ((j + 0.5) * (range[1] - range[0])) / gridLogM;
      const M = Math.exp(lm);
      a[g] = m * M;
      b[g] = (1 - m) * M;
      mu[g] = m;
      logM[g] = lm;
      logPrior[g] = -0.5 * lm;
      g++;
    }
  }
  return { a, b, mu, logM, logPrior };
}

function normalizeLogWeights(logW: Float64Array): Float64Array {
  let max = -Infinity;
  for (const v of logW) if (v > max) max = v;
  const w = new Float64Array(logW.length);
  let total = 0;
  for (let g = 0; g < logW.length; g++) {
    const v = Math.exp(logW[g]! - max);
    w[g] = v;
    total += v;
  }
  for (let g = 0; g < w.length; g++) w[g] = w[g]! / total;
  return w;
}

/** Indices whose weight exceeds `floor` (weights are normalized, so the dropped mass is tiny). */
function heavyIndices(w: Float64Array, floor: number): number[] {
  const out: number[] = [];
  for (let g = 0; g < w.length; g++) if (w[g]! > floor) out.push(g);
  return out;
}

/** The fewest indices carrying all but `tail` of the mass, in index order. */
function massIndices(w: Float64Array, tail: number): number[] {
  const order = Array.from({ length: w.length }, (_, i) => i).sort((x, y) => w[y]! - w[x]! || x - y);
  const keep: number[] = [];
  let cum = 0;
  for (const g of order) {
    if (cum >= 1 - tail) break;
    keep.push(g);
    cum += w[g]!;
  }
  return keep.sort((x, y) => x - y);
}

/**
 * Quantiles and mean of a Beta mixture Σ w_c Beta(A_c, B_c). The density of logit(p) has no
 * endpoint singularities, so it is integrated on a logit grid spanning ±8 sd of every component
 * that carries weight (exact logit-Beta moments ψ(A) − ψ(B), ψ'(A) + ψ'(B)), with Simpson's rule
 * per cell. Inside a cell the density is the quadratic through its ends and midpoint, so the CDF
 * is a cubic that Newton's method inverts.
 */
export function betaMixtureSummary(
  components: readonly { readonly w: number; readonly A: number; readonly B: number }[],
  probs: readonly number[],
  cells = 128,
): { readonly mean: number; readonly quantiles: number[] } {
  const total = components.reduce((s, c) => s + c.w, 0);
  const comps = components.map((c) => ({ ...c, w: c.w / total, logB: logBeta(c.A, c.B) }));
  const mean = comps.reduce((s, c) => s + (c.w * c.A) / (c.A + c.B), 0);
  let uLo = Infinity;
  let uHi = -Infinity;
  for (const c of comps) {
    if (c.w < 1e-5) continue; // a component this light cannot move a 10% or 90% quantile
    const m = digamma(c.A) - digamma(c.B);
    const s = Math.sqrt(trigamma(c.A) + trigamma(c.B));
    uLo = Math.min(uLo, m - 8 * s);
    uHi = Math.max(uHi, m + 8 * s);
  }
  if (!(uLo < uHi)) {
    uLo = -10;
    uHi = 10;
  }
  uLo = Math.max(-35, uLo);
  uHi = Math.min(35, uHi);
  const h = (uHi - uLo) / cells;
  const densityAt = (u: number): number => {
    const logX = -log1pExp(-u);
    const log1mX = -log1pExp(u);
    let f = 0;
    for (const c of comps) f += c.w * Math.exp(c.A * logX + c.B * log1mX - c.logB);
    return f;
  };
  const node = new Float64Array(cells + 1);
  const mid = new Float64Array(cells);
  for (let i = 0; i <= cells; i++) node[i] = densityAt(uLo + i * h);
  for (let i = 0; i < cells; i++) mid[i] = densityAt(uLo + (i + 0.5) * h);
  const cdf = new Float64Array(cells + 1);
  for (let i = 0; i < cells; i++) cdf[i + 1] = cdf[i]! + (h / 6) * (node[i]! + 4 * mid[i]! + node[i + 1]!);
  const mass = Math.max(1e-300, cdf[cells]!);
  const quantiles = probs.map((q) => {
    const target = Math.min(1, Math.max(0, q)) * mass;
    let i = 0;
    while (i < cells - 1 && cdf[i + 1]! < target) i++;
    // Density on the cell: f(t) = d0 + B t + C t², t ∈ [0, h]; CDF G(t) = d0 t + B t²/2 + C t³/3.
    const d0 = node[i]!;
    const dm = mid[i]!;
    const d1 = node[i + 1]!;
    const B = (-3 * d0 + 4 * dm - d1) / h;
    const C = (2 * d0 - 4 * dm + 2 * d1) / (h * h);
    const need = target - cdf[i]!;
    const cellMass = cdf[i + 1]! - cdf[i]!;
    let t = cellMass > 0 ? (need / cellMass) * h : 0;
    for (let iter = 0; iter < 20; iter++) {
      const g = d0 * t + (B * t * t) / 2 + (C * t * t * t) / 3 - need;
      const f = Math.max(1e-300, d0 + B * t + C * t * t);
      const next = Math.min(h, Math.max(0, t - g / f));
      if (Math.abs(next - t) < 1e-13 * h) {
        t = next;
        break;
      }
      t = next;
    }
    return 1 / (1 + Math.exp(-(uLo + i * h + t)));
  });
  return { mean, quantiles };
}

/**
 * Beta-binomial pmf for k = 0..n under (a, b), by the ratio recurrence (no per-term lgamma).
 * The whole recurrence runs in log space: at high-rate grid points (large a, small b) the k = 0
 * term is far below the smallest double (ln p0 ≈ −1000), so a linear-space product restarted
 * from an underflowed value would rescale the pmf by orders of magnitude. The result is then
 * normalized by log-sum-exp, which also absorbs the small rounding the n additions accumulate.
 */
export function betaBinomialPmf(n: number, a: number, b: number, logBetaAB: number = logBeta(a, b)): Float64Array {
  const logPmf = new Float64Array(n + 1);
  let logP = logBeta(a, b + n) - logBetaAB;
  logPmf[0] = logP;
  let max = logP;
  for (let k = 0; k < n; k++) {
    logP += Math.log(n - k) - Math.log(k + 1) + Math.log(k + a) - Math.log(n - k - 1 + b);
    logPmf[k + 1] = logP;
    if (logP > max) max = logP;
  }
  const pmf = new Float64Array(n + 1);
  let total = 0;
  for (let k = 0; k <= n; k++) {
    const v = Math.exp(logPmf[k]! - max);
    pmf[k] = v;
    total += v;
  }
  for (let k = 0; k <= n; k++) pmf[k] = pmf[k]! / total;
  return pmf;
}

/** Two-sided posterior-predictive p-value of k under a weighted set of (a, b) grid points. */
function predictiveConflictP(k: number, n: number, weights: Float64Array, grid: Grid, logBetaAB: Float64Array): number {
  const kk = Math.round(k);
  const nn = Math.max(kk, Math.round(n));
  const pmf = new Float64Array(nn + 1);
  // Points below 1e-8 carry at most 3.6e-5 of the mass in total: irrelevant at a 0.05 cut-off.
  for (const g of heavyIndices(weights, 1e-8)) {
    const comp = betaBinomialPmf(nn, grid.a[g]!, grid.b[g]!, logBetaAB[g]!);
    const w = weights[g]!;
    for (let i = 0; i <= nn; i++) pmf[i] = pmf[i]! + w * comp[i]!;
  }
  let lower = 0;
  let upper = 0;
  for (let i = 0; i <= nn; i++) {
    if (i <= kk) lower += pmf[i]!;
    if (i >= kk) upper += pmf[i]!;
  }
  return Math.min(1, 2 * Math.min(lower, upper));
}

function jeffreysEstimate(g: PoolGroup, level: number, conflictP: number | null): PooledEstimate {
  const interval = jeffreysInterval(g.k, g.n, level);
  return { id: g.id, k: g.k, n: g.n, mean: (g.k + 0.5) / (g.n + 1), lo: interval.lo, hi: interval.hi, method: "jeffreys", conflictP };
}

export interface HierarchicalOptions {
  readonly gridMu?: number;
  readonly gridLogM?: number;
  readonly logMRange?: readonly [number, number];
  readonly level?: number;
  readonly minGroups?: number;
  /** Programs whose leave-one-out predictive p-value falls below this are not pooled. */
  readonly conflictAlpha?: number;
}

/**
 * Full hierarchical beta-binomial over a type × stage with a prior-data conflict check: a program
 * that the other programs' leave-one-out hyperposterior finds implausible (two-sided predictive
 * p < 0.05) gets its own Jeffreys interval instead of being shrunk toward its peers. The
 * hyperposterior keeps every program: dropping the flagged ones would understate the spread
 * between programs and narrow everyone else's intervals (in simulation, coverage fell from 0.78
 * to 0.70 at 20 programs when flagged programs were refitted out).
 */
export function hierarchicalBetaBinomial(input: readonly PoolGroup[], opts: HierarchicalOptions = {}): HierarchicalResult {
  const cfg = READINESS_CONFIG.pooling;
  const level = opts.level ?? cfg.level;
  const minGroups = opts.minGroups ?? cfg.minGroups;
  const alpha = opts.conflictAlpha ?? cfg.conflictAlpha;
  const groups = input
    .filter((g) => Number.isFinite(g.k) && Number.isFinite(g.n) && g.n > 0 && g.k >= 0 && g.k <= g.n)
    .slice()
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  if (groups.length < minGroups) {
    return { pooled: false, hyper: null, groups: groups.map((g) => jeffreysEstimate(g, level, null)) };
  }
  const grid = buildGrid(opts.gridMu ?? cfg.gridMu, opts.gridLogM ?? cfg.gridLogM, opts.logMRange ?? cfg.logMRange);
  const size = grid.a.length;
  const logBetaAB = new Float64Array(size);
  for (let g = 0; g < size; g++) logBetaAB[g] = logBeta(grid.a[g]!, grid.b[g]!);
  // ll[j][g] = ln B(a + k_j, b + n_j − k_j) − ln B(a, b): program j's marginal likelihood at grid point g.
  const ll = groups.map((grp) => {
    const row = new Float64Array(size);
    for (let g = 0; g < size; g++) row[g] = logBeta(grid.a[g]! + grp.k, grid.b[g]! + grp.n - grp.k) - logBetaAB[g]!;
    return row;
  });
  const logFull = new Float64Array(size);
  for (let g = 0; g < size; g++) {
    let v = grid.logPrior[g]!;
    for (const row of ll) v += row[g]!;
    logFull[g] = v;
  }
  const conflictP = groups.map((grp, j) => {
    const loo = new Float64Array(size);
    for (let g = 0; g < size; g++) loo[g] = logFull[g]! - ll[j]![g]!;
    return predictiveConflictP(grp.k, grp.n, normalizeLogWeights(loo), grid, logBetaAB);
  });
  const weights = normalizeLogWeights(logFull);
  const heavy = massIndices(weights, 1e-6);

  let muMean = 0;
  let logMMean = 0;
  for (let g = 0; g < size; g++) {
    muMean += weights[g]! * grid.mu[g]!;
    logMMean += weights[g]! * grid.logM[g]!;
  }
  const tail = (1 - level) / 2;
  const estimates = groups.map((grp, j): PooledEstimate => {
    if (conflictP[j]! < alpha) return jeffreysEstimate(grp, level, conflictP[j]!);
    const comps = heavy.map((g) => ({ w: weights[g]!, A: grid.a[g]! + grp.k, B: grid.b[g]! + grp.n - grp.k }));
    const summary = betaMixtureSummary(comps, [tail, 1 - tail]);
    return { id: grp.id, k: grp.k, n: grp.n, mean: summary.mean, lo: summary.quantiles[0]!, hi: summary.quantiles[1]!, method: "pooled", conflictP: conflictP[j]! };
  });
  return { pooled: true, hyper: { muMean, logMMean }, groups: estimates };
}

/**
 * Plug-in empirical Bayes by weighted method of moments (Kleinman 1973), for comparison and
 * fast diagnostics only: it treats the estimated (a, b) as known, so its intervals undercover.
 */
export function empiricalBayesBetaBinomial(input: readonly PoolGroup[], level = 0.8): PooledEstimate[] {
  const groups = input.filter((g) => g.n > 0 && g.k >= 0 && g.k <= g.n);
  if (groups.length === 0) return [];
  const totalN = groups.reduce((s, g) => s + g.n, 0);
  const m = groups.reduce((s, g) => s + g.k, 0) / totalN;
  const S = groups.reduce((s, g) => s + g.n * (g.k / g.n - m) ** 2, 0);
  const denom = totalN - groups.reduce((s, g) => s + g.n * g.n, 0) / totalN;
  const mm = Math.max(1e-6, m * (1 - m));
  let rho = denom > 0 ? (S - mm * (groups.length - 1)) / (mm * denom) : 0.999;
  rho = Math.min(0.999, Math.max(1e-3, rho));
  const M = (1 - rho) / rho;
  const a = Math.max(1e-6, m * M);
  const b = Math.max(1e-6, (1 - m) * M);
  const tail = (1 - level) / 2;
  return groups.map((g) => ({
    id: g.id,
    k: g.k,
    n: g.n,
    mean: (a + g.k) / (a + b + g.n),
    lo: betaQuantile(tail, a + g.k, b + g.n - g.k),
    hi: betaQuantile(1 - tail, a + g.k, b + g.n - g.k),
    method: "empirical_bayes" as const,
    conflictP: null,
  }));
}
