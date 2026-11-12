import { isHiddenLabel, labelBounds, UNBOUNDED, type Interval } from "./labels";

/**
 * Interval reasoning over a released table: from the labels and sum(cells) = total, the tightest
 * bounds each cell can be proven to lie in. Used by release() to place complementary suppression
 * and by the differencing harness to attack releases.
 */

export interface LabelledTable {
  readonly period: string;
  readonly total: string;
  readonly cells: readonly { readonly key: string; readonly label: string }[];
}

export interface Bounds {
  cells: Map<string, Interval>;
  total: Interval;
}

export interface PinnedCell {
  readonly period: string;
  readonly key: string;
  readonly label: string;
  readonly derived: Interval;
}

export function initialBounds(table: LabelledTable): Bounds {
  return { cells: new Map(table.cells.map((c) => [c.key, labelBounds(c.label)])), total: labelBounds(table.total) };
}

/** One round of sum propagation; returns whether any bound tightened. */
export function propagateSum(v: Bounds): boolean {
  let changed = false;
  const entries = [...v.cells.entries()];
  const sum = (pick: (i: Interval) => number, skip?: string): number => entries.reduce((s, [k, i]) => (k === skip ? s : s + pick(i)), 0);
  const total = { lo: Math.max(v.total.lo, sum((i) => i.lo)), hi: Math.min(v.total.hi, sum((i) => i.hi)) };
  if (total.lo !== v.total.lo || total.hi !== v.total.hi) {
    v.total = total;
    changed = true;
  }
  for (const [key, i] of entries) {
    // Sums exclude the cell itself, so an unbounded cell never meets Infinity - Infinity.
    const othersHi = sum((x) => x.hi, key);
    const othersLo = sum((x) => x.lo, key);
    const lo = Math.max(i.lo, othersHi === UNBOUNDED ? 0 : v.total.lo - othersHi);
    const hi = Math.min(i.hi, v.total.hi - othersLo);
    if (lo !== i.lo || hi !== i.hi) {
      v.cells.set(key, { lo, hi });
      changed = true;
    }
  }
  return changed;
}

export function settle(v: Bounds, rounds = 50): Bounds {
  for (let i = 0; i < rounds && propagateSum(v); i++);
  return v;
}

/**
 * Hidden cells the bounds reveal more about than their label: an exact value, or a cell shown as
 * "fewer than N" that is provably not zero (zero and small must read alike).
 */
export function pinnedCells(table: LabelledTable, v: Bounds): PinnedCell[] {
  const out: PinnedCell[] = [];
  for (const cell of table.cells) {
    if (!isHiddenLabel(cell.label)) continue;
    const d = v.cells.get(cell.key) as Interval;
    const exact = d.lo === d.hi;
    const revealsNonZeroSmall = cell.label.startsWith("fewer than") && d.lo >= 1;
    if (exact || revealsNonZeroSmall) out.push({ period: table.period, key: cell.key, label: cell.label, derived: d });
  }
  return out;
}
