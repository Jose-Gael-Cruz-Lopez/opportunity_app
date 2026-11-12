import { READINESS_CONFIG } from "./config";
import { spdInverse } from "./math/linalg";
import { createRng } from "./math/random";
import { clampProbability, expit, log1pExp, logit } from "./math/special";

/**
 * Offline evaluation of probability forecasts (the band model's pool-calibrated probabilities on
 * held-out cycles). Nothing here runs on a student's request and nothing here is shown to a
 * student; model cards publish aggregates only.
 *
 *   Brier            BS = Σ w (p − y)² / Σ w
 *   Skill            BSS = 1 − BS / BS_ref, with the official stage rate τ as everyone's forecast
 *   CORP             BS = MCB − DSC + UNC using the PAV (isotonic) recalibration (Dimitriadis et al. 2021)
 *   Spiegelhalter    z = Σ w (y − p)(1 − 2p) / √(Σ w² (1 − 2p)² p (1 − p))
 *   Calibration      logit P(y) = a + b·logit p (slope b, weak calibration; Van Calster 2016)
 *   AUC              weighted Mann-Whitney with ties counted half
 * Isotonic regression is for reliability diagrams only: below about 1,000 held-out outcomes it
 * overfits and creates ties, so production recalibration is at most two-parameter Platt scaling.
 */

export interface Scored {
  /** Forecast probability. */
  readonly p: number;
  /** Outcome, 1 or 0. */
  readonly y: number;
  /** Weight (tier × deselection); 1 when omitted. */
  readonly w?: number;
  /** Bootstrap cluster (the program); every item is its own cluster when omitted. */
  readonly cluster?: string;
}

const wOf = (s: Scored): number => (s.w === undefined ? 1 : s.w);

function totalWeight(items: readonly Scored[]): number {
  return items.reduce((s, it) => s + wOf(it), 0);
}

export function brierScore(items: readonly Scored[]): number {
  const tw = totalWeight(items);
  if (tw <= 0) return NaN;
  return items.reduce((s, it) => s + wOf(it) * (it.p - it.y) ** 2, 0) / tw;
}

/** 1 − BS / BS_ref, where the reference forecast is a constant (τ) or a per-item function. */
export function brierSkill(items: readonly Scored[], reference: number | ((s: Scored) => number)): number {
  const ref = typeof reference === "number" ? () => reference : reference;
  const bs = brierScore(items);
  const bsRef = brierScore(items.map((it) => ({ ...it, p: ref(it) })));
  return bsRef > 0 ? 1 - bs / bsRef : NaN;
}

export interface IsotonicBlock {
  readonly pLo: number;
  readonly pHi: number;
  readonly value: number;
  readonly weight: number;
}

/**
 * Pool-adjacent-violators: the non-decreasing step function of y on p that minimizes weighted
 * squared error. Equal forecasts are pooled first so they always get the same value.
 */
export function pavIsotonic(items: readonly Scored[]): { readonly fitted: number[]; readonly blocks: IsotonicBlock[] } {
  const order = items.map((_, i) => i).sort((a, b) => items[a]!.p - items[b]!.p || a - b);
  type Block = { pLo: number; pHi: number; sw: number; swy: number; members: number[] };
  const blocks: Block[] = [];
  for (const i of order) {
    const it = items[i]!;
    const w = wOf(it);
    const last = blocks[blocks.length - 1];
    if (last && last.pHi === it.p) {
      last.sw += w;
      last.swy += w * it.y;
      last.members.push(i);
    } else {
      blocks.push({ pLo: it.p, pHi: it.p, sw: w, swy: w * it.y, members: [i] });
    }
    while (blocks.length >= 2) {
      const cur = blocks[blocks.length - 1]!;
      const prev = blocks[blocks.length - 2]!;
      const prevMean = prev.sw > 0 ? prev.swy / prev.sw : 0;
      const curMean = cur.sw > 0 ? cur.swy / cur.sw : 0;
      // Equal neighbours merge too, so each block is one distinct step of the diagram.
      if (prevMean < curMean) break;
      prev.pHi = cur.pHi;
      prev.sw += cur.sw;
      prev.swy += cur.swy;
      prev.members.push(...cur.members);
      blocks.pop();
    }
  }
  const fitted = new Array<number>(items.length).fill(0);
  for (const b of blocks) {
    const v = b.sw > 0 ? b.swy / b.sw : 0;
    for (const m of b.members) fitted[m] = v;
  }
  return { fitted, blocks: blocks.map((b) => ({ pLo: b.pLo, pHi: b.pHi, value: b.sw > 0 ? b.swy / b.sw : 0, weight: b.sw })) };
}

