import {
  ELIGIBILITY_DIMENSIONS,
  LAUNCH_DIMENSIONS,
  inspectJsonLogic,
  isSensitiveField,
  type Attestation,
  type Coverage,
  type EligibilityDimension,
  type EligibilityFieldKey,
  type EligibilityPending,
  type EligibilityResult,
  type EligibilityRule,
  type EligibilityRuleResult,
  type EligibilityRuleSet,
  type EligibilityStatus,
} from "../contracts/eligibility";
import { majorFamilyForCip, cipMatchesPrefix } from "../taxonomy";
import { isIsoDate } from "../time/iso";
import { known, type AbstractValue } from "./abstract";
import { EMPTY_CONTEXT, type EvalContext } from "./context";
import { readField, isAnswered, type DeviceInputs, type EligibilityProfile, type FieldEnvInput, type FieldReading, type FieldStatus } from "./fields";
import { agree3, and3, or3, triToVerdict, NO, UNKNOWN, YES, type Tri } from "./kleene";
import { evaluateLogicTri, RuleEvaluationError } from "./logic";
import { DIMENSION_LABELS, SELF_CHECK_TEMPLATES, describeFields, renderReason, renderTemplate, sentence, type ReasonCode } from "./reasons";

/**
 * The evaluator. Pure: no clock (asOf is an argument), no I/O, no storage, no randomness.
 *
 * evaluateCore is internal. Server code calls `evaluateEligibility` from ./index (no answers
 * parameter exists there); the browser calls `evaluateWithAnswers` from ./sensitive.
 */

export interface EvaluateOptions {
  /** Evaluation date, YYYY-MM-DD. Rules with asOf "today" are judged at it. */
  readonly asOf: string;
  readonly context?: EvalContext;
}

type Resolver = "student" | "novus";

interface RuleOutcome {
  readonly verdict: Tri;
  readonly code: ReasonCode;
  readonly missingFields: readonly EligibilityFieldKey[];
  readonly resolver: Resolver | null;
}

/** World splitting stops at this many combinations; beyond it the abstract evaluation is used. */
const MAX_WORLDS = 4096;

/** Uncertainty causes in priority order: the first present names the reason. */
const CAUSE_ORDER: readonly { status: FieldStatus; code: ReasonCode; resolver: Resolver }[] = [
  { status: "context", code: "CONTEXT_MISSING", resolver: "novus" },
  { status: "missing", code: "MISSING_FIELD", resolver: "student" },
  { status: "sensitive_missing", code: "SENSITIVE_UNANSWERED", resolver: "student" },
  { status: "conflict", code: "PROFILE_CONFLICT", resolver: "student" },
  { status: "calendar", code: "CALENDAR_CONVERSION", resolver: "student" },
  { status: "coarse", code: "STRADDLES_LIMIT", resolver: "student" },
  { status: "participation", code: "PARTICIPATION_UNCONFIRMED", resolver: "student" },
];

function anchorFor(rule: EligibilityRule, env: FieldEnvInput): string | null {
  if (rule.asOf === "today") return env.today;
  const date = env.context.anchors[rule.asOf];
  return date && isIsoDate(date) ? date : null;
}

/**
 * Possible-worlds evaluation. Fields whose answer is one of a few values (an unanswered enum, an
 * age that depends on the birth day) are split into one world per value and the logic runs once
 * per world: YES only if every world says YES, NO only if every world says NO. This keeps rules
 * exact even when they read a field twice (`x == a or x == b`), and it is monotone: answering a
 * question removes worlds, which can never turn an agreed YES into NO.
 */
