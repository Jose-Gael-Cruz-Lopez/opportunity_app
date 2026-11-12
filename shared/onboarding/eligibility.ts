import {
  LAUNCH_DIMENSIONS,
  type EligibilityPending,
  type EligibilityRuleSet,
  type EligibilityStatus,
} from "../contracts/eligibility";
import type { DeadlineView, ProgramCard } from "../contracts/registry";
import type { StudentProfile } from "../contracts/student";
// The server-safe entry point only. ../eligibility/sensitive (which takes SensitiveAnswers) is
// never imported here, so this module stays safe to run in the Worker.
import { buildEvalContext, evaluateEligibility } from "../eligibility";
import { CLASS_YEAR_LABELS } from "../taxonomy";
import { joinLabels } from "./text";
import type { EligibilityCheck } from "./types";

/**
 * Eligibility for onboarding. The evaluator is shared/eligibility's, so this module never forks
 * the eligibility semantics; findMatches takes it as an adapter (default: `defaultEligibility`)
 * so a browser can pass a wrapper that also reads the student's private answers on the device.
 * Only `status` and `pending` of the contract's EligibilityResult are read here.
 *
 * Onboarding never asks status or identity questions and never passes SensitiveAnswers to the
 * adapter from a server. A browser wrapper may evaluate them on the device; the results it
 * returns stay in memory with the MatchSet and are never sent.
 */
export interface EligibilityOutcome {
  readonly status: EligibilityStatus;
  readonly pending: readonly Pick<EligibilityPending, "id" | "sensitive" | "resolver" | "selfCheckText">[];
}

export type EligibilityAdapter = (program: ProgramCard, profile: StudentProfile, asOf: string) => EligibilityOutcome;

/**
 * A conservative check that needs no rule engine, used when the engine cannot read a rule set
 * (and in tests as a reference):
 * - the card's class-year facet is the only fact it decides on (a listed year that excludes
 *   the student gives not_eligible, an unanswered year leaves a student check);
 * - every other rule becomes an "Eligible if ..." check with the official text, sensitive or
 *   not as the rule says, so the student confirms it rather than Novus guessing;
 * - a missing rule set, a not_reviewed dimension or a missing launch dimension leaves a Novus
 *   check, which can never display as eligible (plan 06, 6.4.3).
 */
export const facetEligibility: EligibilityAdapter = (card, profile) => {
  const pending: EligibilityOutcome["pending"][number][] = [];
  const years = card.classYears;
  if (years.length > 0) {
    if (profile.classYear !== null && !years.includes(profile.classYear)) {
      return { status: "not_eligible", pending: [] };
    }
    if (profile.classYear === null) {
      pending.push({
        id: "facet:class_year",
        sensitive: false,
        resolver: "student",
        selfCheckText: `Eligible if you are a ${joinLabels(years.map((y) => CLASS_YEAR_LABELS[y].toLowerCase()))} student`,
      });
    }
  }
  const rules: EligibilityRuleSet | null = card.rules;
  if (rules === null) {
    pending.push({
      id: "rule_set_missing",
      sensitive: false,
      resolver: "novus",
      selfCheckText: "Novus has not checked this program's rules yet: see the official page",
    });
    return { status: "unknown", pending };
  }
  for (const rule of rules.rules) {
    // The class-year facet is built from the standing rules, so it settles them (a match) or
    // already asks the student to check them (no year given); a second line would repeat it.
    if (rule.dimension === "standing" && years.length > 0) continue;
    pending.push({ id: rule.id, sensitive: rule.sensitive, resolver: "student", selfCheckText: `Eligible if: ${rule.officialText}` });
  }
  for (const a of rules.attestations) {
    pending.push({ id: a.id, sensitive: a.sensitive, resolver: "student", selfCheckText: `Eligible if you meet: ${a.text}` });
  }
  for (const dim of LAUNCH_DIMENSIONS) {
    const coverage = rules.coverage[dim];
    if (coverage === undefined || coverage === "not_reviewed") {
      pending.push({ id: `coverage:${dim}`, sensitive: false, resolver: "novus", selfCheckText: "Novus has not checked every rule yet: see the official page" });
    }
  }
  for (const [dim, coverage] of Object.entries(rules.coverage)) {
    if (coverage === "not_reviewed" && !(LAUNCH_DIMENSIONS as readonly string[]).includes(dim)) {
      pending.push({ id: `coverage:${dim}`, sensitive: false, resolver: "novus", selfCheckText: "Novus has not checked every rule yet: see the official page" });
    }
  }
  if (pending.length === 0) return { status: "eligible", pending };
  return { status: pending.some((p) => p.resolver === "novus") ? "unknown" : "conditional", pending };
};