export interface CorpDecomposition {
  readonly bs: number;
  /** Miscalibration: BS − BS(recalibrated). */
  readonly mcb: number;
  /** Discrimination: BS(climatology) − BS(recalibrated). */
  readonly dsc: number;
  /** Uncertainty: BS(climatology). */
  readonly unc: number;
}

export function corpDecomposition(items: readonly Scored[]): CorpDecomposition {
  const tw = totalWeight(items);
  const ybar = items.reduce((s, it) => s + wOf(it) * it.y, 0) / tw;
  const { fitted } = pavIsotonic(items);
  const bs = brierScore(items);
  const recal = items.reduce((s, it, i) => s + wOf(it) * (fitted[i]! - it.y) ** 2, 0) / tw;
  const unc = items.reduce((s, it) => s + wOf(it) * (ybar - it.y) ** 2, 0) / tw;
  return { bs, mcb: bs - recal, dsc: unc - recal, unc };
}

export interface ReliabilityBin {
  readonly lo: number;
  readonly hi: number;
  readonly meanPredicted: number;
  readonly observedRate: number;
  readonly weight: number;
  readonly count: number;
}

/** Reliability bins by equal-count (quantile) or equal-width edges. */
export function reliabilityBins(items: readonly Scored[], opts: { bins?: number; strategy?: "quantile" | "uniform" } = {}): ReliabilityBin[] {
  const bins = Math.max(1, opts.bins ?? 10);
  const sorted = items.slice().sort((a, b) => a.p - b.p);
  const groups: Scored[][] = Array.from({ length: bins }, () => []);
  if ((opts.strategy ?? "quantile") === "uniform") {
    for (const it of sorted) groups[Math.min(bins - 1, Math.floor(it.p * bins))]!.push(it);
  } else {
    sorted.forEach((it, i) => groups[Math.min(bins - 1, Math.floor((i * bins) / sorted.length))]!.push(it));
  }
  return groups
    .filter((g) => g.length > 0)
    .map((g) => {
      const tw = totalWeight(g);
      return {
        lo: g[0]!.p,
        hi: g[g.length - 1]!.p,
        meanPredicted: g.reduce((s, it) => s + wOf(it) * it.p, 0) / tw,
        observedRate: g.reduce((s, it) => s + wOf(it) * it.y, 0) / tw,
        weight: tw,
        count: g.length,
      };
    });
}

/** Largest |observed − predicted| over bins holding at least `minCount` items. */
export function maxReliabilityGap(bins: readonly ReliabilityBin[], minCount = 1): number {
  return bins.filter((b) => b.count >= minCount).reduce((m, b) => Math.max(m, Math.abs(b.observedRate - b.meanPredicted)), 0);
}

/** Spiegelhalter's z: approximately N(0, 1) when the forecasts are calibrated. */
export function spiegelhalterZ(items: readonly Scored[]): number {
  let num = 0;
  let den = 0;
  for (const it of items) {
    const w = wOf(it);
    const p = clampProbability(it.p);
    num += w * (it.y - p) * (1 - 2 * p);
    den += w * w * (1 - 2 * p) ** 2 * p * (1 - p);
  }
  return den > 0 ? num / Math.sqrt(den) : 0;
}

export interface LogisticCalibration {
  readonly intercept: number;
  readonly slope: number;
  /** Robust (sandwich) standard errors. */
  readonly seIntercept: number;
  readonly seSlope: number;
}

