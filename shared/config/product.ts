import {
  ACADEMIC_TERMS,
  CLASS_YEARS,
  OPPORTUNITY_CATEGORIES,
  OPPORTUNITY_TYPES,
  PRIMARY_CLASS_YEARS,
  type AcademicTerm,
} from "../taxonomy";

/**
 * Product constants other modules cite. Values marked "judgment" are product choices to revisit
 * with student interviews, not measured facts.
 */
export const PRODUCT = {
  name: "Novus",
  audience: { primaryClassYears: PRIMARY_CLASS_YEARS, classYears: CLASS_YEARS },
  opportunity: { types: OPPORTUNITY_TYPES, categories: OPPORTUNITY_CATEGORIES },

  /** The weekly email lists what is due within this window; sent at the recipient's local hour. */
  weekly: { windowDays: 14, localHour: 18 },
  t2: { localHour: 9 },
  openingAlert: { daysBeforeP10: 7, minConfidence: "medium" },
  email: {
    quietHours: ["22:00", "08:00"],
    holdUnlessDeadlineWithinHours: 72,
    missedAfterMinutes: 60,
    examPause: { maxDays: 21 },
  },
  /** isInSeason: open, opening (or p10) within 30 days, or a deadline within 60 days. */
  inSeason: { openOrP10WithinDays: 30, deadlineWithinDays: 60 },
  /** Days since Curator verification: fresh up to the first value, aging to the second, then stale. */
  freshness: { inSeason: [14, 30], offSeason: [30, 90] },
  extensionCheckHours: 72,
  notInterestedDays: 90,
  sensitiveIdleClearMinutes: 30,
  /** Worker jobs with no stored zone use this zone for applicant-local deadlines. */
  fallbackTimeZone: "America/New_York",
  /** The latest US zone among institutions; orders applicant-local deadlines in public lists. */
  latestUsTimeZone: "Pacific/Pago_Pago",
  academicYearStartMonth: 8,
  readiness: { nextActionsCard: 3, nextActionsDetail: 5, hoursPerDay: 1, soonWithinDays: 14 },
  reports: { noteMaxChars: 280 },
  pagination: { defaultLimit: 25, maxLimit: 100 },
  ai: {
    /** Public pages and assistants quote at most this many words from a source. */
    maxExcerptWords: 25,
    maxQuestionChars: 1000,
    maxStatementChars: 12000,
    minStatementChars: 50,
    maxPromptChars: 2000,
    /** Per-student daily request caps (judgment) that keep spend bounded. */
    dailyRequestsPerStudent: { explain: 30, statementFeedback: 10, ask: 30, resumeExtract: 5 },
  },
  budgets: { clientCoreBrotliKB: 80, jsPerRouteKB: 150, pageHtmlCssKB: 100 },
} as const;

export type ProductConfig = typeof PRODUCT;

/** Seasons as planning terms in calendar order within an academic year that starts in the fall. */
export const ACADEMIC_YEAR_TERM_ORDER: readonly AcademicTerm[] = ["fall", "winter", "spring", "summer"];
export const SEASONS = ACADEMIC_TERMS;
