import { CLASS_YEARS, GPA_BANDS, INSTITUTION_LEVELS, MAJOR_FAMILIES, OUTCOME_DECISIONS, OUTCOME_STAGES } from "../taxonomy";

/**
 * Disclosure control for every Outcome-derived number (plan 9.6). Winners are named on official
 * lists, so "accepted, program X, school Y, GPA band Z" can identify a person; these thresholds
 * keep small groups from being exposed. This is the only implementation; thresholds live here.
 */
export const DISCLOSURE = {
  audiences: {
    /** Pages, API, MCP, feeds. */
    public: { minTotal: 5, minCell: 10 },
    /** Pilot and cohort counts inside one workspace. */
    advisor: { minTotal: 5, minCell: 5 },
    /** License, campus and community reports. */
    institution: { minTotal: 10, minCell: 10 },
    sponsor: { minTotal: 10, minCell: 10 },
    /** Funder exports. */
    grant: { minTotal: 10, minCell: 10 },
  },
  /** Counts below this show as bands; larger ones round to `roundTo`. */
  bandBelow: 20,
  roundTo: 5,
  /** Applicant-context breakdowns wait this long after a cycle's decisions complete (R6). */
  contextDelayDays: 14,
  /** No first-generation split below this table total (R8). */
  firstGenMinTotal: 20,
  /** Institution splits need this many accepted and not-accepted over this many cycles (R7). */
  institutionSplit: { minEachOutcome: 10, minCycles: 2 },
  /** Two-way tables ship with the differencing harness gate (backlog S09-075); off until then. */
  twoWayEnabled: false,
  countedTiers: ["institution_email", "letter_checked", "email_authenticated", "official_list"],
} as const;

export type Audience = keyof typeof DISCLOSURE.audiences;
export const AUDIENCES = Object.keys(DISCLOSURE.audiences) as Audience[];
export type Grain = "month" | "term" | "cycle";

/**
 * Pre-declared dimensions with their full category lists (R2 zero-fills from these, R4 allows
 * no free-form filters). `institution` has no fixed list: callers pass the institution ids and
 * R7 applies.
 */
export const DISCLOSURE_DIMENSIONS = {
  class_standing: CLASS_YEARS,
  gpa_band: GPA_BANDS,
  major_family: MAJOR_FAMILIES,
  first_gen: ["yes", "no", "unsure"],
  institution_type: INSTITUTION_LEVELS,
  stage: OUTCOME_STAGES,
  decision: OUTCOME_DECISIONS,
  institution: [],
} as const satisfies Record<string, readonly string[]>;

export type DisclosureDimension = keyof typeof DISCLOSURE_DIMENSIONS;
export const DISCLOSURE_DIMENSION_KEYS = Object.keys(DISCLOSURE_DIMENSIONS) as DisclosureDimension[];

/** Dimensions that describe applicants rather than the process; they wait for R6's delay. */
export const APPLICANT_CONTEXT_DIMENSIONS: readonly DisclosureDimension[] = [
  "class_standing",
  "gpa_band",
  "major_family",
  "first_gen",
  "institution_type",
  "institution",
];
