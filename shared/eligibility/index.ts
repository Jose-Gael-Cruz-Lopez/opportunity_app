import type { EligibilityResult, EligibilityRuleSet } from "../contracts/eligibility";
import { evaluateCore, type EvaluateOptions } from "./evaluate";
import type { EligibilityProfile } from "./fields";

/**
 * shared/eligibility: the one eligibility engine for the browser, the Worker, MCP and Readiness.
 *
 * Server-safe by construction: nothing exported here accepts SensitiveAnswers or attestation
 * answers, so rules on citizenship, Pell, first-generation or identity, and every attestation,
 * always come back `unknown` with reason SENSITIVE_ON_DEVICE / ATTESTATION_ON_DEVICE. The browser
 * evaluates those through ./sensitive (evaluateWithAnswers), which this file must never import;
 * a test walks the import graph of server/** and this file to prove it.
 */

/** Option keys that would carry device-only answers; refused at runtime as well as by type. */
const DEVICE_ONLY_KEYS = ["answers", "sensitive", "sensitiveAnswers", "attestations"] as const;

export class SensitiveInputRejectedError extends Error {
  constructor(key: string) {
    super(`evaluateEligibility does not accept "${key}": sensitive answers are evaluated on the device only`);
    this.name = "SensitiveInputRejectedError";
  }
}

/**
 * Evaluates a rule set for a student's non-sensitive profile at `opts.asOf`.
 *
 * - verdict: met / not_met / unknown (strong Kleene over rules, anyOf groups, attestations and
 *   coverage); status: eligible / not_eligible / conditional (the student can resolve every open
 *   item) / unknown (Novus has not checked something).
 * - Each rule result names its reason code, plain-language reason, the official rule text, the
 *   fields that were missing (names only) and its evidence quote.
 * - `ruleSet` null (no verified rules) gives status unknown with a rule_set_missing item.
 */
export function evaluateEligibility(
  ruleSet: EligibilityRuleSet | null,
  profile: EligibilityProfile,
  opts: EvaluateOptions,
): EligibilityResult {
  for (const key of DEVICE_ONLY_KEYS) {
    if (opts && Object.prototype.hasOwnProperty.call(opts, key)) throw new SensitiveInputRejectedError(key);
  }
  return evaluateCore(ruleSet, profile, { asOf: opts.asOf, context: opts.context });
}

export type { EvaluateOptions } from "./evaluate";
export type { EligibilityProfile, FieldStatus } from "./fields";
export { ANCHOR_KINDS, EMPTY_CONTEXT, buildEvalContext } from "./context";
export type { AnchorKind, BuildEvalContextInput, DeadlineLike, EvalContext, EvalInstitution, InstitutionLike } from "./context";
export { and3, or3, not3, agree3, triToVerdict, verdictToTri, YES, NO, UNKNOWN } from "./kleene";
export type { Tri } from "./kleene";
export { REASON_CODES, REASON_TEMPLATES, SELF_CHECK_TEMPLATES, DIMENSION_LABELS, renderReason } from "./reasons";
export type { ReasonCode } from "./reasons";
export {
  ENGINE_VERSION,
  applyTemplate,
  assertImmutable,
  compareResults,
  computeRuleSetHash,
  currentRuleSet,
  diffRuleSets,
  hashMatches,
  isResultStale,
  parseRuleSet,
  reviseRuleSet,
  supersedeRuleSet,
  verifyRuleSet,
  RuleSetVersionError,
} from "./versioning";
export type { ChangeKind, CoverageChange, ResultChange, RuleChange, RuleSetDiff, RuleSetTemplate } from "./versioning";
export { canonicalJson, sha256Hex } from "./hash";
export { checkRuleSet } from "./lint";
export type { RuleSetIssue } from "./lint";
export {
  possibleAges,
  projectClassYear,
  remainingNativeTerms,
  semesterEquivalentsRemaining,
  termEndDate,
  termsPerYear,
} from "./standing";
