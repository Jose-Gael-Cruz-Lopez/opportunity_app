/**
 * The Outcome vocabulary this module works on, restated locally.
 *
 * shared/readiness stays importable from any runtime with nothing but its own files and zod
 * (purity.test.ts), so the enum lists from shared/taxonomy are mirrored here. outcomes.test.ts
 * asserts that every list below equals its shared/taxonomy (and shared/disclosure) original, so
 * the copies cannot drift.
 */

/** s09 9.5.1, in the order stages happen. `not_nominated` ends the campus round. */
export const OUTCOME_STAGE_ORDER = [
  "submitted",
  "campus_nominated",
  "not_nominated",
  "interview_invited",
  "interviewed",
  "waitlisted",
] as const;
export type OutcomeStageCode = (typeof OUTCOME_STAGE_ORDER)[number];

/** No `pending`: a missing decision means undecided. */
export const OUTCOME_DECISION_CODES = ["accepted", "rejected", "withdrew", "declined_offer", "no_response"] as const;
export type OutcomeDecisionCode = (typeof OUTCOME_DECISION_CODES)[number];

export const OUTCOME_TIER_CODES = ["self_reported", "institution_email", "letter_checked", "email_authenticated", "official_list"] as const;
export type OutcomeTierCode = (typeof OUTCOME_TIER_CODES)[number];

/** shared/disclosure's countedTiers: displayed aggregates, calibration and bands use these only. */
export const COUNTED_TIER_CODES = ["institution_email", "letter_checked", "email_authenticated", "official_list"] as const;

/** Official count stages, in funnel order (alternates sit outside the chain). */
export const COUNT_STAGE_CODES = ["campus_applicants", "applicants", "nominees", "finalists", "awards", "alternates"] as const;
export type CountStageCode = (typeof COUNT_STAGE_CODES)[number];

export const FUNNEL_STAGE_CODES = ["campus_applicants", "applicants", "nominees", "finalists", "awards"] as const;

/** Institution levels (shared/taxonomy INSTITUTION_LEVELS): the only fairness audit group. */
export const INSTITUTION_LEVEL_CODES = ["two_year", "four_year", "other"] as const;
export type InstitutionLevelCode = (typeof INSTITUTION_LEVEL_CODES)[number];

/** A dated stage as stored (to the day) and shown (by week). */
export interface DatedStage {
  readonly stage: OutcomeStageCode;
  readonly on: string | null;
}

/** The fields of one report that validators, aggregates and the stage mapping read. */
export interface OutcomeFacts {
  readonly stages: readonly DatedStage[];
  readonly decision: OutcomeDecisionCode | null;
  readonly decidedOn: string | null;
}

export function isCountedTier(tier: string): boolean {
  return (COUNTED_TIER_CODES as readonly string[]).includes(tier);
}
