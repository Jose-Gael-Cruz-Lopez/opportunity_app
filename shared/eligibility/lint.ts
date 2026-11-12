import { ELIGIBILITY_DIMENSIONS, getEligibilityField, type EligibilityRuleSet } from "../contracts/eligibility";
import { SUPPORTED_OPERATORS } from "./logic";

/**
 * Authoring checks beyond the zod contract: things that are valid JSON but almost certainly a
 * mistake, reported before a Curator verifies a rule set. The evaluator stays safe either way
 * (it never turns these into a false "yes"); these checks keep reasons accurate.
 */
export interface RuleSetIssue {
  readonly severity: "error" | "warning";
  readonly path: string;
  readonly message: string;
}

const SUPPORTED = new Set(SUPPORTED_OPERATORS);

function walkLogic(node: unknown, path: string, visit: (op: string, args: readonly unknown[], path: string) => void): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => walkLogic(n, `${path}[${i}]`, visit));
    return;
  }
  if (node === null || typeof node !== "object") return;
  const keys = Object.keys(node);
  if (keys.length !== 1) return;
  const op = keys[0] as string;
  const raw = (node as Record<string, unknown>)[op];
  const args = Array.isArray(raw) ? raw : [raw];
  visit(op, args, `${path}.${op}`);
  args.forEach((a, i) => walkLogic(a, `${path}.${op}[${i}]`, visit));
}

function varName(node: unknown): string | null {
  if (node === null || typeof node !== "object" || Array.isArray(node)) return null;
  const v = (node as Record<string, unknown>).var;
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return null;
}

/** String literals a comparison checks a field against, for vocabulary checks. */
function literalsAgainst(op: string, args: readonly unknown[]): { field: string; literals: string[]; listField: boolean } | null {
  if ((op === "==" || op === "===" || op === "!=" || op === "!==") && args.length === 2) {
    const [a, b] = args;
    const field = varName(a) ?? varName(b);
    const lit = varName(a) ? b : a;
    if (field && typeof lit === "string") return { field, literals: [lit], listField: false };
  }
  if (op === "in" && args.length === 2) {
    const [needle, haystack] = args;
    const needleVar = varName(needle);
    if (needleVar && Array.isArray(haystack)) {
      return { field: needleVar, literals: haystack.filter((h): h is string => typeof h === "string"), listField: false };
    }
    const hayVar = varName(haystack);
    if (hayVar && typeof needle === "string") return { field: hayVar, literals: [needle], listField: true };
  }
  return null;
}

function checkNumbers(node: unknown, path: string, issues: RuleSetIssue[]): void {
  if (typeof node === "number") {
    if (!Number.isFinite(node)) issues.push({ severity: "error", path, message: "non-finite number" });
    else if (!Number.isInteger(node) && String(node).split(".")[1]!.length > 4) {
      issues.push({ severity: "warning", path, message: "numbers carry at most 4 decimals so the hash matches across runtimes" });
    }
    return;
  }
  if (Array.isArray(node)) node.forEach((n, i) => checkNumbers(n, `${path}[${i}]`, issues));
  else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) checkNumbers(v, `${path}.${k}`, issues);
}

export function checkRuleSet(ruleSet: EligibilityRuleSet): RuleSetIssue[] {
  const issues: RuleSetIssue[] = [];
  ruleSet.rules.forEach((rule, i) => {
    const base = `rules[${i}](${rule.id})`;
    checkNumbers(rule.logic, `${base}.logic`, issues);
    walkLogic(rule.logic, `${base}.logic`, (op, args, path) => {
      if (!SUPPORTED.has(op)) issues.push({ severity: "error", path, message: `operator ${op} is not supported by the evaluator` });
      if (op === "var" && args.length > 1) {
        issues.push({ severity: "warning", path, message: "var defaults are ignored: missing answers stay unknown" });
      }
      if (op === "missing" || op === "missing_some") {
        issues.push({ severity: "warning", path, message: `${op} only tests whether a question was answered; prefer testing the value` });
      }
      const check = literalsAgainst(op, args);
      if (check) {
        const def = getEligibilityField(check.field);
        const vocab = def?.values;
        const kindOk = check.listField ? def?.valueType === "enum_list" : def?.valueType === "enum";
        if (vocab && kindOk) {
          for (const lit of check.literals) {
            if (!vocab.includes(lit)) issues.push({ severity: "error", path, message: `"${lit}" is not a value of ${check.field}` });
          }
        }
      }
    });
    const coverage = ruleSet.coverage[rule.dimension] ?? "not_reviewed";
    if (coverage !== "encoded") {
      issues.push({ severity: "warning", path: base, message: `rule on ${rule.dimension}, whose coverage is ${coverage} (expected encoded)` });
    }
    if (rule.dimension === "field" && rule.borderline.length === 0 && rule.fields.some((f) => f === "majorCip" || f === "minorCip")) {
      issues.push({ severity: "warning", path: base, message: "field rule without a borderline list: interdisciplinary majors still give unknown" });
    }
  });
  for (const dim of ELIGIBILITY_DIMENSIONS) {
    if (ruleSet.coverage[dim] !== "encoded") continue;
    const used = ruleSet.rules.some((r) => r.dimension === dim) || ruleSet.attestations.some((a) => a.dimension === dim);
    if (!used) issues.push({ severity: "error", path: `coverage.${dim}`, message: "dimension is encoded but no rule or attestation covers it" });
  }
  ruleSet.anyOf.forEach((g, i) => {
    if (!ruleSet.rules.some((r) => r.group === g.id)) issues.push({ severity: "error", path: `anyOf[${i}](${g.id})`, message: "anyOf group has no rules" });
  });
  return issues;
}
