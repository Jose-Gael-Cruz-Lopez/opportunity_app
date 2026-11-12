/**
 * shared/readiness: how ready a student is for one program cycle, as four visible parts and
 * never one number (see README.md for every formula).
 *
 *   assessReadiness(input) -> ReadinessReport   eligibility, requirements, competitiveness, nextActions
 *
 * Also exported: official stage odds and funnels, Level 0 next-cycle odds, hierarchical pooling,
 * the Phase 4 band model with its gates, calibration utilities for offline evaluation, capacity-aware
 * scheduling, effective deadlines and the cycle predictor. Everything is pure and deterministic.
 */
export { assessReadiness, assessReadinessDetailed } from "./assess";
export type { ReadinessDetail, ReadinessInput, ReadinessCycleInput, ReadinessProfileInput, ReadinessProgramInput, TrackedWorkload } from "./assess";

export { READINESS_ALGO_VERSION, READINESS_CONFIG, LEAD_TIME_TABLE, DEFAULT_BLACKOUT_RULES } from "./config";
export type { LeadTimeRow } from "./config";

export { summarizeEligibility, missingEligibilityResult } from "./eligibility";
export type { EligibilitySummary, RuleLine } from "./eligibility";

export {
  analyzeRequirement,
  effortDays,
  effortHoursFor,
  gapText,
  isolatedLatestStart,
  leadDaysFor,
  prepDays,
  progressMap,
  requirementQuantity,
  REUSABLE_KINDS,
  scheduleTasks,
  severityFor,
  targetLeadDaysFor,
  toChecklistItem,
} from "./requirements";
export type { AnalyzeContext, LeadContext, ProgressEntry, ProgressState, RequirementAnalysis, RequirementLike } from "./requirements";

export { backwardFill, demandBoundCheck, levelledLoad, supplyBetween, weeklyCapacity, whatFits } from "./schedule";
export type { BackwardFillResult, CapacityModel, DemandBoundResult, DemandBoundRow, FitJob, LevelledLoad, ScheduleTask, WhatFitsResult } from "./schedule";

export {
  blackoutDaySet,
  defaultBlackouts,
  epochDayOf,
  isoFromEpochDay,
  nthWeekdayOfMonth,
  sameMonthDayInYear,
  sameWeekdayNear,
  subtractAvailableDays,
  usThanksgiving,
  weekdayOfEpochDay,
} from "./calendar";
export type { BlackoutPeriod, IsoDate } from "./calendar";

export { finalNationalDeadline, planDeadline, resolveEffectiveDeadline } from "./deadline";
export type { CampusLead, DeadlineLike, EffectiveDeadline, EffectiveDeadlineBasis, EffectiveDeadlineInput, EffectiveDeadlineStep, PlannedDeadline } from "./deadline";

export { applyItemKey, buildNextActions, buildNextActionsDetailed, NEXT_ACTION_REASONS, prepItemKey } from "./next-actions";
export type { NextActionContext, NextActionReason, NextActionsResult, OverloadSignal, PlannedItem } from "./next-actions";

export {
  buildFunnel,
  currentStageFor,
  entryAccess,
  formatCount,
  FUNNEL_ORDER,
  naturalFrequency,
  officialRateInterval,
  officialStageOdds,
  ratioKind,
  stageNoun,
  stageOddsSentence,
  transitionForStudent,
} from "./odds";
export type { EntryAccess, Funnel, FunnelStep, OfficialCountRow, StudentTransition } from "./odds";

export { assessCompetitiveness, BAND_LABELS, displayedNEff } from "./competitiveness";
export type { CompetitivenessInput } from "./competitiveness";

export {
  conformalQuantile,
  empiricalLogit,
  empiricalLogitVariance,
  forwardChainLevelZero,
  levelZeroForecast,
  levelZeroGate,
  pooledTau2,
} from "./level0";
export type { CoverageGate, ForwardForecast, LevelZeroForecast, LevelZeroOptions, StageHistoryPoint } from "./level0";

export { betaMixtureSummary, empiricalBayesBetaBinomial, hierarchicalBetaBinomial, kishEffectiveSize, weightedStageCounts } from "./pooling";
export type { HierarchicalOptions, HierarchicalResult, PooledEstimate, PoolGroup } from "./pooling";

export {
  aggregateBandCells,
  assertAllowedSpecs,
  BAND_FEATURE_KEYS,
  bandCellKey,
  bandColumns,
  BandFeatureSpecSchema,
  bandForStudent,
  bandLevelsFromProfile,
  BandModelSchema,
  bandProbability,
  codeLevels,
  decideBand,
  fitBandModel,
  heldOutScoredItems,
  modelCardCoefficients,
  nonTypicalShare,
  observedRateByBand,
  PRIOR_PROGRAM_KINDS,
  studentContrast,
  toBandModel,
} from "./bands";
export type {
  BandCalibrationRow,
  BandCell,
  BandColumn,
  BandFeatureKey,
  BandFeatureSpec,
  BandFitInput,
  BandLabel,
  BandLevels,
  BandModel,
  BandModelFit,
  BandModelMeta,
  BandOutcome,
  FeatureContribution,
  PooledBandStats,
  ProgramBandStats,
  StudentContrast,
} from "./bands";

export {
  auc,
  brierScore,
  brierSkill,
  calibrationInTheLarge,
  calibrationSlope,
  clusterBootstrap,
  clusterCount,
  corpDecomposition,
  fairnessGate,
  heldOutGates,
  logLoss,
  maxReliabilityGap,
  pavIsotonic,
  plattApply,
  plattFit,
  reliabilityBins,
  spiegelhalterZ,
} from "./calibration";
export type {
  BootstrapInterval,
  CorpDecomposition,
  GroupCalibrationGap,
  GroupScored,
  HeldOutGateReport,
  IsotonicBlock,
  LogisticCalibration,
  PlattFit,
  ReliabilityBin,
  Scored,
} from "./calibration";

export { coxSnellR2, maxCoxSnellR2, rileyMeanRiskN, rileyMinimumN, vanHouwelingenShrinkage } from "./samplesize";

export {
  applyDateRule,
  conformalWidths,
  CYCLE_EVENT_KINDS,
  CycleEventKindSchema,
  DateRuleSchema,
  historyFor,
  inferDateRule,
  intervalResidualDays,
  intervalScore,
  kappaForWidth,
  labelForWidth,
  lookupConformal,
  predictCycleEvent,
  predictionLabelGate,
  scorePrediction,
  toPrediction,
} from "./predict";
export type {
  ConformalWidth,
  ConformalWidthTable,
  CycleEventKind,
  CycleInputs,
  CyclePrediction,
  DateRule,
  DateRuleInput,
  ExpectedMonth,
  HistoryInterval,
  LabelGate,
  ObservedEvent,
  PredictionDetailMethod,
  PredictionResidual,
  PredictOptions,
} from "./predict";

export { jeffreysInterval, wilsonHalfWidth, wilsonInterval, wilsonLowerBound } from "./math/intervals";
export type { Interval } from "./math/intervals";
export {
  betaDensity,
  betaQuantile,
  clampProbability,
  digamma,
  expit,
  log1pExp,
  logBeta,
  logGamma,
  logit,
  normalCdf,
  normalQuantile,
  regularizedIncompleteBeta,
  studentTQuantile,
  trigamma,
  Z80,
  Z90,
} from "./math/special";
export { createRng, mulberry32 } from "./math/random";
export type { Rng } from "./math/random";
