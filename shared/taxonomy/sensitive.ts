import { z } from "zod";

/**
 * Vocabulary for SensitiveAnswers: immigration status, Pell and income, first-generation status
 * and identity categories. These values exist so rule sets can be written and the browser can ask
 * the questions. No server route, table, log, analytics event or LLM prompt may carry an answer.
 */

/** Citizenship and immigration status, as rule sets encode it (F-1 and J-1 stay distinguishable). */
export const CITIZENSHIP_STATUSES = [
  "us_citizen",
  "us_national",
  "permanent_resident",
  "daca",
  "tps",
  "refugee_asylee",
  "f1",
  "j1",
  "other_visa",
  "none_of_these",
] as const;
export const CitizenshipSchema = z.enum(CITIZENSHIP_STATUSES);
export type Citizenship = z.infer<typeof CitizenshipSchema>;

export const PELL_ANSWERS = ["recipient", "eligible_not_receiving", "not_recipient", "prefer_not"] as const;
export const PellAnswerSchema = z.enum(PELL_ANSWERS);
export type PellAnswer = z.infer<typeof PellAnswerSchema>;

/** Yes/no answers for status questions; `prefer_not` keeps the related rule pending. */
export const STATUS_ANSWERS = ["yes", "no", "not_sure", "prefer_not"] as const;
export const StatusAnswerSchema = z.enum(STATUS_ANSWERS);
export type StatusAnswer = z.infer<typeof StatusAnswerSchema>;

export const IDENTITY_CATEGORIES = [
  "race_ethnicity",
  "gender_identity",
  "sexual_orientation",
  "health",
  "religion",
  "tribal_affiliation",
  "military_veteran",
  "foster_care",
  "crime_victim",
  "parenting",
] as const;
export const IdentityCategorySchema = z.enum(IDENTITY_CATEGORIES);
export type IdentityCategory = z.infer<typeof IdentityCategorySchema>;

export const IDENTITY_CATEGORY_LABELS: Record<IdentityCategory, string> = {
  race_ethnicity: "Race or ethnicity",
  gender_identity: "Gender",
  sexual_orientation: "Sexual orientation",
  health: "Disability or health condition",
  religion: "Religion",
  tribal_affiliation: "Tribal affiliation",
  military_veteran: "Military service",
  foster_care: "Foster care experience",
  crime_victim: "Crime victim status",
  parenting: "Parenting student",
};

/**
 * Values a program audience or rule may name per category. Race and ethnicity follow the
 * 2024 OMB minimum categories; categories with a single trait use "yes".
 */
export const IDENTITY_VALUES: Record<IdentityCategory, readonly string[]> = {
  race_ethnicity: [
    "american_indian_alaska_native",
    "asian",
    "black_african_american",
    "hispanic_latino",
    "middle_eastern_north_african",
    "native_hawaiian_pacific_islander",
    "white",
  ],
  gender_identity: ["woman", "man", "nonbinary", "another_gender"],
  sexual_orientation: ["lgbtq"],
  health: ["yes"],
  religion: ["yes"],
  tribal_affiliation: ["enrolled_member", "descendant"],
  military_veteran: ["veteran", "active_duty", "military_family"],
  foster_care: ["yes"],
  crime_victim: ["yes"],
  parenting: ["yes"],
};

/**
 * Key stems that mark a property as sensitive. Server code uses this list to refuse a request
 * that carries any of them, without logging the value. Registry flags such as
 * `sensitiveAudience` or `pellDisplacement` are allowlisted because they describe programs.
 */
export const SENSITIVE_KEY_STEMS = [
  "citizen",
  "immigra",
  "daca",
  "tps",
  "visa",
  "undocumented",
  "asylum",
  "asylee",
  "refugee",
  "greencard",
  "green_card",
  "pell",
  "income",
  "firstgen",
  "first_gen",
  "firstgeneration",
  "race",
  "ethnic",
  "hispanic",
  "latin",
  "gender",
  "sexual",
  "orientation",
  "pronoun",
  "lgbt",
  "disab",
  "religio",
  "tribal",
  "veteran",
  "military",
  "foster",
  "identity",
  "sensitive",
] as const;

export const SENSITIVE_KEY_ALLOWLIST = [
  "sensitiveAudience",
  "sensitive_audience",
  "identityAudience",
  "identity_audience",
  "pellDisplacement",
  "pell_displacement",
  "sensitive", // the boolean flag on a rule or result names sensitivity; it never holds an answer
  "sensitiveEvaluated",
  "sensitiveOptIn", // a consent flag for a program, not an answer
] as const;