/** Weighted logistic regression of y on logit(p): slope 1 and intercept 0 mean calibrated. */
export function calibrationSlope(items: readonly Scored[]): LogisticCalibration {
  const xs = items.map((it) => logit(clampProbability(it.p, 1e-9)));
  let a = 0;
  let b = 1;
  const ridge = 1e-8;
  let h = [[ridge, 0], [0, ridge]];
  for (let iter = 0; iter < 100; iter++) {
    let g0 = -ridge * a;
    let g1 = -ridge * (b - 1);
    const hh = [[ridge, 0], [0, ridge]];
    items.forEach((it, i) => {
      const w = wOf(it);
      const x = xs[i]!;
      const pr = expit(a + b * x);
      const r = w * (it.y - pr);
      const v = w * pr * (1 - pr);
      g0 += r;
      g1 += r * x;
      hh[0]![0] = hh[0]![0]! + v;
      hh[0]![1] = hh[0]![1]! + v * x;
      hh[1]![1] = hh[1]![1]! + v * x * x;
    });
    hh[1]![0] = hh[0]![1]!;
    h = hh;
    const inv = spdInverse(hh);
    if (!inv) break;
    const da = inv[0]![0]! * g0 + inv[0]![1]! * g1;
    const db = inv[1]![0]! * g0 + inv[1]![1]! * g1;
    a += da;
    b += db;
    if (Math.abs(da) + Math.abs(db) < 1e-10) break;
  }
  const inv = spdInverse(h);
  // Sandwich: H⁻¹ (Σ w² r² u u') H⁻¹ — the weights are not frequency weights.
  const meat = [[0, 0], [0, 0]];
  items.forEach((it, i) => {
    const w = wOf(it);
    const x = xs[i]!;
    const r = it.y - expit(a + b * x);
    const s = w * w * r * r;
    meat[0]![0] = meat[0]![0]! + s;
    meat[0]![1] = meat[0]![1]! + s * x;
    meat[1]![1] = meat[1]![1]! + s * x * x;
  });
  meat[1]![0] = meat[0]![1]!;
  let seIntercept = NaN;
  let seSlope = NaN;
  if (inv) {
    const v = (i: number, j: number): number => {
      let s = 0;
      for (let k = 0; k < 2; k++) for (let l = 0; l < 2; l++) s += inv[i]![k]! * meat[k]![l]! * inv[l]![j]!;
      return s;
    };
    seIntercept = Math.sqrt(Math.max(0, v(0, 0)));
    seSlope = Math.sqrt(Math.max(0, v(1, 1)));
  }
  return { intercept: a, slope: b, seIntercept, seSlope };
}

/** Calibration-in-the-large: the intercept of logit P(y) = a + logit p (logit p as an offset). */
export function calibrationInTheLarge(items: readonly Scored[]): number {
  const xs = items.map((it) => logit(clampProbability(it.p, 1e-9)));
  let a = 0;
  for (let iter = 0; iter < 100; iter++) {
    let g = 0;
    let h = 1e-12;
    items.forEach((it, i) => {
      const w = wOf(it);
      const pr = expit(a + xs[i]!);
      g += w * (it.y - pr);
      h += w * pr * (1 - pr);
    });
    const step = g / h;
    a += step;
    if (Math.abs(step) < 1e-12) break;
  }
  return a;
}

/** Weighted AUC (probability that a random positive outranks a random negative; ties count half). */
export function auc(items: readonly Scored[]): number {
  const sorted = items.slice().sort((a, b) => a.p - b.p);
  let negBelow = 0;
  let num = 0;
  let pos = 0;
  let neg = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    let tiePos = 0;
    let tieNeg = 0;
    while (j < sorted.length && sorted[j]!.p === sorted[i]!.p) {
      const it = sorted[j]!;
      if (it.y >= 0.5) tiePos += wOf(it);
      else tieNeg += wOf(it);
      j++;
    }
    num += tiePos * (negBelow + 0.5 * tieNeg);
    negBelow += tieNeg;
    pos += tiePos;
    neg += tieNeg;
    i = j;
  }
  return pos > 0 && neg > 0 ? num / (pos * neg) : NaN;
}

export interface PlattFit {
  readonly a: number;
  readonly b: number;
}

