import type { DeadlineLike } from "./deadline";
import type { RequirementLike } from "./requirements";
import type { EligibilityPending, EligibilityResult, EligibilityRuleResult, NominationProcess } from "../contracts/eligibility";
import type { StageOdds } from "../contracts/registry";

/**
 * TEST FIXTURES (not exported from the module). Ids, institutions and eligibility results are
 * synthetic. The official counts are the plan's own fixtures (plan 07 §7.5.1, each checked on the
 * official page on 2026-11-09) and carry their source URLs; they test arithmetic and copy only.
 */

export const fixtureId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const PROGRAM_ID = fixtureId(101);
export const CYCLE_ID = fixtureId(102);
export const CAMPUS_ID = fixtureId(900);

/** Goldwater's national nomination deadline: "the last Friday in January at 5:00 p.m. Central Time". */
export const GOLDWATER_DEADLINE: DeadlineLike = {
  id: fixtureId(110),
  kind: "nomination",
  scope: "national",
  institutionId: null,
  basis: "official",
  precision: "exact",
  tzMode: "fixed",
  localDate: "2027-01-29",
  localTime: "17:00",
  timeZone: "America/Chicago",
};

/** A synthetic direct-application deadline (11:59 pm in the applicant's own zone). */
export const APPLICATION_DEADLINE: DeadlineLike = {
  id: fixtureId(111),
  kind: "application",
  scope: "national",
  institutionId: null,
  basis: "official",
  precision: "exact",
  tzMode: "applicant_local",
  localDate: "2027-02-15",
  localTime: "23:59",
  timeZone: null,
};

/**
 * A sample checklist for a nomination-gated award. The letters and the research essay follow
 * plan 7.4.3's Goldwater example; the campus nomination, résumé and transcript rows are synthetic
 * additions for test coverage, not a statement of any program's requirements.
 */
export const SAMPLE_CHECKLIST: RequirementLike[] = [
  { id: fixtureId(120), kind: "recommendation", label: "Three letters of recommendation", quantity: 3 },
  { id: fixtureId(121), kind: "essay", label: "Research essay" },
  { id: fixtureId(122), kind: "campus_nomination", label: "Campus nomination" },
  { id: fixtureId(123), kind: "resume", label: "Résumé" },
  { id: fixtureId(124), kind: "transcript", label: "Official transcript" },
];

export const GOLDWATER_NOMINATION: NominationProcess = {
  nominator: "campus_rep",
  campusDeadlineKinds: ["campus_internal"],
  quota: { base: 4, max: 6, bonuses: [{ if: "any_nominee_transfer_or_veteran", add: 1 }, { if: "nominees_include_both", add: 1 }] },
  evidenceKey: null,
};

const GOLDWATER_SOURCE = "https://goldwaterscholarship.gov/2026-awards-press-release/";
const verified = { verifiedAt: "2026-11-09", verifiedBy: "Novus Curator AB" } as const;

/** Goldwater 2026: an estimated pool of over 5,000, 1,485 nominees and 454 awards. */
export const GOLDWATER_STAGE_ODDS: StageOdds[] = [
  { fromStage: "campus_applicants", toStage: "nominees", cycleYear: 2026, numerator: 1485, denominator: 5000, denominatorKind: "lower_bound", sourceUrl: GOLDWATER_SOURCE, ...verified },
  { fromStage: "nominees", toStage: "awards", cycleYear: 2026, numerator: 454, denominator: 1485, denominatorKind: "exact", sourceUrl: GOLDWATER_SOURCE, ...verified },
];

/** Truman 2026: 55 of 781 nominees. */
export const TRUMAN_STAGE_ODDS: StageOdds[] = [
  { fromStage: "nominees", toStage: "awards", cycleYear: 2026, numerator: 55, denominator: 781, denominatorKind: "exact", sourceUrl: "https://www.truman.gov/2026PressRelease", ...verified },
];

function rule(extra: Partial<EligibilityRuleResult> & Pick<EligibilityRuleResult, "ruleId" | "dimension" | "verdict">): EligibilityRuleResult {
  return {
    group: "all",
    sensitive: false,
    reasonCode: extra.verdict === "met" ? "ELIGIBLE_STANDING" : "MISSING_FIELD",
    reason: "Sample reason",
    officialText: "Sample official rule text",
    missingFields: [],
    resolver: null,
    evidenceKey: null,
    evidence: null,
    ...extra,
  };
}

const PRIVATE_PENDING: EligibilityPending = {
  id: "citizenship",
  kind: "rule",
  dimension: "citizenship",
  sensitive: true,
  resolver: "student",
  selfCheckText: "Eligible if you meet the program's citizenship rule.",
};

const PARTICIPATION_PENDING: EligibilityPending = {
  id: "institution-participates",
  kind: "rule",
  dimension: "institution",
  sensitive: false,
  resolver: "student",
  selfCheckText: "Eligible if your school takes part (ask your campus representative).",
};

/** The 7.4.3 example: conditional, citizenship answered privately, campus participation pending. */
export function conditionalEligibility(asOf = "2026-11-09"): EligibilityResult {
  return {
    verdict: "unknown",
    status: "conditional",
    rules: [
      rule({ ruleId: "standing", dimension: "standing", verdict: "met", reason: "You are a second-year student." }),
      rule({ ruleId: "citizenship", dimension: "citizenship", verdict: "unknown", sensitive: true, reasonCode: "SENSITIVE_ON_DEVICE", resolver: "student" }),
      rule({ ruleId: "institution-participates", dimension: "institution", verdict: "unknown", resolver: "student" }),
    ],
    pending: [PRIVATE_PENDING, PARTICIPATION_PENDING],
    nomination: GOLDWATER_NOMINATION,
    ruleSet: null,
    basedOnListedRequirements: false,
    asOf,
    sensitiveEvaluated: false,
  };
}

export function eligibleResult(asOf = "2026-11-09"): EligibilityResult {
  return {
    verdict: "met",
    status: "eligible",
    rules: [
      rule({ ruleId: "standing", dimension: "standing", verdict: "met" }),
      rule({ ruleId: "gpa", dimension: "gpa", verdict: "met" }),
    ],
    pending: [],
    nomination: null,
    ruleSet: null,
    basedOnListedRequirements: false,
    asOf,
    sensitiveEvaluated: false,
  };
}

export function notEligibleResult(asOf = "2026-11-09"): EligibilityResult {
  return {
    verdict: "not_met",
    status: "not_eligible",
    rules: [rule({ ruleId: "standing", dimension: "standing", verdict: "not_met", reasonCode: "NOT_ELIGIBLE_STANDING", reason: "The program is for third-year students." })],
    pending: [],
    nomination: null,
    ruleSet: null,
    basedOnListedRequirements: false,
    asOf,
    sensitiveEvaluated: false,
  };
}