function evaluateWorlds(logic: unknown, readings: ReadonlyMap<string, FieldReading>): Tri {
  const splits: { key: string; values: readonly AbstractValue[] }[] = [];
  let worlds = 1;
  const candidates = [...readings.entries()]
    .filter(([, r]) => r.value.kind === "set")
    .map(([key, r]) => ({ key, values: (r.value as { values: readonly (string | number | boolean | null)[] }).values.map((v) => known(v)) }))
    .sort((a, b) => a.values.length - b.values.length || (a.key < b.key ? -1 : 1));
  for (const c of candidates) {
    if (worlds * c.values.length > MAX_WORLDS) continue;
    worlds *= c.values.length;
    splits.push(c);
  }
  const verdicts: Tri[] = [];
  const assign = (i: number, overlay: Map<string, AbstractValue>): void => {
    if (i === splits.length) {
      verdicts.push(
        evaluateLogicTri(logic, {
          lookup: (name) => {
            const fixed = overlay.get(name);
            if (fixed) return fixed;
            const r = readings.get(name);
            if (!r) throw new RuleEvaluationError(`logic reads undeclared field ${name}`);
            return r.value;
          },
          answered: (name) => {
            const r = readings.get(name);
            return r ? isAnswered(r) : false;
          },
        }),
      );
      return;
    }
    const split = splits[i] as (typeof splits)[number];
    for (const v of split.values) {
      overlay.set(split.key, v);
      assign(i + 1, overlay);
    }
    overlay.delete(split.key);
  };
  assign(0, new Map());
  return agree3(verdicts);
}

/** Field rules never say "no" to an interdisciplinary, undeclared or borderline major (plan 6.4.4). */
function isBorderlineMajor(rule: EligibilityRule, env: FieldEnvInput): boolean {
  if (rule.dimension !== "field") return false;
  const { majorCip, minorCip, majorFamily } = env.profile;
  if (majorFamily === "undeclared") return true;
  // CIP series without a family (30, interdisciplinary) are borderline by design (shared/taxonomy).
  if (majorCip && majorFamilyForCip(majorCip) === null) return true;
  return [majorCip, minorCip].some((cip) => cip && rule.borderline.some((prefix) => cipMatchesPrefix(cip, prefix)));
}

function evaluateRule(rule: EligibilityRule, env: FieldEnvInput): RuleOutcome {
  if (rule.sensitive && !env.device) {
    const sensitiveFields = rule.fields.filter((f) => isSensitiveField(f));
    // The server never runs sensitive logic at all: the rule stays unknown by construction.
    return { verdict: UNKNOWN, code: "SENSITIVE_ON_DEVICE", missingFields: sensitiveFields, resolver: "student" };
  }
  const anchor = anchorFor(rule, env);
  const vars = new Set<string>([...rule.fields, ...inspectJsonLogic(rule.logic).vars]);
  const readings = new Map<string, FieldReading>();
  try {
    for (const name of vars) readings.set(name, readField(name as EligibilityFieldKey, env, anchor));
  } catch {
    return { verdict: UNKNOWN, code: "RULE_ERROR", missingFields: [], resolver: "novus" };
  }
  let verdict: Tri;
  try {
    verdict = evaluateWorlds(rule.logic, readings);
  } catch (err) {
    if (err instanceof RuleEvaluationError || err instanceof RangeError) {
      return { verdict: UNKNOWN, code: "RULE_ERROR", missingFields: [], resolver: "novus" };
    }
    throw err;
  }
  const statuses = new Set([...readings.values()].map((r) => r.status));
  const missingFields = [...new Set([...readings.values()].flatMap((r) => (r.status === "missing" || r.status === "sensitive_missing" ? r.blame : [])))];

  // A converted term count is Novus's arithmetic, not the program's rule: never "yes" from it.
  if (verdict === YES && statuses.has("calendar")) {
    return { verdict: UNKNOWN, code: "CALENDAR_CONVERSION", missingFields, resolver: "student" };
  }
  if (verdict === NO && isBorderlineMajor(rule, env)) {
    return { verdict: UNKNOWN, code: "BORDERLINE_FIELD", missingFields, resolver: "student" };
  }
  if (verdict === YES) return { verdict, code: "MET", missingFields: [], resolver: null };
  if (verdict === NO) return { verdict, code: "NOT_MET", missingFields: [], resolver: null };
  const cause = CAUSE_ORDER.find((c) => statuses.has(c.status));
  return cause
    ? { verdict, code: cause.code, missingFields, resolver: cause.resolver }
    : { verdict, code: "UNDETERMINED", missingFields, resolver: "novus" };
}

