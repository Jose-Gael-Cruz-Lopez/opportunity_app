import { PRODUCT } from "../config/product";
import type { RequirementKind } from "../taxonomy";

/**
 * Methodology values for readiness, odds, bands and cycle prediction. Every value is judgment
 * unless a comment names a measured source; the founders revisit them with student interviews
 * and each completed cycle. Anti-abuse cut-offs never live here: the repository is public.
 */

export const READINESS_ALGO_VERSION = "readiness-v1.0.0";

/** Per-unit student effort and third-party lead time by requirement kind (plan 7.4.2). */
export interface LeadTimeRow {
  /** Student hours per unit of `quantity` (two letters = 2 × 1 h); null = informational item. */
  readonly effortHoursPerUnit: number | null;
  /** Calendar days the item needs after the student's own work (recommender, registrar). */
  readonly leadDays: number | null;
  /** Comfortable lead used for suggested dates (study: letters 35 days, campus-reviewed essays 21). */
  readonly targetLeadDays: number | null;
  /** True when the lead is someone else's time, so breaks (winter, Thanksgiving) slow it down. */
  readonly thirdParty: boolean;
}

export const LEAD_TIME_TABLE: Readonly<Record<RequirementKind, LeadTimeRow>> = {
  recommendation: { effortHoursPerUnit: 1, leadDays: 21, targetLeadDays: 35, thirdParty: true },
  essay: { effortHoursPerUnit: 6, leadDays: 14, targetLeadDays: 14, thirdParty: true },
  // "To the campus deadline": 0 days when the effective deadline already is the campus one.
  campus_nomination: { effortHoursPerUnit: 3, leadDays: 0, targetLeadDays: 0, thirdParty: true },
  test_score: { effortHoursPerUnit: 10, leadDays: 30, targetLeadDays: 30, thirdParty: false },
  portfolio: { effortHoursPerUnit: 10, leadDays: 14, targetLeadDays: 14, thirdParty: false },
  resume: { effortHoursPerUnit: 3, leadDays: 3, targetLeadDays: 3, thirdParty: false },
  transcript: { effortHoursPerUnit: 0.5, leadDays: 7, targetLeadDays: 7, thirdParty: true },
  interview: { effortHoursPerUnit: 3, leadDays: 2, targetLeadDays: 2, thirdParty: false },
  fee: { effortHoursPerUnit: 0.25, leadDays: 0, targetLeadDays: 0, thirdParty: false },
  other: { effortHoursPerUnit: 2, leadDays: 7, targetLeadDays: 7, thirdParty: false },
  coursework: { effortHoursPerUnit: null, leadDays: null, targetLeadDays: null, thirdParty: false },
  gpa_floor: { effortHoursPerUnit: null, leadDays: null, targetLeadDays: null, thirdParty: false },
};

export const READINESS_CONFIG = {
  /** The plan's parallel-preparation assumption (plan 7.4.2; s06's start-by uses the same value). */
  hoursPerDay: PRODUCT.readiness.hoursPerDay,
  soonWithinDays: PRODUCT.readiness.soonWithinDays,
  nextActions: { card: PRODUCT.readiness.nextActionsCard, detail: PRODUCT.readiness.nextActionsDetail },
  capacity: {
    /** Used when the student has not set weekly hours: 7 h/week matches hoursPerDay = 1. */
    defaultWeeklyHours: PRODUCT.readiness.hoursPerDay * 7,
    /** Planning-fallacy padding for suggested dates (Buehler et al. 1994: 55.5 vs 33.9 days). */
    suggestedEffortPadding: 1.5,
    /** Students rarely plan more than this; caps the walk so a tiny capacity cannot loop for years. */
    maxPlanningDays: 3650,
  },
  campus: {
    /** Campus lead defaults until a program has five known campus deadlines (s06 6.4.5). */
    l80Days: 70,
    l50Days: 42,
    /** Campus-reviewed essays need longer (study: 21 days for nationally competitive awards). */
    reviewedEssayTargetLeadDays: 21,
    confirmWithinDays: 7,
  },
  odds: {
    /** Internal Jeffreys interval for official stage odds (never shown; negligible at official n). */
    intervalLevel: 0.8,
  },
  pooling: {
    gridMu: 60,
    gridLogM: 60,
    logMRange: [-1, 8] as const,
    level: 0.8,
    minGroups: 5,
    conflictAlpha: 0.05,
  },
  level0: {
    decay: 0.7,
    tau2Fallback: 0.09,
    minCyclesForTau2: 3,
    minPooledForecasts: 60,
    coverageBand: [0.7, 0.9] as const,
    level: 0.8,
  },
  bands: {
    /** Odds-ratio threshold for a non-typical band (plan D3: symmetric for every base rate). */
    thresholdLogOdds: Math.log(1.5),
    intervalLevel: 0.8,
    /** Prior sd on each centred 0/1 column (range-1 scaling; lighter-tailed than Cauchy(0, 2.5) on purpose). */
    priorSd: 0.5,
    interceptPriorSd: 5,
    perProgram: { minNEff: 30, minEachOutcome: 8 },
    pooled: { minNEff: 250, minShrinkage: 0.9 },
    kingZengToleranceLogit: 0.1,
    minCellReports: 10,
    minNonTypicalShare: 0.05,
    /**
     * minClusters: a cluster (program) bootstrap over fewer programs has almost no resampling
     * variety (one program gives the point estimate every time), so its bounds are not evidence.
     */
    heldOut: { minBssLower: 0, minAucLower: 0.6, slopeRange: [0.5, 1.5] as const, maxAbsSpiegelhalterZ: 1.645, minClusters: 5 },
    /** Plan 7.5.6: a group passes when the 90% upper bound of its calibration gap is under 10 points. */
    fairness: { maxGap: 0.1, minItems: 20, minClusters: 5 },
  },
  prediction: {
    widths: { restated: 0, carriedOver: 6, fixedDate: 6, weekdayTight: 14, weekdayLoose: 42, curatorEstimatePad: 7 },
    labels: { highMaxDays: 14, mediumMaxDays: 42 },
    gate: { minScored: 50, minWilsonLower: 0.7, wilsonLevel: 0.9 },
    conformal: { alpha: 0.2, minPerStratum: 20 },
    kappaDays: 90,
  },
} as const;

/** Default study-time blackouts (student work continues; recommenders and registrars slow down). */
export const DEFAULT_BLACKOUT_RULES = {
  /** Thanksgiving Wednesday to Sunday: the 4th Thursday of November minus 1 to plus 3. */
  thanksgiving: { fromOffsetDays: -1, toOffsetDays: 3 },
  /** Winter break, inclusive. */
  winter: { from: { month: 12, day: 22 }, to: { month: 1, day: 2 } },
} as const;