/** Two-parameter logistic recalibration p' = expit(a + b·logit p), fitted on earlier cycles only. */
export function plattFit(items: readonly Scored[]): PlattFit {
  const fit = calibrationSlope(items);
  return { a: fit.intercept, b: fit.slope };
}

export function plattApply(p: number, fit: PlattFit): number {
  return expit(fit.a + fit.b * logit(clampProbability(p, 1e-9)));
}

/** Log loss, for completeness in model cards. */
export function logLoss(items: readonly Scored[]): number {
  const tw = totalWeight(items);
  return (
    items.reduce((s, it) => {
      const x = logit(clampProbability(it.p, 1e-12));
      return s + wOf(it) * (it.y >= 0.5 ? log1pExp(-x) : log1pExp(x));
    }, 0) / tw
  );
}

export interface BootstrapInterval {
  readonly estimate: number;
  readonly lo: number;
  readonly hi: number;
}

/** Distinct bootstrap clusters; an item without a cluster is its own (as clusterBootstrap treats it). */
export function clusterCount(items: readonly Scored[]): number {
  const keys = new Set<string>();
  items.forEach((it, i) => keys.add(it.cluster ?? `#${i}`));
  return keys.size;
}

/** Percentile bootstrap that resamples whole clusters (programs), seeded for reproducibility. */
export function clusterBootstrap(
  items: readonly Scored[],
  statistic: (sample: readonly Scored[]) => number,
  opts: { resamples?: number; level?: number; seed?: number } = {},
): BootstrapInterval {
  const resamples = opts.resamples ?? 2000;
  const level = opts.level ?? 0.9;
  const rng = createRng(opts.seed ?? 20261111);
  const clusters = new Map<string, Scored[]>();
  items.forEach((it, i) => {
    const key = it.cluster ?? `#${i}`;
    const list = clusters.get(key) ?? [];
    list.push(it);
    clusters.set(key, list);
  });
  const keys = [...clusters.keys()].sort();
  const stats: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const sample: Scored[] = [];
    for (let c = 0; c < keys.length; c++) sample.push(...clusters.get(keys[rng.int(keys.length)]!)!);
    const v = statistic(sample);
    if (Number.isFinite(v)) stats.push(v);
  }
  stats.sort((a, b) => a - b);
  const pick = (q: number): number => (stats.length === 0 ? NaN : stats[Math.min(stats.length - 1, Math.max(0, Math.floor(q * stats.length)))]!);
  const tail = (1 - level) / 2;
  return { estimate: statistic(items), lo: pick(tail), hi: pick(1 - tail) };
}

export interface HeldOutGateReport {
  readonly n: number;
  /** Distinct clusters (programs) behind the bootstrap intervals. */
  readonly clusters: number;
  readonly brier: number;
  readonly bss: BootstrapInterval;
  readonly auc: BootstrapInterval;
  readonly slope: BootstrapInterval;
  readonly spiegelhalterZ: number;
  readonly corp: CorpDecomposition;
  /** "fail_skill" shows "same for everyone"; "fail_calibration" shows official odds only. */
  readonly outcome: "pass" | "fail_skill" | "fail_calibration";
  readonly failures: readonly string[];
}

/**
 * The held-out gates of plan 7.5.5 plus the study's Spiegelhalter check, with intervals from a
 * program-clustered bootstrap: BSS 90% lower bound > 0, AUC lower bound > 0.6, calibration slope
 * 90% interval inside [0.5, 1.5] and |z| < 1.645. `reference` is the official stage rate τ.
 * Fewer than `minClusters` programs fail with "too_few_clusters": their bootstrap intervals
 * collapse toward the point estimate and would pass on no evidence.
 */
