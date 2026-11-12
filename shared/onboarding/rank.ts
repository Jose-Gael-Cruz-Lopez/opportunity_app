import { compareStrings } from "./text";

/**
 * Ranking building blocks. Every value computed here is internal: it orders items and is
 * never serialized, shown or logged. Students see tiers, reasons and counts only.
 */

/**
 * Reciprocal Rank Fusion constant. Cormack, Clarke and Buettcher (SIGIR 2009) fixed k = 60 in
 * a pilot and found it "near-optimal, but the choice was not critical"; a small k (under about
 * 10) lets one noisy list dominate.
 */
export const RRF_K = 60;

/** Lists are cut to their top 50 before fusion so long tails add no noise. */
export const LIST_DEPTH = 50;

/**
 * Turns a sorted list into 1-based ranks, giving exact ties the average of their positions so
 * that an arbitrary tie-break (such as alphabetical order) never leaks into the fused order.
 */
export function ranksWithTies<T>(sorted: readonly T[], idOf: (item: T) => string, same: (a: T, b: T) => boolean): Map<string, number> {
  const ranks = new Map<string, number>();
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && same(sorted[i] as T, sorted[j + 1] as T)) j++;
    const avg = (i + 1 + (j + 1)) / 2;
    for (let x = i; x <= j; x++) ranks.set(idOf(sorted[x] as T), avg);
    i = j + 1;
  }
  return ranks;
}

/** RRF(d) = sum over lists of 1 / (k + rank(d)); items absent from a list add nothing. */
export function reciprocalRankFusion(lists: readonly ReadonlyMap<string, number>[], k: number = RRF_K): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    for (const [id, rank] of list) fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank));
  }
  return fused;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export interface MmrCandidate {
  readonly id: string;
  /** Relevance in [0, 1] (normalized by the tier's maximum) plus any exposure boost. */
  readonly rel: number;
  readonly features: ReadonlySet<string>;
  /** Tie-break key, so equal values resolve the same way everywhere. */
  readonly key: string;
}

/**
 * Maximal Marginal Relevance (Carbonell and Goldstein, SIGIR 1998): repeatedly take
 * argmax of lambda * rel(d) - (1 - lambda) * max sim(d, selected). Lambda 0.7 keeps relevance
 * dominant; similarity is Jaccard over organization, type and top tags. `accept` lets the
 * caller enforce hard caps (at most two per organization) while selecting.
 */
export function mmrSelect(
  candidates: readonly MmrCandidate[],
  opts: { lambda: number; limit: number; accept?: (c: MmrCandidate) => boolean; onTake?: (c: MmrCandidate) => void },
): MmrCandidate[] {
  const remaining = [...candidates];
  const selected: MmrCandidate[] = [];
  while (selected.length < opts.limit && remaining.length > 0) {
    let bestIndex = -1;
    let bestValue = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i] as MmrCandidate;
      if (opts.accept && !opts.accept(c)) continue;
      let maxSim = 0;
      for (const s of selected) maxSim = Math.max(maxSim, jaccard(c.features, s.features));
      const value = opts.lambda * c.rel - (1 - opts.lambda) * maxSim;
      const best = bestIndex >= 0 ? (remaining[bestIndex] as MmrCandidate) : null;
      if (value > bestValue + 1e-12 || (Math.abs(value - bestValue) <= 1e-12 && best !== null && compareStrings(c.key, best.key) < 0)) {
        bestValue = value;
        bestIndex = i;
      }
    }
    if (bestIndex < 0) break;
    const [taken] = remaining.splice(bestIndex, 1);
    if (!taken) break;
    selected.push(taken);
    opts.onTake?.(taken);
  }
  return selected;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Plan 06's merit-weighted exposure boost cap. */
export const EXPOSURE_BOOST_MAX = 0.08;

/**
 * b_fair = 0.08 * clamp(1 - eps / median eps, 0, 1) (plan 06, 6.6.2, after Singh and Joachims
 * 2018 and Biega et al. 2018). eps is a program's exposure relative to its merit, computed by
 * the server from served rank keys only. Programs seen less than the median get up to 0.08 on a
 * 0-1 relevance scale, enough to reorder near-equals within a tier and never enough to change a
 * tier, which is decided by rules.
 */
export function exposureBoost(eps: number, medianEps: number): number {
  if (!(medianEps > 0) || !Number.isFinite(eps)) return 0;
  const x = 1 - Math.max(0, eps) / medianEps;
  return EXPOSURE_BOOST_MAX * Math.min(1, Math.max(0, x));
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Binary entropy in bits; 1 at an even split, 0 when everything falls on one side. */
export function binaryEntropy(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}
