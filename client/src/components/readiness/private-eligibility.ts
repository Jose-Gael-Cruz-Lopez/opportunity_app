/**
 * Private eligibility: resolves the rules that depend on SensitiveAnswers, in the browser only.
 *
 * The server's readiness report leaves every sensitive rule `unknown` (its schema refuses
 * anything else). This module takes that result, the program's rule set and the answers the
 * student typed into React state, and returns a new result with those rules decided. Nothing it
 * produces is ever sent anywhere: callers render it and drop it.
 *
 * It evaluates only rules whose fields are all sensitive. A rule that mixes a sensitive field with
 * a profile or derived field (semesters remaining, age at a date) stays unknown, because only the
 * shared evaluator can derive those fields correctly. When shared/eligibility ships its browser
 * entry point, `applyPrivateAnswers` can delegate to it with the same inputs.
 */
import * as jsonLogicModule from "json-logic-js";
import {
  getEligibilityField,
  type EligibilityFieldKey,
  type EligibilityPending,
  type EligibilityResult,
  type EligibilityRule,
  type EligibilityRuleResult,
  type EligibilityRuleSet,
  type EligibilityStatus,
  type EligibilityVerdict,
} from "@shared/contracts/eligibility";
import type { SensitiveAnswers } from "@shared/contracts/sensitive";
import {
  CITIZENSHIP_STATUSES,
  IDENTITY_CATEGORIES,
  IDENTITY_CATEGORY_LABELS,
  IDENTITY_VALUES,
  PELL_ANSWERS,
  STATUS_ANSWERS,
  type IdentityCategory,
} from "@shared/taxonomy";

/** Attestations and self-check rules the student ticked on this device ("I meet this"). */
export type ConfirmedAttestations = ReadonlySet<string>;

/**
 * json-logic-js is a UMD bundle. Bundlers expose it as the default export, Node's ESM loader as
 * the namespace, so take whichever carries `apply`.
 */
type JsonLogicApi = typeof jsonLogicModule;
const jsonLogic: JsonLogicApi =
  (jsonLogicModule as JsonLogicApi & { default?: JsonLogicApi }).default ?? jsonLogicModule;

// ---------------------------------------------------------------------------------------------
// Reading answers
// ---------------------------------------------------------------------------------------------

/** The JsonLogic data object for sensitive fields: flat keys plus `identity.<category>`. */
export function answersToLogicData(answers: SensitiveAnswers): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  if (answers.citizenship !== undefined) data.citizenship = answers.citizenship;
  if (answers.pell !== undefined) data.pell = answers.pell;
  if (answers.financialNeed !== undefined) data.financialNeed = answers.financialNeed;
  if (answers.firstGeneration !== undefined) data.firstGeneration = answers.firstGeneration;
  if (answers.identity) data.identity = { ...answers.identity };
  return data;
}

/** The answer for one catalogue field, or undefined when the student has not answered it. */
export function answerFor(answers: SensitiveAnswers, field: string): unknown {
  if (field.startsWith("identity.")) {
    const category = field.slice("identity.".length) as IdentityCategory;
    return answers.identity?.[category];
  }
  return (answers as Record<string, unknown>)[field];
}

/** True when the answer is missing or is one of the field's "not answered" values. */
export function isUnanswered(field: string, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const unknownValues = getEligibilityField(field)?.unknownValues ?? [];
  if (Array.isArray(value)) return value.length === 0 || value.some((v) => unknownValues.includes(String(v)));
  return unknownValues.includes(String(value));
}

// ---------------------------------------------------------------------------------------------
// Evaluating
// ---------------------------------------------------------------------------------------------

function allFieldsSensitive(rule: EligibilityRule): boolean {
  return rule.fields.every((f) => getEligibilityField(f)?.sensitive === true);
}

