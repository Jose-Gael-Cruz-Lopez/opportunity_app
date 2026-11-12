import { furthestStage } from "./stages";
import { isCountedTier, type OutcomeFacts } from "./vocab";
import { isCalendarDate } from "./window";

/**
 * Pre-aggregation for shared/disclosure. These functions turn live reports into the count rows
 * that `release()` accepts (period, grain, cycleKey, categories, n: nothing else, rule R1); the
 * caller passes them to `release()` and only its labelled tables leave the server.
 *
 * Displayed aggregates are unweighted counts of the counted tiers (institution_email and above)
 * with quality_state 'ok'. Tier weights never touch a displayed number (plan 7.8).
 *
 * The row type is restated structurally (shared/readiness imports nothing outside itself); it is
 * assignable to shared/disclosure's CountRow, which outcomes.test.ts checks by calling release().
 */

export type SummaryGrain = "month" | "term" | "cycle";

export interface DisclosureCountRow {
  readonly period: string;
  readonly grain: SummaryGrain;
  readonly cycleKey: string;
  readonly categories: Readonly<Partial<Record<"decision" | "stage", string>>>;
  readonly n: number;
}

export interface SummaryReport extends OutcomeFacts {
  readonly tier: string;
  readonly qualityState: "ok" | "flagged";
}

/** Counted tiers and not flagged: the only reports a displayed aggregate may count. */
export function countsForDisplay(r: SummaryReport): boolean {
  return isCountedTier(r.tier) && r.qualityState === "ok";
}

export interface SummaryCountRows {
  /** One row: the cycle's counted reports (released with no dimension: a banded total). */
  readonly total: readonly DisclosureCountRow[];
  /** Decided counted reports by decision (one-way table). */
  readonly decisions: readonly DisclosureCountRow[];
  /** Counted reports by the furthest stage reached (a partition, so complements are sound). */
  readonly furthestStage: readonly DisclosureCountRow[];
  /** Counted decisions per calendar month (one total per month). */
  readonly timeline: readonly DisclosureCountRow[];
}

function tally<K extends string>(keys: readonly K[]): Map<K, number> {
  const out = new Map<K, number>();
  for (const k of keys) out.set(k, (out.get(k) ?? 0) + 1);
  return out;
}

export function summaryCountRows(reports: readonly SummaryReport[], cycleKey: string): SummaryCountRows {
  const counted = reports.filter(countsForDisplay);
  const cycleRow = (categories: DisclosureCountRow["categories"], n: number): DisclosureCountRow => ({ period: cycleKey, grain: "cycle", cycleKey, categories, n });

  const decisions = tally(counted.flatMap((r) => (r.decision ? [r.decision] : [])));
  const stages = tally(counted.flatMap((r) => {
    const s = furthestStage(r);
    return s ? [s] : [];
  }));
  const months = tally(counted.flatMap((r) => (r.decision && r.decidedOn && isCalendarDate(r.decidedOn) ? [r.decidedOn.slice(0, 7)] : [])));

  return {
    total: [cycleRow({}, counted.length)],
    decisions: [...decisions.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([decision, n]) => cycleRow({ decision }, n)),
    furthestStage: [...stages.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([stage, n]) => cycleRow({ stage }, n)),
    timeline: [...months.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, n]) => ({ period: month, grain: "month" as const, cycleKey, categories: {}, n })),
  };
}
