/**
 * Small-cell suppression for the founders' metrics view (plan 10.9.1, 10.10). Every number
 * derived from students leaves the server through these helpers: a count is shown when it is 0 or
 * at least K, and hidden when it is 1 to K-1. Rates are computed only from shown counts.
 *
 * Partitions (one total split into categories, e.g. tracker items by status) get complementary
 * suppression: with the total known, one hidden cell would equal `total - shown`, and several
 * hidden cells are pinned when they must all be 1 or all be K-1. In those cases every non-zero
 * cell is hidden and only the total stays. Hiding just the smallest shown cell is not enough: a
 * reader who knows the rule learns that the complement is at least K and at most the next shown
 * cell, which pins it when those meet (suppress.test.ts enumerates every table up to 30). The
 * rule holds even when the total is published elsewhere, so linked tables stay safe.
 *
 * Nested counts (funnel steps, retention weeks) are not partitions and are suppressed cell by
 * cell. They count pseudonymous actors reaching a step and carry no other attribute.
 */

export const K_MIN = 5;

export interface Cell {
  /** The exact count, or null when hidden. */
  readonly n: number | null;
  readonly hidden: boolean;
}

export const HIDDEN: Cell = Object.freeze({ n: null, hidden: true });

function assertCount(n: number): void {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("counts are non-negative integers");
}

export function isSmall(n: number, k: number = K_MIN): boolean {
  return n > 0 && n < k;
}

/** One count: shown when 0 or at least k, hidden otherwise. */
export function cell(n: number, k: number = K_MIN): Cell {
  assertCount(n);
  return isSmall(n, k) ? HIDDEN : { n, hidden: false };
}

/** A share in [0, 1] rounded to 3 places, or null when either side is hidden or the base is 0. */
export function rate(part: Cell, base: Cell): number | null {
  if (part.n === null || base.n === null || base.n === 0) return null;
  return Math.round((part.n / base.n) * 1000) / 1000;
}

export interface PartitionEntry {
  readonly key: string;
  readonly n: number;
}

export interface Partition {
  readonly total: Cell;
  readonly cells: { readonly key: string; readonly count: Cell }[];
}

/** True when the hidden small cells could be recovered exactly from a shown total. */
function pinned(smalls: readonly number[], k: number): boolean {
  if (smalls.length === 0) return false;
  const sum = smalls.reduce((s, n) => s + n, 0);
  return smalls.length === 1 || sum === smalls.length || sum === (k - 1) * smalls.length;
}

/**
 * A partition of `total` into the given categories (every category listed, zeros included, in the
 * order given).
 */
export function partition(entries: readonly PartitionEntry[], k: number = K_MIN): Partition {
  for (const e of entries) assertCount(e.n);
  const total = entries.reduce((s, e) => s + e.n, 0);
  // A small total hides zeros too: "all of them are in one category" is itself a disclosure.
  if (isSmall(total, k)) return { total: HIDDEN, cells: entries.map((e) => ({ key: e.key, count: HIDDEN })) };

  const hide = new Set(entries.filter((e) => isSmall(e.n, k)).map((e) => e.key));
  if (pinned(entries.filter((e) => hide.has(e.key)).map((e) => e.n), k)) for (const e of entries) if (e.n > 0) hide.add(e.key);
  return {
    total: cell(total, k),
    cells: entries.map((e) => ({ key: e.key, count: hide.has(e.key) ? HIDDEN : { n: e.n, hidden: false } })),
  };
}