/** Decides one sensitive rule from the answers; null when this module must leave it alone. */
export function evaluatePrivateRule(
  rule: EligibilityRule,
  answers: SensitiveAnswers,
): { verdict: EligibilityVerdict; missing: EligibilityFieldKey[] } | null {
  if (!rule.sensitive || !allFieldsSensitive(rule)) return null;
  const missing = rule.fields.filter((f) => isUnanswered(f, answerFor(answers, f)));
  if (missing.length > 0) return { verdict: "unknown", missing };
  try {
    const outcome = jsonLogic.apply(rule.logic as Parameters<JsonLogicApi["apply"]>[0], answersToLogicData(answers));
    return { verdict: outcome ? "met" : "not_met", missing: [] };
  } catch {
    // A malformed rule must never read as a decision about the student.
    return { verdict: "unknown", missing: [] };
  }
}

const PRIVATE_REASONS: Record<EligibilityVerdict, { code: string; text: string }> = {
  met: { code: "SENSITIVE_MET_ON_DEVICE", text: "Matches your private answer. Checked on this device only." },
  not_met: { code: "SENSITIVE_NOT_MET_ON_DEVICE", text: "Does not match your private answer. Checked on this device only." },
  unknown: { code: "SENSITIVE_ON_DEVICE", text: "Answer privately to check this rule. Your answer stays in this browser." },
};

/** Combines verdicts: any not_met wins, then any unknown, else met. */
export function combineAll(verdicts: readonly EligibilityVerdict[]): EligibilityVerdict {
  if (verdicts.includes("not_met")) return "not_met";
  if (verdicts.includes("unknown")) return "unknown";
  return "met";
}

/** An anyOf group: met if any member is met, not_met if every member is, unknown otherwise. */
export function combineAny(verdicts: readonly EligibilityVerdict[]): EligibilityVerdict {
  if (verdicts.length === 0) return "unknown";
  if (verdicts.includes("met")) return "met";
  if (verdicts.every((v) => v === "not_met")) return "not_met";
  return "unknown";
}

/** Overall verdict over "all" rules and each anyOf group, with open pending items keeping it unknown. */
export function overallVerdict(rules: readonly EligibilityRuleResult[], pending: readonly EligibilityPending[]): EligibilityVerdict {
  const groups = new Map<string, EligibilityVerdict[]>();
  const all: EligibilityVerdict[] = [];
  for (const r of rules) {
    if (r.group === "all") all.push(r.verdict);
    else groups.set(r.group, [...(groups.get(r.group) ?? []), r.verdict]);
  }
  for (const vs of groups.values()) all.push(combineAny(vs));
  const verdict = combineAll(all);
  if (verdict === "met" && pending.length > 0) return "unknown";
  return verdict;
}

/** Display status: conditional when the student can resolve every open item, unknown when Novus must. */
export function statusFor(verdict: EligibilityVerdict, rules: readonly EligibilityRuleResult[], pending: readonly EligibilityPending[]): EligibilityStatus {
  if (verdict === "met") return "eligible";
  if (verdict === "not_met") return "not_eligible";
  const novusOpen = pending.some((p) => p.resolver === "novus") || rules.some((r) => r.verdict === "unknown" && r.resolver === "novus");
  return novusOpen ? "unknown" : "conditional";
}

function hasAnyAnswer(answers: SensitiveAnswers): boolean {
  return Object.keys(answersToLogicData(answers)).length > 0;
}

/**
 * Returns the server's result with sensitive rules decided from on-device answers, and student
 * attestations the student confirmed removed from the pending list. Pure: same inputs, same output.
 */
