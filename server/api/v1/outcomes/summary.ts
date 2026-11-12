import { DISCLOSURE, release, type CountRow, type ReleasedTable } from "@shared/disclosure";
import {
  bandDisplayStatus,
  BANDS_LIVE_NOTE,
  OFFICIAL_BASE_RATE_ONLY_NOTE,
  OutcomeSummarySchema,
  summaryCountRows,
  type BandGateFlags,
  type OutcomeSummary,
  type OutcomeSummaryCycle,
  type ReleasedTableView,
  type SummaryReport,
} from "@shared/readiness/outcomes";

/**
 * The public outcome summary: every number goes through shared/disclosure's `release()` with
 * the `public` audience (totals of 5 or more, cells of 10, bands below 20, complements), so the
 * k >= 5 rule and every other disclosure rule live in one place. A held cycle releases nothing.
 *
 * Phase 2 scope (plan 9.6 R6): banded report counts, the decision split, the furthest stage and
 * a decision timeline. No applicant-context dimension (class year, GPA band, institution type)
 * is released here; those wait for the 14-day delay and the differencing harness.
 */

const SUPPRESSED = (period: string, reason: string): ReleasedTableView => ({ period, suppressed: true, reason });

/** Copies a released table into the response shape (labels only; nothing else is carried). */
function view(t: ReleasedTable): ReleasedTableView {
  return t.suppressed
    ? { period: t.period, suppressed: true, reason: t.reason }
    : { period: t.period, suppressed: false, total: t.total, cells: t.cells.map((c) => ({ key: c.key, label: c.label })) };
}

function one(rows: readonly CountRow[], period: string, opts: Parameters<typeof release>[1]): ReleasedTableView {
  if (rows.length === 0) return SUPPRESSED(period, "below_min_total");
  const [table] = release(rows, opts);
  return table ? view(table) : SUPPRESSED(period, "below_min_total");
}

export interface SummaryCycleInput {
  readonly cycleKey: string;
  readonly held: boolean;
  readonly reports: readonly SummaryReport[];
}

export function summarizeCycle(input: SummaryCycleInput): OutcomeSummaryCycle {
  const { cycleKey } = input;
  if (input.held) {
    const held = SUPPRESSED(cycleKey, "held");
    return { cycleKey, held: true, reports: held, decisions: held, furthestStage: held, timeline: [] };
  }
  const rows = summaryCountRows(input.reports, cycleKey);
  const reports = one(rows.total, cycleKey, { audience: "public", grain: "cycle", dims: [] });
  // A table is released only when its own total passes; with no released total nothing else is.
  if (reports.suppressed) {
    return { cycleKey, held: false, reports, decisions: SUPPRESSED(cycleKey, reports.reason), furthestStage: SUPPRESSED(cycleKey, reports.reason), timeline: [] };
  }
  return {
    cycleKey,
    held: false,
    reports,
    decisions: one(rows.decisions, cycleKey, { audience: "public", grain: "cycle", dims: ["decision"] }),
    furthestStage: one(rows.furthestStage, cycleKey, { audience: "public", grain: "cycle", dims: ["stage"] }),
    timeline: rows.timeline.length === 0 ? [] : release(rows.timeline, { audience: "public", grain: "month", dims: [] }).map(view),
  };
}

export interface SummaryInput {
  readonly programSlug: string;
  readonly asOf: string;
  readonly isSample: boolean;
  readonly cycles: readonly SummaryCycleInput[];
  readonly bandGates: BandGateFlags | null;
}

export function buildOutcomeSummary(input: SummaryInput): OutcomeSummary {
  const status = bandDisplayStatus(input.bandGates);
  const summary: OutcomeSummary = {
    programSlug: input.programSlug,
    audience: "public",
    asOf: input.asOf,
    countedTiers: [...DISCLOSURE.countedTiers],
    cycles: input.cycles.map(summarizeCycle),
    bands: { status, note: status === "live" ? BANDS_LIVE_NOTE : OFFICIAL_BASE_RATE_ONLY_NOTE },
    isSample: input.isSample,
  };
  // Contract check on the way out: a shape drift fails here, not in a browser.
  return OutcomeSummarySchema.parse(summary);
}
