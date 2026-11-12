import { OUTCOMES_CONFIG, type OutcomePrivateConfig } from "./config";
import { isSelected } from "./stages";
import { qualityFlags, type OutcomeFlagCode, type ValidationCycle } from "./validate";
import { isCountedTier, type OutcomeFacts } from "./vocab";
import { curatedWindow, daysBetweenIso, isCalendarDate, weekStartOf } from "./window";

/**
 * The per-cycle checks behind the daily `outcomes.quality` job (plan 7.8, Phase 2). Pure: the
 * job loads one cycle's live reports, calls this, and writes what it returns.
 *
 * - Re-runs the deterministic validators, so a report flagged under yesterday's cycle facts (a
 *   Curator moved the decision window) is re-judged. Flags are only ever added here; clearing
 *   them is a Curator's decision on the outcome_anomaly task.
 * - Over-count: counted selected reports above a PRIVATE fraction of the official award count
 *   hold the cycle's displayed aggregates. A self_reported excess never holds anything.
 * - Without a curated window, a decision more than 21 days from the week most counted reports
 *   name is flagged `decision_week_outlier`.
 * - Outcome-derived history: once at least 10 distinct counted accounts report a decision within
 *   one week, a draft decision week is proposed for a Curator (never published at day
 *   precision; never read back by inDecisionWindow).
 */

export interface QualityReportRow extends OutcomeFacts {
  readonly id: string;
  /** Opaque per-account key: distinct-account counts only, never shown. */
  readonly accountKey: string;
  readonly tier: string;
  readonly qualityState: "ok" | "flagged";
  readonly flagCodes: readonly string[];
  readonly snapshotClassYear: string | null;
  /** Round deadline for this report's TrackerItem, else the cycle's earliest round. */
  readonly roundDeadline: string | null;
  /** The account's other reports this season (for the private cap). */
  readonly otherReportsThisSeason: number;
}

export interface CycleQualityInput {
  readonly today: string;
  readonly cycle: ValidationCycle;
  readonly nominationRequired: boolean;
  readonly reports: readonly QualityReportRow[];
  /** Official award count (official_publication only); null when none is published. */
  readonly officialAwards: number | null;
  readonly privateConfig: OutcomePrivateConfig;
}

export interface FlagUpdate {
  readonly id: string;
  /** The full, sorted code list to store (existing codes plus new ones). */
  readonly flagCodes: readonly string[];
}

export interface CycleQualityResult {
  readonly flagUpdates: readonly FlagUpdate[];
  /** Hold the cycle's displayed aggregates (over-count rule). */
  readonly hold: { readonly reason: "over_count" } | null;
  /** Draft decision week for a Curator (cycle_update task); counts pass through disclosure later. */
  readonly historyDraft: { readonly weekStart: string; readonly accounts: number } | null;
  /** Pseudonymous counts for the outcome_anomaly task: by tier, decision and flag (no rows). */
  readonly counts: {
    readonly reports: number;
    readonly counted: number;
    readonly flagged: number;
    readonly countedSelected: number;
    readonly byFlag: Readonly<Record<string, number>>;
  };
}

/** Minimum counted decisions in the modal week before the outlier rule applies (judgment). */
export const MODAL_WEEK_MIN_REPORTS = 5;

function modalWeek(dates: readonly string[]): { week: string; n: number } | null {
  const counts = new Map<string, number>();
  for (const d of dates) counts.set(weekStartOf(d), (counts.get(weekStartOf(d)) ?? 0) + 1);
  let best: { week: string; n: number } | null = null;
  for (const [week, n] of [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) if (!best || n > best.n) best = { week, n };
  return best;
}

export function assessCycleQuality(input: CycleQualityInput): CycleQualityResult {
  const { reports, cycle, today } = input;
  const counted = (r: QualityReportRow) => isCountedTier(r.tier);
  const updates: FlagUpdate[] = [];

  // Week most counted reports name (only used when no curated window exists).
  const countedDecided = reports.filter((r) => counted(r) && r.decidedOn && isCalendarDate(r.decidedOn)).map((r) => r.decidedOn!);
  const modal = curatedWindow(cycle) === null ? modalWeek(countedDecided) : null;
  const useModal = modal !== null && modal.n >= MODAL_WEEK_MIN_REPORTS;

  for (const r of reports) {
    const next = new Set<string>(r.flagCodes);
    const fresh: OutcomeFlagCode[] = qualityFlags(r, {
      today,
      cycle,
      roundDeadline: r.roundDeadline,
      nominationRequired: input.nominationRequired,
      snapshotClassYear: r.snapshotClassYear,
      otherReportsThisSeason: r.otherReportsThisSeason,
      privateConfig: input.privateConfig,
    });
    for (const f of fresh) next.add(f);
    if (useModal && r.decidedOn && isCalendarDate(r.decidedOn) && Math.abs(daysBetweenIso(modal!.week, r.decidedOn)) > OUTCOMES_CONFIG.modalWeekToleranceDays) {
      next.add("decision_week_outlier");
    }
    if (next.size !== r.flagCodes.length) updates.push({ id: r.id, flagCodes: [...next].sort() });
  }

  const flaggedIds = new Set(updates.map((u) => u.id));
  const isFlagged = (r: QualityReportRow) => r.qualityState === "flagged" || flaggedIds.has(r.id);
  const countedOk = reports.filter((r) => counted(r) && !isFlagged(r));
  const countedSelected = countedOk.filter((r) => isSelected(r.decision)).length;

  const fraction = input.privateConfig.overCountFraction;
  const hold =
    fraction !== null && Number.isFinite(fraction) && input.officialAwards !== null && input.officialAwards > 0 && countedSelected > fraction * input.officialAwards
      ? ({ reason: "over_count" } as const)
      : null;

  // Distinct counted accounts per decision week.
  const weekAccounts = new Map<string, Set<string>>();
  for (const r of countedOk) {
    if (!r.decidedOn || !isCalendarDate(r.decidedOn) || r.decision === null || r.decision === "withdrew") continue;
    const week = weekStartOf(r.decidedOn);
    const set = weekAccounts.get(week) ?? new Set<string>();
    set.add(r.accountKey);
    weekAccounts.set(week, set);
  }
  let historyDraft: CycleQualityResult["historyDraft"] = null;
  for (const [week, set] of [...weekAccounts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (set.size >= OUTCOMES_CONFIG.history.minAccounts && (!historyDraft || set.size > historyDraft.accounts)) historyDraft = { weekStart: week, accounts: set.size };
  }

  const byFlag: Record<string, number> = {};
  for (const r of reports) {
    const codes = updates.find((u) => u.id === r.id)?.flagCodes ?? r.flagCodes;
    for (const c of codes) byFlag[c] = (byFlag[c] ?? 0) + 1;
  }
  return {
    flagUpdates: updates,
    hold,
    historyDraft,
    counts: {
      reports: reports.length,
      counted: reports.filter(counted).length,
      flagged: reports.filter(isFlagged).length,
      countedSelected,
      byFlag,
    },
  };
}
