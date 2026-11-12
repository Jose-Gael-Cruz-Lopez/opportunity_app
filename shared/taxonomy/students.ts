import { z } from "zod";

/** Class years, institution facts and other non-sensitive student vocabulary. */

export const CLASS_YEARS = [
  "incoming_first_year",
  "first_year",
  "second_year",
  "third_year",
  "fourth_year",
  "fifth_year_plus",
  "recent_graduate",
  "graduate",
] as const;
export const ClassYearSchema = z.enum(CLASS_YEARS);
export type ClassYear = z.infer<typeof ClassYearSchema>;

export const CLASS_YEAR_LABELS: Record<ClassYear, string> = {
  incoming_first_year: "Incoming first-year",
  first_year: "First-year",
  second_year: "Second-year",
  third_year: "Third-year",
  fourth_year: "Fourth-year",
  fifth_year_plus: "Fifth year or later",
  recent_graduate: "Recent graduate",
  graduate: "Graduate student",
};

/** The audience Novus is built for; product copy and onboarding default to these. */
export const PRIMARY_CLASS_YEARS = ["incoming_first_year", "first_year", "second_year"] as const satisfies readonly ClassYear[];

/** Zero-based year of study used by standing math; null where it does not apply. */
export const CLASS_YEAR_INDEX: Record<ClassYear, number | null> = {
  incoming_first_year: 0,
  first_year: 1,
  second_year: 2,
  third_year: 3,
  fourth_year: 4,
  fifth_year_plus: 5,
  recent_graduate: null,
  graduate: null,
};

export const INSTITUTION_LEVELS = ["two_year", "four_year", "other"] as const;
export const InstitutionLevelSchema = z.enum(INSTITUTION_LEVELS);
export type InstitutionLevel = z.infer<typeof InstitutionLevelSchema>;

export const ENROLLMENT_INTENSITIES = ["full_time", "part_time", "not_sure"] as const;
export const EnrollmentIntensitySchema = z.enum(ENROLLMENT_INTENSITIES);
export type EnrollmentIntensity = z.infer<typeof EnrollmentIntensitySchema>;

/** IPEDS calendar systems as received; the last two make standing measures return unknown. */
export const INSTITUTION_CALENDARS = [
  "semester",
  "quarter",
  "trimester",
  "four_one_four",
  "other_academic",
  "differs_by_program",
  "continuous",
] as const;
export const InstitutionCalendarSchema = z.enum(INSTITUTION_CALENDARS);
export type InstitutionCalendar = z.infer<typeof InstitutionCalendarSchema>;

export const TRANSFER_INTENTS = ["planning_to_transfer", "transferred_in", "not_planning", "not_sure"] as const;
export const TransferIntentSchema = z.enum(TRANSFER_INTENTS);
export type TransferIntent = z.infer<typeof TransferIntentSchema>;

/**
 * GPA bands on a 4.0 scale. Edges are proposed values; the contract freeze may move them so most
 * published GPA floors fall on an edge. `min`/`max` are inclusive-exclusive bounds used by the
 * eligibility evaluator (a band that straddles a floor gives "unknown", never "met").
 */
export const GPA_BANDS = [
  "none_yet",
  "under_2_0",
  "2_0_to_2_49",
  "2_5_to_2_74",
  "2_75_to_2_99",
  "3_0_to_3_24",
  "3_25_to_3_49",
  "3_5_to_3_74",
  "3_75_plus",
  "prefer_not",
] as const;
export const GpaBandSchema = z.enum(GPA_BANDS);
export type GpaBand = z.infer<typeof GpaBandSchema>;

export const GPA_BAND_BOUNDS: Record<GpaBand, { min: number; max: number } | null> = {
  none_yet: null,
  under_2_0: { min: 0, max: 2.0 },
  "2_0_to_2_49": { min: 2.0, max: 2.5 },
  "2_5_to_2_74": { min: 2.5, max: 2.75 },
  "2_75_to_2_99": { min: 2.75, max: 3.0 },
  "3_0_to_3_24": { min: 3.0, max: 3.25 },
  "3_25_to_3_49": { min: 3.25, max: 3.5 },
  "3_5_to_3_74": { min: 3.5, max: 3.75 },
  "3_75_plus": { min: 3.75, max: 4.01 },
  prefer_not: null,
};

/** Generic prior-experience answers (no program names, so no answer stands in for a status). */
export const EXPERIENCE_KINDS = [
  "research",
  "internship",
  "insight_program",
  "leadership",
  "community_service",
  "independent_project",
  "paid_work",
  "competition",
  "teaching_or_tutoring",
] as const;
export const ExperienceKindSchema = z.enum(EXPERIENCE_KINDS);
export type ExperienceKind = z.infer<typeof ExperienceKindSchema>;

export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
  "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC",
  "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "AS", "GU", "MP", "PR", "VI", "UM",
] as const;
export const UsStateSchema = z.enum(US_STATES);
export type UsState = z.infer<typeof UsStateSchema>;