function evaluateAttestation(a: Attestation, device: DeviceInputs | undefined): RuleOutcome {
  if (!device) return { verdict: UNKNOWN, code: "ATTESTATION_ON_DEVICE", missingFields: [], resolver: "student" };
  const answer = device.attestation(a.id);
  if (answer === true) return { verdict: YES, code: "ATTESTATION_CONFIRMED", missingFields: [], resolver: null };
  if (answer === false) return { verdict: NO, code: "ATTESTATION_DECLINED", missingFields: [], resolver: null };
  return { verdict: UNKNOWN, code: "ATTESTATION_UNANSWERED", missingFields: [], resolver: "student" };
}

/** Coverage state with the contract's safety net: none_stated on a launch dimension counts as not reviewed. */
function coverageOf(ruleSet: EligibilityRuleSet, dim: EligibilityDimension): Coverage {
  const state = ruleSet.coverage[dim] ?? "not_reviewed";
  if (state === "none_stated" && (LAUNCH_DIMENSIONS as readonly string[]).includes(dim)) return "not_reviewed";
  return state;
}

function ruleResult(rule: EligibilityRule, outcome: RuleOutcome, ruleSet: EligibilityRuleSet): EligibilityRuleResult {
  const params = {
    officialText: sentence(rule.officialText),
    fields: describeFields(outcome.missingFields),
    dimension: DIMENSION_LABELS[rule.dimension],
  };
  return {
    ruleId: rule.id,
    dimension: rule.dimension,
    group: rule.group,
    verdict: triToVerdict(outcome.verdict),
    sensitive: rule.sensitive,
    reasonCode: outcome.code,
    reason: renderReason(outcome.code, params),
    officialText: rule.officialText,
    missingFields: [...outcome.missingFields],
    resolver: outcome.resolver,
    evidenceKey: rule.evidenceKey,
    evidence: rule.evidenceKey ? (ruleSet.evidence[rule.evidenceKey] ?? null) : null,
  };
}

/** Attestations are reported beside rules (group "attestations") so a "no" always names its cause. */
const ATTESTATION_GROUP = "attestations";

function attestationResult(a: Attestation, outcome: RuleOutcome, ruleSet: EligibilityRuleSet): EligibilityRuleResult {
  return {
    ruleId: a.id,
    dimension: a.dimension,
    group: ATTESTATION_GROUP,
    verdict: triToVerdict(outcome.verdict),
    sensitive: a.sensitive,
    reasonCode: outcome.code,
    reason: renderReason(outcome.code, { officialText: sentence(a.text) }),
    officialText: a.text,
    missingFields: [],
    resolver: outcome.resolver,
    evidenceKey: a.evidenceKey,
    evidence: a.evidenceKey ? (ruleSet.evidence[a.evidenceKey] ?? null) : null,
  };
}

function pendingForRule(r: EligibilityRuleResult, kind: "rule" | "attestation"): EligibilityPending {
  const resolver = r.resolver ?? "student";
  const template = kind === "attestation" ? SELF_CHECK_TEMPLATES.attestation : resolver === "novus" ? SELF_CHECK_TEMPLATES.rule_novus : SELF_CHECK_TEMPLATES.rule;
  return {
    id: r.ruleId,
    kind,
    dimension: r.dimension,
    sensitive: r.sensitive,
    resolver,
    selfCheckText: renderTemplate(template, { officialText: sentence(r.officialText) }),
  };
}

function statusFor(verdict: Tri, pending: readonly EligibilityPending[]): EligibilityStatus {
  if (verdict === YES) return "eligible";
  if (verdict === NO) return "not_eligible";
  return pending.length > 0 && pending.every((p) => p.resolver === "student") ? "conditional" : "unknown";
}

/** The result when a cycle has no rule set Novus can use. */
export function missingRuleSetResult(asOf: string, sensitiveEvaluated: boolean): EligibilityResult {
  return {
    verdict: "unknown",
    status: "unknown",
    rules: [],
    pending: [
      { id: "rule_set", kind: "rule_set_missing", dimension: null, sensitive: false, resolver: "novus", selfCheckText: SELF_CHECK_TEMPLATES.rule_set_missing },
    ],
    nomination: null,
    ruleSet: null,
    basedOnListedRequirements: false,
    asOf,
    sensitiveEvaluated,
  };
}

