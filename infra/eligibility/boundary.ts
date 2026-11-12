import { EligibilityResultSchema, getEligibilityField, inspectJsonLogic, type EligibilityResult, type EligibilityRuleSet } from "../../shared/contracts/eligibility";
import { EMPTY_CONTEXT, type EvalContext } from "../../shared/eligibility/context";
import { checkRuleSet, evaluateEligibility, hashMatches } from "../../shared/eligibility/index";
import { CLASS_YEARS, ENROLLMENT_INTENSITIES, GPA_BANDS, INSTITUTION_LEVELS, MAJOR_FAMILIES, TRANSFER_INTENTS } from "../../shared/taxonomy";

/**
 * Generated boundary profiles over a published rule set (release gate, plan 06 6.12). Hand
 * labelled golden cases cover sample rule sets; this covers every rule set a release ships, with
 * synthetic non-sensitive profiles built from the fields its rules read:
 *
 * - every value of each enum the rules read, one field at a time;
 * - graduation terms and birth months on both sides of the rule's dates;
 * - "rich" profiles that answer every field at once.
 *
 * Gates (any failure blocks the release):
 * - lint: no checkRuleSet error; a verified rule set's stored hash matches its content;
 * - no RULE_ERROR on any generated profile (a rule the evaluator cannot run is a broken rule);
 * - every result satisfies the EligibilityResult contract (sensitive rules stay unknown);
 * - monotone: forgetting one answer of a rich profile never flips met <-> not_met;
 * - order: reversing rules, groups and attestations changes no verdict.
 *
 * Profiles are synthetic and server-safe: no SensitiveAnswers exist on this path at all.
 */

type Profile = Parameters<typeof evaluateEligibility>[1];
type ProfileRecord = Record<string, string>;

export interface BoundaryTarget {
  readonly ruleSet: EligibilityRuleSet;
  /** Context for the cycle (anchors, institution); EMPTY_CONTEXT when absent. */
  readonly context?: EvalContext;
  /** Label in failure reasons, e.g. the program slug and cycle key (registry facts only). */
  readonly label?: string;
}

export interface BoundaryReport {
  readonly ruleSets: number;
  readonly profiles: number;
  readonly failures: readonly string[];
}

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  classYear: CLASS_YEARS,
  enrollmentIntensity: ENROLLMENT_INTENSITIES,
  institutionLevel: INSTITUTION_LEVELS,
  transferIntent: TRANSFER_INTENTS,
  gpaBand: GPA_BANDS,
  majorFamily: MAJOR_FAMILIES,
};

/** Profile keys that feed each catalogue field. */
const PROFILE_KEYS_FOR_FIELD: Readonly<Record<string, readonly string[]>> = {
  classYear: ["classYear", "expectedGraduationTerm"],
  semestersRemaining: ["expectedGraduationTerm"],
  yearsRemaining: ["expectedGraduationTerm"],
  expectedGraduationTerm: ["expectedGraduationTerm"],
  expectedGraduationYear: ["expectedGraduationTerm"],
  enrollmentIntensity: ["enrollmentIntensity"],
  institutionLevel: ["institutionLevel"],
  transferIntent: ["transferIntent"],
  gpaBand: ["gpaBand"],
  gpaMin: ["gpaBand"],
  gpaMax: ["gpaBand"],
  majorCip: ["majorCip"],
  minorCip: ["minorCip"],
  majorFamily: ["majorFamily"],
  residenceState: ["residenceState"],
  ageAtAsOf: ["birthYearMonth"],
};

function year(asOf: string): number {
  return Number(asOf.slice(0, 4));
}

function valuesFor(key: string, asOf: string, cips: readonly string[]): readonly string[] {
  const enumValues = ENUM_VALUES[key];
  if (enumValues) return enumValues;
  const y = year(asOf);
  switch (key) {
    case "expectedGraduationTerm":
      return [-1, 0, 1, 2, 3, 4, 5].flatMap((d) => [`spring-${y + d}`, `fall-${y + d}`]);
    case "birthYearMonth":
      return [14, 16, 17, 18, 19, 21, 24, 25, 26, 30, 35].flatMap((age) => [`${y - age}-01`, `${y - age}-06`, `${y - age}-12`]);
    case "majorCip":
    case "minorCip":
      return cips.length > 0 ? cips : ["11.0701", "26.0101", "30.0000", "52.0101"];
    case "residenceState":
      return ["CA", "NY", "PR", "TX"];
    default:
      return [];
  }
}

/** CIP-looking string literals in the rule set (prefixes and codes), widened to full codes. */
function cipLiterals(ruleSet: EligibilityRuleSet): string[] {
  const found = new Set<string>();
  const visit = (node: unknown): void => {
    if (typeof node === "string" && /^\d{2}(\.\d{2}(\d{2})?)?$/.test(node)) found.add(node.length === 2 ? `${node}.0101` : node.length === 5 ? `${node}01` : node);
    else if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === "object") Object.values(node).forEach(visit);
  };
  for (const rule of ruleSet.rules) {
    visit(rule.logic);
    rule.borderline.forEach(visit);
  }
  return [...found].sort();
}

