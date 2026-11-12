import { MATCHING_CONFIG } from "./config";

/**
 * Merit-weighted exposure (Phase 3 design, plan 6.6.2; after Singh and Joachims 2018 and Biega,
 * Gummadi and Weikum 2018). Not wired into order v0: Phases 1-2 spread exposure with the weekly
 * rotation tie-break and the diversity caps only, which need no data.
 *
 * Inputs are server-served rank positions only, never clicks, popularity, prestige or payment,
 * and never anything the browser re-sorted with SensitiveAnswers. Outputs are internal: the
 * boost becomes integer rank keys on the server and is never a student-facing number.
 */

/** Position weight v_j = 1 / log2(1 + j) for a 1-based position j. */
export function positionWeight(position: number): number {
  if (!Number.isInteger(position) || position < 1) throw new RangeError(`position must be a positive integer, got ${position}`);
  return 1 / Math.log2(1 + position);
}

/** Exposure(c) = sum of v_j over the positions at which c was served in the window. */
export function exposureFromPositions(positions: readonly number[]): number {
  return positions.reduce((sum, j) => sum + positionWeight(j), 0);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export interface ExposureInput {
  readonly id: string;
  /** Position-discounted exposure over the window. */
  readonly exposure: number;
  /** Summed relevance (fit times eligibility multiplier) over eligible users; must be > 0 to qualify. */
  readonly relevance: number;
}

/**
 * b_fair(c) = weight * clamp(1 - e(c) / median e, 0, 1) with e = exposure / relevance, applied
 * only to items whose relevance is above the slate median; everything else gets 0.
 */
export function fairnessBoosts(items: readonly ExposureInput[], weight: number = MATCHING_CONFIG.exposure.fairWeight): Map<string, number> {
  const out = new Map<string, number>();
  const eligible = items.filter((i) => i.relevance > 0);
  const ratios = new Map(eligible.map((i) => [i.id, i.exposure / i.relevance]));
  const medRatio = median([...ratios.values()]);
  const medRel = median(eligible.map((i) => i.relevance));
  for (const item of items) {
    const ratio = ratios.get(item.id);
    if (ratio === undefined || item.relevance <= medRel || medRatio <= 0) {
      out.set(item.id, 0);
      continue;
    }
    out.set(item.id, weight * Math.min(1, Math.max(0, 1 - ratio / medRatio)));
  }
  return out;
}

/** Exposure Gini G = sum_i sum_j |x_i - x_j| / (2 n^2 mean), the E1 outcome metric. */
export function exposureGini(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return 0;
  let sum = 0;
  for (const a of values) for (const b of values) sum += Math.abs(a - b);
  return sum / (2 * n * n * mean);
}
