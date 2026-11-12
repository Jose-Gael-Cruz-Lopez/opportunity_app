import { initialBounds, pinnedCells, propagateSum, settle, type PinnedCell } from "./bounds";
import type { ReleasedTable } from "./table";

/**
 * Differencing harness (plan 9.6): plays the attacker against released tables. From the labels
 * alone it derives the tightest interval each cell can lie in, using the table total and, for a
 * pair of consecutive cumulative releases, the fact that counts never go down. A hidden cell is
 * pinned when the attack learns more than its label says (see bounds.ts). Release gates and tests
 * require that nothing is pinned.
 *
 * Not part of the release API: import it from tests and the release-gate job only.
 */

export type { PinnedCell } from "./bounds";
export { labelBounds } from "./labels";

/** Attacks one table on its own. */
export function attackTable(table: ReleasedTable): PinnedCell[] {
  if (table.suppressed) return [];
  return pinnedCells(table, settle(initialBounds(table)));
}

/**
 * Attacks two consecutive releases of cumulative counts (the later one includes the earlier):
 * every cell is at least its earlier value, which can pin a cell that each table hides.
 */
export function attackPair(earlier: ReleasedTable, later: ReleasedTable): PinnedCell[] {
  if (earlier.suppressed || later.suppressed) return [...attackTable(earlier), ...attackTable(later)];
  const a = initialBounds(earlier);
  const b = initialBounds(later);
  for (let round = 0; round < 50; round++) {
    let changed = propagateSum(a);
    changed = propagateSum(b) || changed;
    for (const [key, ia] of a.cells) {
      const ib = b.cells.get(key);
      if (!ib) continue;
      if (ia.lo > ib.lo) {
        b.cells.set(key, { lo: ia.lo, hi: ib.hi });
        changed = true;
      }
      if (ib.hi < ia.hi) {
        a.cells.set(key, { lo: ia.lo, hi: ib.hi });
        changed = true;
      }
    }
    if (!changed) break;
  }
  return [...pinnedCells(earlier, a), ...pinnedCells(later, b)];
}

/** Attacks every table and every consecutive pair in a series of releases. */
export function attackSeries(tables: readonly ReleasedTable[]): PinnedCell[] {
  const out = tables.flatMap((t) => attackTable(t));
  for (let i = 1; i < tables.length; i++) out.push(...attackPair(tables[i - 1] as ReleasedTable, tables[i] as ReleasedTable));
  return out;
}