export function heldOutGates(
  items: readonly Scored[],
  reference: number | ((s: Scored) => number),
  opts: { resamples?: number; seed?: number } = {},
): HeldOutGateReport {
  const g = READINESS_CONFIG.bands.heldOut;
  const boot = { resamples: opts.resamples ?? 2000, level: 0.9, seed: opts.seed };
  const bss = clusterBootstrap(items, (s) => brierSkill(s, reference), boot);
  const aucInterval = clusterBootstrap(items, (s) => auc(s), { ...boot, seed: (opts.seed ?? 20261111) + 1 });
  const slope = clusterBootstrap(items, (s) => calibrationSlope(s).slope, { ...boot, seed: (opts.seed ?? 20261111) + 2 });
  const z = spiegelhalterZ(items);
  const clusters = clusterCount(items);
  const failures: string[] = [];
  if (clusters < g.minClusters) failures.push("too_few_clusters");
  if (!(bss.lo > g.minBssLower)) failures.push("brier_skill_lower_bound");
  if (!(aucInterval.lo > g.minAucLower)) failures.push("auc_lower_bound");
  const calibrationFailures: string[] = [];
  if (!(slope.lo >= g.slopeRange[0] && slope.hi <= g.slopeRange[1])) calibrationFailures.push("calibration_slope_interval");
  if (!(Math.abs(z) < g.maxAbsSpiegelhalterZ)) calibrationFailures.push("spiegelhalter_z");
  failures.push(...calibrationFailures);
  const outcome = calibrationFailures.length > 0 ? "fail_calibration" : failures.length > 0 ? "fail_skill" : "pass";
  return { n: items.length, clusters, brier: brierScore(items), bss, auc: aucInterval, slope, spiegelhalterZ: z, corp: corpDecomposition(items), outcome, failures };
}

export interface GroupScored extends Scored {
  /** An audit group label (institution type, selectivity tier). Opaque here; never a model input. */
  readonly group: string;
}

export interface GroupCalibrationGap {
  readonly group: string;
  readonly n: number;
  /** Distinct clusters (programs) in the group. */
  readonly clusters: number;
  /** Weighted observed rate minus weighted mean forecast (calibration in the large, probability scale). */
  readonly gap: number;
  /** One-sided 90% upper bound of |gap| from a program-clustered bootstrap. */
  readonly upper90: number;
  readonly passes: boolean;
}

function calibrationGap(items: readonly Scored[]): number {
  const tw = totalWeight(items);
  if (!(tw > 0)) return NaN;
  return items.reduce((s, it) => s + wOf(it) * (it.y - it.p), 0) / tw;
}

/**
 * The fairness pass test of plan 7.5.6: every audit group's calibration gap must have a one-sided
 * 90% upper bound under 10 points. A group too small to assess fails, which blocks bands for that
 * segment instead of silently passing it: too few items, or too few distinct clusters (a group
 * drawn from one program resamples to the same set every time, so its upper bound would equal
 * the point estimate and look certain). Group labels come from aggregate, non-sensitive audit
 * data (institution type, selectivity tier); SensitiveAnswers never reach this code (rule 3).
 */
export function fairnessGate(
  items: readonly GroupScored[],
  opts: { maxGap?: number; minItems?: number; minClusters?: number; resamples?: number; seed?: number } = {},
): { readonly groups: readonly GroupCalibrationGap[]; readonly passes: boolean } {
  const cfg = READINESS_CONFIG.bands.fairness;
  const maxGap = opts.maxGap ?? cfg.maxGap;
  const minItems = opts.minItems ?? cfg.minItems;
  const minClusters = opts.minClusters ?? cfg.minClusters;
  const byGroup = new Map<string, GroupScored[]>();
  for (const it of items) byGroup.set(it.group, [...(byGroup.get(it.group) ?? []), it]);
  const groups = [...byGroup.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([group, list], i): GroupCalibrationGap => {
      const gap = calibrationGap(list);
      const boot = clusterBootstrap(list, (sample) => Math.abs(calibrationGap(sample)), {
        resamples: opts.resamples ?? 2000,
        level: 0.8,
        seed: (opts.seed ?? 20261111) + i,
      });
      const clusters = clusterCount(list);
      const passes = list.length >= minItems && clusters >= minClusters && Number.isFinite(boot.hi) && boot.hi < maxGap;
      return { group, n: list.length, clusters, gap, upper90: boot.hi, passes };
    });
  return { groups, passes: groups.length > 0 && groups.every((g) => g.passes) };
}
