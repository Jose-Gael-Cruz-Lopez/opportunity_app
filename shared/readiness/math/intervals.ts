import { betaQuantile, normalQuantile } from "./special";

/** Binomial proportion intervals used by the odds display, the gates and the audits. */

export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

function twoSidedZ(level: number): number {
  return normalQuantile(1 - (1 - level) / 2);
}

/** Wilson score interval for k successes in n trials at a two-sided level. */
export function wilsonInterval(k: number, n: number, level = 0.95): Interval {
  if (n <= 0) return { lo: 0, hi: 1 };
  const z = twoSidedZ(level);
  return wilsonWithZ(k, n, z);
}

function wilsonWithZ(k: number, n: number, z: number): Interval {
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** One-sided Wilson lower bound at `level` (0.9 gives the plan's "one-sided 90%" bound). */
export function wilsonLowerBound(k: number, n: number, level = 0.9): number {
  if (n <= 0) return 0;
  return wilsonWithZ(k, n, normalQuantile(level)).lo;
}

/** Half-width of the Wilson interval at proportion p and size n (sample-size planning). */
export function wilsonHalfWidth(p: number, n: number, level = 0.95): number {
  const z = twoSidedZ(level);
  const z2 = z * z;
  return (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
}

/**
 * Jeffreys interval: equal-tailed quantiles of Beta(k + 1/2, n − k + 1/2), with the usual
 * convention that the bound is 0 at k = 0 and 1 at k = n.
 */
export function jeffreysInterval(k: number, n: number, level = 0.8): Interval {
  if (n <= 0) return { lo: 0, hi: 1 };
  const tail = (1 - level) / 2;
  const a = k + 0.5;
  const b = n - k + 0.5;
  return {
    lo: k <= 0 ? 0 : betaQuantile(tail, a, b),
    hi: k >= n ? 1 : betaQuantile(1 - tail, a, b),
  };
}