export function assertIsoDate(asOf: string): void {
  if (typeof asOf !== "string" || !isIsoDate(asOf)) throw new RangeError(`asOf must be an ISO date (YYYY-MM-DD), got ${String(asOf)}`);
}

/**
 * Evaluates a rule set. Strong Kleene over every rule, anyOf group, attestation and coverage
 * entry; nothing short-circuits, so every reason is collected and order cannot matter.
 */
export function evaluateCore(
  ruleSet: EligibilityRuleSet | null,
  profile: EligibilityProfile,
  opts: EvaluateOptions,
  device?: DeviceInputs,
): EligibilityResult {
  assertIsoDate(opts.asOf);
  if (!ruleSet) return missingRuleSetResult(opts.asOf, device !== undefined);
  const env: FieldEnvInput = { profile, context: opts.context ?? EMPTY_CONTEXT, today: opts.asOf, device };

  const ruleResults = ruleSet.rules.map((rule) => ruleResult(rule, evaluateRule(rule, env), ruleSet));
  const attestationResults = ruleSet.attestations.map((a) => attestationResult(a, evaluateAttestation(a, device), ruleSet));
  const tri = (r: EligibilityRuleResult): Tri => (r.verdict === "met" ? YES : r.verdict === "not_met" ? NO : UNKNOWN);

  const members: Tri[] = [];
  const pending: EligibilityPending[] = [];

  for (const r of ruleResults.filter((x) => x.group === "all")) {
    members.push(tri(r));
    if (r.verdict === "unknown") pending.push(pendingForRule(r, "rule"));
  }

  const groupIds = [...new Set([...ruleSet.anyOf.map((g) => g.id), ...ruleResults.filter((r) => r.group !== "all").map((r) => r.group)])];
  for (const id of groupIds) {
    const inGroup = ruleResults.filter((r) => r.group === id);
    if (inGroup.length === 0) {
      members.push(UNKNOWN);
      const label = ruleSet.anyOf.find((g) => g.id === id)?.label ?? id;
      pending.push({ id: `group:${id}`, kind: "coverage", dimension: null, sensitive: false, resolver: "novus", selfCheckText: renderTemplate(SELF_CHECK_TEMPLATES.group, { label }) });
      continue;
    }
    const groupVerdict = or3(inGroup.map(tri));
    members.push(groupVerdict);
    if (groupVerdict === UNKNOWN) for (const r of inGroup.filter((x) => x.verdict === "unknown")) pending.push(pendingForRule(r, "rule"));
  }

  for (const r of attestationResults) {
    members.push(tri(r));
    if (r.verdict === "unknown") pending.push(pendingForRule(r, "attestation"));
  }

  let restsOnNoneStated = false;
  for (const dim of ELIGIBILITY_DIMENSIONS) {
    const state = coverageOf(ruleSet, dim);
    if (state === "none_stated") restsOnNoneStated = true;
    const hasRules = ruleSet.rules.some((r) => r.dimension === dim) || ruleSet.attestations.some((a) => a.dimension === dim);
    if (state === "not_reviewed" || (state === "encoded" && !hasRules)) {
      members.push(UNKNOWN);
      pending.push({
        id: `coverage:${dim}`,
        kind: "coverage",
        dimension: dim,
        sensitive: false,
        resolver: "novus",
        selfCheckText: renderTemplate(SELF_CHECK_TEMPLATES.coverage, { dimension: DIMENSION_LABELS[dim] }),
      });
    }
  }

  const verdict = and3(members);
  return {
    verdict: triToVerdict(verdict),
    status: statusFor(verdict, pending),
    rules: [...ruleResults, ...attestationResults],
    pending,
    nomination: ruleSet.nomination,
    ruleSet: { id: ruleSet.id, version: ruleSet.version, hash: ruleSet.hash },
    basedOnListedRequirements: verdict === YES && restsOnNoneStated,
    asOf: opts.asOf,
    sensitiveEvaluated: device !== undefined,
  };
}