export function applyPrivateAnswers(
  base: EligibilityResult,
  ruleSet: EligibilityRuleSet | null,
  answers: SensitiveAnswers,
  confirmed: ConfirmedAttestations = new Set(),
): EligibilityResult {
  const byId = new Map((ruleSet?.rules ?? []).map((r) => [r.id, r]));
  let used = false;
  const rules = base.rules.map((r): EligibilityRuleResult => {
    if (!r.sensitive) {
      // A rule the student can check themselves (a missing profile field, or a program whose
      // readiness is withheld) counts as met once they confirm it against the official wording.
      if (r.verdict === "unknown" && r.resolver === "student" && confirmed.has(r.ruleId)) {
        return { ...r, verdict: "met", reasonCode: "SELF_CONFIRMED", reason: "You confirmed this against the official wording.", missingFields: [], resolver: null };
      }
      return r;
    }
    const rule = byId.get(r.ruleId);
    const decided = rule ? evaluatePrivateRule(rule, answers) : null;
    if (!decided) return r;
    if (decided.verdict !== "unknown") used = true;
    const reason = PRIVATE_REASONS[decided.verdict];
    return {
      ...r,
      verdict: decided.verdict,
      reasonCode: reason.code,
      reason: reason.text,
      missingFields: decided.missing,
      resolver: decided.verdict === "unknown" ? "student" : null,
    };
  });
  const decidedIds = new Set(rules.filter((r, i) => r.verdict !== "unknown" && base.rules[i]?.verdict === "unknown").map((r) => r.ruleId));
  const pending = base.pending.filter((p) => {
    if (p.kind === "rule" && decidedIds.has(p.id)) return false;
    if (p.kind === "attestation" && p.resolver === "student" && confirmed.has(p.id)) return false;
    return true;
  });
  const verdict = overallVerdict(rules, pending);
  return {
    ...base,
    rules,
    pending,
    verdict,
    status: statusFor(verdict, rules, pending),
    sensitiveEvaluated: used || (hasAnyAnswer(answers) && base.sensitiveEvaluated),
  };
}

/**
 * A starting result built from the rule set alone, for programs whose server readiness is
 * withheld (status-defined programs answer 404). Every rule starts unknown; sensitive rules are
 * then decided on the device and the rest point the student at the official wording.
 */
export function baseResultFromRuleSet(ruleSet: EligibilityRuleSet, asOf: string): EligibilityResult {
  const rules: EligibilityRuleResult[] = ruleSet.rules.map((rule) => ({
    ruleId: rule.id,
    dimension: rule.dimension,
    group: rule.group,
    verdict: "unknown",
    sensitive: rule.sensitive,
    reasonCode: rule.sensitive ? "SENSITIVE_ON_DEVICE" : "SELF_CHECK",
    reason: rule.sensitive ? PRIVATE_REASONS.unknown.text : "Check this rule against the official wording.",
    officialText: rule.officialText,
    missingFields: [],
    resolver: "student",
    evidenceKey: rule.evidenceKey,
    evidence: rule.evidenceKey ? ruleSet.evidence[rule.evidenceKey] ?? null : null,
  }));
  const pending: EligibilityPending[] = [
    ...ruleSet.rules.map((rule) => ({
      id: rule.id,
      kind: "rule" as const,
      dimension: rule.dimension,
      sensitive: rule.sensitive,
      resolver: "student" as const,
      selfCheckText: `Eligible if: ${rule.officialText}`,
    })),
    ...ruleSet.attestations.map((a) => ({
      id: a.id,
      kind: "attestation" as const,
      dimension: a.dimension,
      sensitive: a.sensitive,
      resolver: "student" as const,
      selfCheckText: a.text,
    })),
  ];
  return {
    verdict: "unknown",
    status: "conditional",
    rules,
    pending,
    nomination: ruleSet.nomination,
    ruleSet: { id: ruleSet.id, version: ruleSet.version, hash: ruleSet.hash },
    basedOnListedRequirements: false,
    asOf,
    sensitiveEvaluated: false,
  };
}

// ---------------------------------------------------------------------------------------------
// Questions to ask
// ---------------------------------------------------------------------------------------------

export interface PrivateOption {
  readonly value: string;
  readonly label: string;
}

export interface PrivateQuestion {
  readonly field: EligibilityFieldKey;
  readonly prompt: string;
  readonly multiple: boolean;
  readonly options: readonly PrivateOption[];
}

const CITIZENSHIP_LABELS: Record<(typeof CITIZENSHIP_STATUSES)[number], string> = {
  us_citizen: "U.S. citizen",
  us_national: "U.S. national",
  permanent_resident: "Permanent resident (green card)",
  daca: "DACA recipient",
  tps: "Temporary Protected Status",
  refugee_asylee: "Refugee or asylee",
  f1: "F-1 student visa",
  j1: "J-1 visa",
  other_visa: "Another visa",
  none_of_these: "None of these",
};