/** The non-sensitive profile keys the rule set's rules read. */
export function profileKeysRead(ruleSet: EligibilityRuleSet): string[] {
  const keys = new Set<string>();
  for (const rule of ruleSet.rules) {
    if (rule.sensitive) continue;
    for (const field of new Set([...rule.fields, ...inspectJsonLogic(rule.logic).vars])) {
      if (getEligibilityField(field)?.sensitive) continue;
      for (const k of PROFILE_KEYS_FOR_FIELD[field] ?? []) keys.add(k);
    }
  }
  return [...keys].sort();
}

/** Synthetic profiles for one rule set, deterministic for a given asOf. */
export function boundaryProfiles(ruleSet: EligibilityRuleSet, asOf: string): { single: ProfileRecord[]; rich: ProfileRecord[] } {
  const keys = profileKeysRead(ruleSet);
  const cips = cipLiterals(ruleSet);
  const values = new Map(keys.map((k) => [k, valuesFor(k, asOf, cips)] as const));
  const single: ProfileRecord[] = [{}];
  for (const [k, vs] of values) for (const v of vs) single.push({ [k]: v });
  const width = Math.max(0, ...[...values.values()].map((vs) => vs.length));
  const rich: ProfileRecord[] = [];
  for (let i = 0; i < width; i++) {
    const p: ProfileRecord = {};
    for (const [k, vs] of values) if (vs.length > 0) p[k] = vs[(i * 7 + k.length) % vs.length] as string;
    rich.push(p);
  }
  return { single, rich };
}

const verdictMap = (r: EligibilityResult): Record<string, string> => Object.fromEntries(r.rules.map((x) => [x.ruleId, x.verdict]));
/** Order-insensitive fingerprint of per-rule verdicts. */
const verdictKey = (r: EligibilityResult): string => r.rules.map((x) => `${x.ruleId}=${x.verdict}`).sort().join(",");
const flips = (a: string | undefined, b: string | undefined): boolean => (a === "met" && b === "not_met") || (a === "not_met" && b === "met");

export function runBoundaryGate(targets: readonly BoundaryTarget[], asOf: string): BoundaryReport {
  const failures: string[] = [];
  let profiles = 0;
  for (const t of targets) {
    const name = t.label ?? `rule set ${t.ruleSet.id ?? "?"} v${t.ruleSet.version}`;
    const fail = (msg: string): void => {
      failures.push(`${name}: ${msg}`);
    };
    for (const issue of checkRuleSet(t.ruleSet)) if (issue.severity === "error") fail(`lint ${issue.path}: ${issue.message}`);
    if (t.ruleSet.state === "verified" && !hashMatches(t.ruleSet)) fail("stored hash does not match the rule set");

    const context = t.context ?? EMPTY_CONTEXT;
    const evaluate = (profile: ProfileRecord, ruleSet: EligibilityRuleSet = t.ruleSet): EligibilityResult => {
      profiles += 1;
      return evaluateEligibility(ruleSet, profile as Profile, { asOf, context });
    };
    const reversed: EligibilityRuleSet = { ...t.ruleSet, rules: [...t.ruleSet.rules].reverse(), attestations: [...t.ruleSet.attestations].reverse(), anyOf: [...t.ruleSet.anyOf].reverse() };
    const { single, rich } = boundaryProfiles(t.ruleSet, asOf);
    const seen = new Set<string>();
    const report = (msg: string): void => {
      if (!seen.has(msg)) {
        seen.add(msg);
        fail(msg);
      }
    };

    for (const profile of [...single, ...rich]) {
      let result: EligibilityResult;
      try {
        result = evaluate(profile);
      } catch (err) {
        report(`evaluation threw: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const r of result.rules) if (r.reasonCode === "RULE_ERROR") report(`rule ${r.ruleId} cannot be evaluated (RULE_ERROR)`);
      const contract = EligibilityResultSchema.safeParse(result);
      if (!contract.success) report(`result breaks the contract at ${contract.error.issues[0]?.path.join(".") ?? "?"}`);
      const again = evaluate(profile, reversed);
      if (again.verdict !== result.verdict || again.status !== result.status || verdictKey(again) !== verdictKey(result)) {
        report(`result depends on rule order (profile keys: ${Object.keys(profile).join(",") || "none"})`);
      }
    }

    for (const profile of rich) {
      const full = evaluate(profile);
      const before = verdictMap(full);
      for (const key of Object.keys(profile)) {
        const less = { ...profile };
        delete less[key];
        const r = evaluate(less);
        if (flips(full.verdict, r.verdict)) report(`forgetting ${key} flips the verdict`);
        for (const x of r.rules) if (flips(before[x.ruleId], x.verdict)) report(`forgetting ${key} flips rule ${x.ruleId}`);
      }
    }
  }
  return { ruleSets: targets.length, profiles, failures };
}
