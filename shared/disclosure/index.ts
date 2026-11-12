import { addDays, isIsoDate } from "../time/iso";
import {
  APPLICANT_CONTEXT_DIMENSIONS,
  DISCLOSURE,
  DISCLOSURE_DIMENSIONS,
  type Audience,
  type DisclosureDimension,
  type Grain,
} from "./config";
import { countLabel, releaseTable, type Cell, type ReleasedTable } from "./table";

/**
 * shared/disclosure: release() is the only way an Outcome-derived number leaves the system
 * (rule N5). Inputs are pre-aggregated counts, never Outcome rows (R1); output is labelled
 * tables with small cells banded, suppressed or complemented.
 */

export class DisclosureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DisclosureError";
  }
}

/** A pre-aggregated count: how many counted Outcomes share these categories in this period. */
export interface CountRow {
  readonly period: string;
  readonly grain: Grain;
  readonly cycleKey: string;
  readonly categories: Readonly<Partial<Record<DisclosureDimension, string>>>;
  readonly n: number;
}

export interface ReleaseOptions {
  readonly audience: Audience;
  readonly grain: Grain;
  /** Zero (a total only), one, or (when enabled) two pre-declared dimensions (R4). */
  readonly dims: readonly DisclosureDimension[];
  /** Release date and the cycle's decisions-complete date; required for applicant-context dims (R6). */
  readonly asOf?: string;
  readonly decisionsCompletedOn?: string | null;
  /** Category list for the `institution` dimension (institution ids). */
  readonly institutionIds?: readonly string[];
}

const ROW_KEYS = new Set(["period", "grain", "cycleKey", "categories", "n"]);

/** R1: only aggregate counts are accepted; anything shaped like an Outcome row is refused. */
function assertCountRows(rows: readonly CountRow[]): void {
  for (const row of rows) {
    for (const key of Object.keys(row)) if (!ROW_KEYS.has(key)) throw new DisclosureError(`R1: unexpected field "${key}" on a count row`);
    if (!Number.isInteger(row.n) || row.n < 0) throw new DisclosureError("R1: counts are non-negative integers");
  }
}

function categoriesOf(dim: DisclosureDimension, o: ReleaseOptions): readonly string[] {
  if (dim === "institution") {
    if (!o.institutionIds || o.institutionIds.length === 0) throw new DisclosureError("institution splits need the institution ids");
    return o.institutionIds;
  }
  return DISCLOSURE_DIMENSIONS[dim];
}

/** R2: every declared category appears, zeros included, in a stable order. */
function zeroFill(rows: readonly CountRow[], dims: readonly DisclosureDimension[], o: ReleaseOptions): Cell[] {
  const lists = dims.map((d) => categoriesOf(d, o));
  let keys: string[][] = [[]];
  for (const list of lists) keys = keys.flatMap((prefix) => list.map((c) => [...prefix, c]));
  const counts = new Map(keys.map((k) => [k.join("|"), 0]));
  for (const row of rows) {
    const parts = dims.map((d, i) => {
      const value = row.categories[d];
      if (value === undefined || !(lists[i] as readonly string[]).includes(value)) {
        throw new DisclosureError(`R4: category "${String(value)}" is not declared for ${d}`);
      }
      return value;
    });
    const key = dims.length === 0 ? "" : parts.join("|");
    counts.set(key, (counts.get(key) ?? 0) + row.n);
  }
  return [...counts.entries()].map(([key, n]) => ({ key, n }));
}

/** R7: each institution needs enough accepted and not-accepted reports over enough cycles. */
function institutionSplitAllowed(rows: readonly CountRow[], ids: readonly string[]): boolean {
  const { minEachOutcome, minCycles } = DISCLOSURE.institutionSplit;
  for (const id of ids) {
    const mine = rows.filter((r) => r.categories.institution === id);
    if (mine.some((r) => r.categories.decision === undefined)) throw new DisclosureError("R7: institution rows must carry a decision");
    const accepted = mine.filter((r) => r.categories.decision === "accepted").reduce((s, r) => s + r.n, 0);
    const other = mine.filter((r) => r.categories.decision !== "accepted").reduce((s, r) => s + r.n, 0);
    const cycles = new Set(mine.filter((r) => r.n > 0).map((r) => r.cycleKey)).size;
    if (accepted < minEachOutcome || other < minEachOutcome || cycles < minCycles) return false;
  }
  return true;
}

function contextReleasable(o: ReleaseOptions): boolean {
  if (!o.dims.some((d) => APPLICANT_CONTEXT_DIMENSIONS.includes(d))) return true;
  if (!o.asOf || !o.decisionsCompletedOn || !isIsoDate(o.asOf) || !isIsoDate(o.decisionsCompletedOn)) return false;
  return o.asOf >= addDays(o.decisionsCompletedOn, DISCLOSURE.contextDelayDays);
}

/**
 * Releases counts for one audience at one time grain, one table per period. Throws on misuse
 * (mixed grains, undeclared categories, more than two dimensions, Outcome-shaped rows); returns
 * suppressed tables when the data is too small to show safely.
 */
export function release(rows: readonly CountRow[], o: ReleaseOptions): ReleasedTable[] {
  assertCountRows(rows);
  if (rows.some((r) => r.grain !== o.grain)) throw new DisclosureError("R8: one time grain per release");
  if (o.dims.length > 2) throw new DisclosureError("R4: at most two dimensions");
  if (new Set(o.dims).size !== o.dims.length) throw new DisclosureError("R4: a dimension appears twice");
  if (o.dims.length === 2 && !DISCLOSURE.twoWayEnabled) throw new DisclosureError("R4: two-way tables are not enabled yet");

  const periods = [...new Set(rows.map((r) => r.period))].sort();
  const suppressAll = (reason: Extract<ReleasedTable, { suppressed: true }>["reason"]): ReleasedTable[] =>
    periods.map((period) => ({ period, suppressed: true as const, reason }));
  if (!contextReleasable(o)) return suppressAll("context_delay");
  if (o.dims.includes("institution") && !institutionSplitAllowed(rows, o.institutionIds ?? [])) return suppressAll("institution_split");

  return periods.map((period) => {
    const inPeriod = rows.filter((r) => r.period === period);
    const total = inPeriod.reduce((s, r) => s + r.n, 0);
    if (o.dims.includes("first_gen") && total < DISCLOSURE.firstGenMinTotal) return { period, suppressed: true, reason: "first_gen_total" };
    if (o.dims.length === 0) {
      const { minTotal } = DISCLOSURE.audiences[o.audience];
      return total < minTotal
        ? { period, suppressed: true, reason: "below_min_total" }
        : { period, suppressed: false, total: countLabel(total), cells: [] };
    }
    return releaseTable(period, zeroFill(inPeriod, o.dims, o), o.audience, o.dims.length === 2);
  });
}

export { AUDIENCES, DISCLOSURE, DISCLOSURE_DIMENSIONS, DISCLOSURE_DIMENSION_KEYS, APPLICANT_CONTEXT_DIMENSIONS } from "./config";
export type { Audience, DisclosureDimension, Grain } from "./config";
export type { ReleasedCell, ReleasedTable, SuppressionReason } from "./table";
