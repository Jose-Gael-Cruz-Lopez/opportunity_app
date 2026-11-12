import { DISCLOSURE, type Audience } from "./config";
import { initialBounds, pinnedCells, settle } from "./bounds";
import { countLabel, fewerThan, NOT_SHOWN } from "./labels";

/**
 * One table's release (R2-R5). Internal: callers use release() in ./index, which zero-fills,
 * splits by period and applies the rules that need more than one table.
 */

export interface Cell {
  readonly key: string;
  readonly n: number;
}

export type SuppressionReason =
  | "below_min_total"
  | "single_category"
  | "two_way_small_cell"
  | "first_gen_total"
  | "context_delay"
  | "institution_split"
  /** Every cell would need hiding to keep small cells unreadable; the table is withheld. */
  | "unsafe_small_cells";

export interface ReleasedCell {
  readonly key: string;
  readonly label: string;
}

export type ReleasedTable =
  | { readonly period: string; readonly suppressed: true; readonly reason: SuppressionReason }
  | { readonly period: string; readonly suppressed: false; readonly total: string; readonly cells: readonly ReleasedCell[] };

export { countLabel, NOT_SHOWN, fewerThan } from "./labels";

/**
 * R2-R4 on one table. Zero and small cells read alike ("fewer than N"), a table with one
 * non-zero category is suppressed whole, and a two-way table needs every cell to pass.
 *
 * Complementary suppression (R3): the plan's sketch hides the next-smallest cell when exactly one
 * cell is small. That is not always enough: with every cell small (advisor {3, 4}: total "5-9",
 * both "fewer than 5") the total proves each cell is at least 1. So after labelling, the table is
 * attacked with the same interval reasoning the differencing harness uses, and the smallest shown
 * cell is hidden until nothing is pinned; if nothing is left to hide, the table is withheld.
 */
export function releaseTable(period: string, cells: readonly Cell[], audience: Audience, twoWay: boolean): ReleasedTable {
  const { minTotal, minCell } = DISCLOSURE.audiences[audience];
  const total = cells.reduce((s, c) => s + c.n, 0);
  if (total < minTotal) return { period, suppressed: true, reason: "below_min_total" };
  if (cells.filter((c) => c.n > 0).length <= 1) return { period, suppressed: true, reason: "single_category" };
  const small = new Set(cells.filter((c) => c.n < minCell).map((c) => c.key));
  if (twoWay && small.size > 0) return { period, suppressed: true, reason: "two_way_small_cell" };

  const notShown = new Set<string>();
  const shown = (): Cell[] => cells.filter((c) => !small.has(c.key) && !notShown.has(c.key)).sort((a, b) => a.n - b.n || (a.key < b.key ? -1 : 1));
  if (small.size === 1 && shown()[0]) notShown.add((shown()[0] as Cell).key);

  for (;;) {
    const table = {
      period,
      suppressed: false as const,
      total: countLabel(total),
      cells: cells.map((c) => ({ key: c.key, label: small.has(c.key) ? fewerThan(minCell) : notShown.has(c.key) ? NOT_SHOWN : countLabel(c.n) })),
    };
    if (small.size === 0 || pinnedCells(table, settle(initialBounds(table))).length === 0) return table;
    const next = shown()[0];
    if (!next) return { period, suppressed: true, reason: "unsafe_small_cells" };
    notShown.add(next.key);
  }
}