const PELL_LABELS: Record<(typeof PELL_ANSWERS)[number], string> = {
  recipient: "I receive a Pell Grant",
  eligible_not_receiving: "Eligible, not receiving",
  not_recipient: "No",
  prefer_not: "Prefer not to say",
};

const STATUS_LABELS: Record<(typeof STATUS_ANSWERS)[number], string> = {
  yes: "Yes",
  no: "No",
  not_sure: "Not sure",
  prefer_not: "Prefer not to say",
};

const PREFER_NOT: PrivateOption = { value: "prefer_not", label: "Prefer not to say" };

const humanize = (v: string) => v.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The question for one sensitive field, or null for fields this UI does not ask about. */
export function questionFor(field: EligibilityFieldKey): PrivateQuestion | null {
  switch (field) {
    case "citizenship":
      return {
        field,
        prompt: "What is your citizenship or immigration status?",
        multiple: false,
        options: [...CITIZENSHIP_STATUSES.map((v) => ({ value: v, label: CITIZENSHIP_LABELS[v] })), PREFER_NOT],
      };
    case "pell":
      return { field, prompt: "Do you receive a federal Pell Grant?", multiple: false, options: PELL_ANSWERS.map((v) => ({ value: v, label: PELL_LABELS[v] })) };
    case "financialNeed":
      return { field, prompt: "Do you have demonstrated financial need?", multiple: false, options: STATUS_ANSWERS.map((v) => ({ value: v, label: STATUS_LABELS[v] })) };
    case "firstGeneration":
      return { field, prompt: "Are you a first-generation college student?", multiple: false, options: STATUS_ANSWERS.map((v) => ({ value: v, label: STATUS_LABELS[v] })) };
    default: {
      if (!field.startsWith("identity.")) return null;
      const category = field.slice("identity.".length) as IdentityCategory;
      if (!IDENTITY_CATEGORIES.includes(category)) return null;
      const values = IDENTITY_VALUES[category];
      const single = values.length === 1;
      return {
        field,
        prompt: single ? `${IDENTITY_CATEGORY_LABELS[category]}: does this describe you?` : `${IDENTITY_CATEGORY_LABELS[category]}: which describe you?`,
        multiple: !single,
        options: [...values.map((v) => ({ value: v, label: single && v === "yes" ? "Yes" : humanize(v) })), PREFER_NOT],
      };
    }
  }
}

/** Questions for every sensitive field an open rule reads, in rule order, without repeats. */
export function questionsForOpenRules(result: EligibilityResult, ruleSet: EligibilityRuleSet | null): PrivateQuestion[] {
  const byId = new Map((ruleSet?.rules ?? []).map((r) => [r.id, r]));
  const seen = new Set<string>();
  const out: PrivateQuestion[] = [];
  for (const r of result.rules) {
    if (!r.sensitive) continue;
    const rule = byId.get(r.ruleId);
    for (const f of rule?.fields ?? r.missingFields) {
      if (seen.has(f) || getEligibilityField(f)?.sensitive !== true) continue;
      seen.add(f);
      const q = questionFor(f);
      if (q) out.push(q);
    }
  }
  return out;
}

/** Writes one answer into a new SensitiveAnswers object (immutable update for React state). */
export function withAnswer(answers: SensitiveAnswers, field: EligibilityFieldKey, value: string | string[] | undefined): SensitiveAnswers {
  if (field.startsWith("identity.")) {
    const category = field.slice("identity.".length) as IdentityCategory;
    const identity = { ...(answers.identity ?? {}) };
    if (value === undefined) delete identity[category];
    else identity[category] = Array.isArray(value) ? value : [value];
    return { ...answers, identity };
  }
  const next: Record<string, unknown> = { ...answers };
  if (value === undefined) delete next[field];
  else next[field] = Array.isArray(value) ? value[0] : value;
  return next as SensitiveAnswers;
}
