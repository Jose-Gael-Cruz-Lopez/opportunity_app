/**
 * shared/readiness/outcomes: the pure half of Outcome reporting (plans 7.5-7.8 and 9.5).
 * Browser, Worker and tests share it; nothing here reads a clock, storage or the network.
 * See README.md for the rules and where each piece is used.
 */
export {
  OUTCOME_STAGE_ORDER,
  OUTCOME_DECISION_CODES,
  OUTCOME_TIER_CODES,
  COUNTED_TIER_CODES,
  COUNT_STAGE_CODES,
  FUNNEL_STAGE_CODES,
  INSTITUTION_LEVEL_CODES,
  isCountedTier,
} from "./vocab";
export type { CountStageCode, DatedStage, InstitutionLevelCode, OutcomeDecisionCode, OutcomeFacts, OutcomeStageCode, OutcomeTierCode } from "./vocab";

export { OUTCOMES_CONFIG, NO_PRIVATE_CONFIG, PRIVATE_CONFIG_KEYS, tierWeight } from "./config";
export type { OutcomePrivateConfig } from "./config";

export {
  addDaysIso,
  curatedWindow,
  daysBetweenIso,
  decisionWindowClosed,
  expectedDecisionDate,
  inDecisionWindow,
  isCalendarDate,
  outcomeEditable,
  outcomePromptDueOn,
  weekStartOf,
} from "./window";
export type { DecisionWindowCycle, WindowBasis, WindowCheck } from "./window";

export { consecutiveTransitions, furthestStage, isExcludedDecision, isNotSelected, isSelected, reachedCountStage, STAGE_RANK, transitionResult } from "./stages";

export { OUTCOME_FLAG_CODES, qualityFlags, structuralIssues, validateOutcomeReport } from "./validate";
export type { OutcomeFlagCode, OutcomeIssue, ValidationContext, ValidationCycle, ValidationResult } from "./validate";

export { assessCycleQuality, MODAL_WEEK_MIN_REPORTS } from "./quality";
export type { CycleQualityInput, CycleQualityResult, FlagUpdate, QualityReportRow } from "./quality";

export { addMonthsIso, giveToGetAccess } from "./give-to-get";
export type { GiveToGetAccess, GiveToGetInput } from "./give-to-get";

export { countsForDisplay, summaryCountRows } from "./aggregate";
export type { DisclosureCountRow, SummaryCountRows, SummaryGrain, SummaryReport } from "./aggregate";

export {
  allBandGatesPass,
  bandDisplayStatus,
  BANDS_LIVE_NOTE,
  OFFICIAL_BASE_RATE_ONLY_NOTE,
  OUTCOME_SUMMARY_BAND_STATUSES,
  OutcomeSummaryCycleSchema,
  OutcomeSummarySchema,
  ReleasedTableSchema,
} from "./summary-contract";
export type { BandGateFlags, OutcomeSummary, OutcomeSummaryBandStatus, OutcomeSummaryCycle, ReleasedTableView } from "./summary-contract";