/** Converts an outcome to the checks a card shows, deduplicating Novus-side items into one line. */
export function toChecks(outcome: EligibilityOutcome): EligibilityCheck[] {
  const out: EligibilityCheck[] = [];
  let novusShown = false;
  for (const p of outcome.pending) {
    if (p.resolver === "novus") {
      if (novusShown) continue;
      novusShown = true;
    }
    out.push({ text: p.selfCheckText.slice(0, 400), sensitive: p.sensitive, resolver: p.resolver });
  }
  return out.slice(0, 20);
}

/** A card's national deadline rows in the shape shared/eligibility's buildEvalContext reads. */
export type ContextDeadline = DeadlineView & { readonly institutionId: null };

/**
 * Wraps shared/eligibility for findMatches without importing it here (so this module never
 * forks or pins that engine). Integration passes the real functions:
 *
 *   eligibilityAdapterFrom(evaluateEligibility, buildEvalContext)
 *
 * evaluateEligibility is server-safe: it refuses SensitiveAnswers, so status and identity rules
 * come back as student checks ("Eligible if ..."), exactly what onboarding shows.
 */
export function eligibilityAdapterFrom<C>(
  evaluate: (ruleSet: EligibilityRuleSet | null, profile: Readonly<Partial<StudentProfile>>, opts: { readonly asOf: string; readonly context?: C }) => EligibilityOutcome,
  buildContext?: (input: { readonly deadlines: readonly ContextDeadline[] }) => C,
): EligibilityAdapter {
  return (card, profile, asOf) => {
    const context = buildContext ? buildContext({ deadlines: card.deadlines.map((d) => ({ ...d, institutionId: null })) }) : undefined;
    return evaluate(card.rules, profile, context === undefined ? { asOf } : { asOf, context });
  };
}

/** shared/eligibility's engine for a non-sensitive profile (it refuses SensitiveAnswers by design). */
export const engineEligibility: EligibilityAdapter = eligibilityAdapterFrom(evaluateEligibility, buildEvalContext);

const UNREADABLE: EligibilityOutcome["pending"][number] = {
  id: "rule_set_unreadable",
  sensitive: false,
  resolver: "novus",
  selfCheckText: "Novus could not read this program's rules: see the official page",
};

/**
 * findMatches's default:
 * - a verified rule set goes to the engine, which also projects class standing to the rule's
 *   date (a first-year can apply to a program for rising second-years), so the card's
 *   class-year facet is not used to rule anyone out;
 * - no rule set: the card's class-year facet is the only standing fact Novus has, so the facet
 *   check decides (a senior-only program is not shown to a first-year) and the result stays
 *   "unknown";
 * - if the engine throws on a rule set it cannot read, the facet still applies and the result
 *   is held at "unknown", so the card says Novus has not checked every rule. One malformed rule
 *   set must never take down the match screen.
 */
export const defaultEligibility: EligibilityAdapter = (card, profile, asOf) => {
  if (card.rules === null) return facetEligibility(card, profile, asOf);
  try {
    return engineEligibility(card, profile, asOf);
  } catch {
    const local = facetEligibility(card, profile, asOf);
    if (local.status === "not_eligible") return local;
    return { status: "unknown", pending: [...local.pending.filter((p) => p.resolver === "student"), UNREADABLE] };
  }
};
