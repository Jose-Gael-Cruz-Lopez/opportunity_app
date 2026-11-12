import type { EligibilityRuleSet, Requirement, RequirementKind } from "@shared/contracts";
import { deviceEligibilityRows } from "./device-eligibility";
import type { PlanStepView } from "./normalize";

/**
 * The four readiness parts for the chosen program, built on the device for the onboarding
 * preview: eligibility, requirements, competitiveness and next actions (plan 07 7.4.2).
 *
 * Private answers (citizenship, Pell, first-generation) arrive here from React memory and are
 * used only inside this pure function. Nothing it returns repeats the answer itself; rows say
 * met, not met or "answer privately to check".
 *
 * Eligibility rows come from the shared evaluator (@shared/eligibility/sensitive's
 * evaluateWithAnswers, through device-eligibility.ts). The small JsonLogic subset below is only
 * the fallback when that engine cannot read a rule set; it returns "unknown" for anything it
 * does not know, which can never turn into a false "eligible".
 */

export type Verdict = "met" | "not_met" | "unknown";

export interface PrivateAnswers {
  citizenship?: string;
  pell?: string;
  firstGeneration?: string;
}

/** Fields the private screen can answer; everything else comes from the quiz. */
export const PRIVATE_FIELDS = ["citizenship", "pell", "firstGeneration"] as const;
export type PrivateField = (typeof PRIVATE_FIELDS)[number];

export interface EligibilityRow {
  id: string;
  text: string;
  verdict: Verdict;
  /** True when the rule reads a private answer: it is checked only in this browser. */
  private: boolean;
  /** Private fields still unanswered for this rule. */
  needs: PrivateField[];
}

export interface RequirementRow {
  id: string;
  label: string;
  kind: RequirementKind;
  state: "met" | "gap";
  startBy: string | null;
  severity: "late" | "soon" | "planned" | null;
}

export interface ReadinessView {
  eligibility: { status: "eligible" | "not_eligible" | "check"; rows: EligibilityRow[] };
  requirements: { rows: RequirementRow[]; met: number; total: number };
  competitiveness: { status: "insufficient_data"; text: string };
  nextActions: Array<{ id: string; title: string; due: string | null }>;
}

type Ctx = Record<string, unknown>;

const UNKNOWN = Symbol("unknown");
type Val = unknown | typeof UNKNOWN;

/** Evaluates var, in, ==, !=, !, and, or, <, <=, >, >= with three-valued logic. */
export function evalLogic(expr: unknown, ctx: Ctx): Val {
  if (expr === null || typeof expr !== "object") return expr;
  if (Array.isArray(expr)) {
    const vals = expr.map((e) => evalLogic(e, ctx));
    return vals.includes(UNKNOWN) ? UNKNOWN : vals;
  }
  const entries = Object.entries(expr as Record<string, unknown>);
  if (entries.length !== 1) return UNKNOWN;
  const [op, rawArgs] = entries[0];
  const args = Array.isArray(rawArgs) ? rawArgs : [rawArgs];
  if (op === "var") {
    const key = String(args[0]);
    const v = ctx[key];
    return v === undefined || v === null || v === "prefer_not" || v === "not_sure" ? UNKNOWN : v;
  }
  if (op === "and" || op === "or") {
    let sawUnknown = false;
    for (const a of args) {
      const v = evalLogic(a, ctx);
      if (v === UNKNOWN) sawUnknown = true;
      else if (op === "and" && !v) return false;
      else if (op === "or" && v) return true;
    }
    return sawUnknown ? UNKNOWN : op === "and";
  }
  const vals = args.map((a) => evalLogic(a, ctx));
  if (vals.includes(UNKNOWN)) return UNKNOWN;
  const [a, b] = vals;
  switch (op) {
    case "in":
      return Array.isArray(b) ? b.includes(a) : typeof b === "string" && typeof a === "string" ? b.includes(a) : false;
    case "==":
    case "===":
      return a === b;
    case "!=":
    case "!==":
      return a !== b;
    case "!":
      return !a;
    case "<":
      return (a as number) < (b as number);
    case "<=":
      return (a as number) <= (b as number);
    case ">":
      return (a as number) > (b as number);
    case ">=":
      return (a as number) >= (b as number);
    default:
      return UNKNOWN;
  }
}

export function ruleVerdict(logic: unknown, ctx: Ctx): Verdict {
  const v = evalLogic(logic, ctx);
  if (v === UNKNOWN) return "unknown";
  return v ? "met" : "not_met";
}

/** Rule-set eligibility on the device: classYear from the quiz, private fields from memory. */
export function eligibilityRows(rules: EligibilityRuleSet | null, classYear: string | null, priv: PrivateAnswers, today?: string): EligibilityRow[] {
  if (!rules) return [];
  const shared = deviceEligibilityRows(rules, classYear, priv, today ?? new Date().toISOString().slice(0, 10));
  if (shared) return shared;
  return subsetEligibilityRows(rules, classYear, priv);
}

/** The conservative fallback: a JsonLogic subset with three-valued logic. */
export function subsetEligibilityRows(rules: EligibilityRuleSet, classYear: string | null, priv: PrivateAnswers): EligibilityRow[] {
  const ctx: Ctx = { classYear, ...priv };
  return rules.rules.map((r) => {
    const needs = r.fields.filter(
      (f): f is PrivateField => (PRIVATE_FIELDS as readonly string[]).includes(f) && !priv[f as PrivateField],
    );
    return { id: r.id, text: r.officialText, verdict: ruleVerdict(r.logic, ctx), private: r.sensitive, needs };
  });
}

function overall(rows: EligibilityRow[]): ReadinessView["eligibility"]["status"] {
  if (rows.some((r) => r.verdict === "not_met")) return "not_eligible";
  if (rows.length > 0 && rows.every((r) => r.verdict === "met")) return "eligible";
  return "check";
}

const DAY = 86_400_000;

function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return new Date(d.getTime() + days * DAY).toISOString().slice(0, 10);
}

/** Days between two ISO dates, b - a. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
}

/**
 * Backward scheduling per requirement: start-by = deadline - (lead days + effort days at one
 * hour a day). Severity: late if start-by has passed, soon within 7 days, otherwise planned.
 */
export function requirementRows(
  requirements: readonly Requirement[],
  deadline: string | null,
  today: string,
  haveResume: boolean,
): RequirementRow[] {
  return requirements.map((r) => {
    const effortDays = Math.ceil((r.effortHours ?? 1) * r.quantity);
    const startBy = deadline ? addDaysIso(deadline, -((r.leadTimeDays ?? 0) + effortDays)) : null;
    const gapDays = startBy ? daysBetween(today, startBy) : null;
    const met = r.kind === "resume" && haveResume;
    return {
      id: r.id,
      label: r.label,
      kind: r.kind,
      state: met ? "met" : "gap",
      startBy: met ? null : startBy,
      severity: met || gapDays === null ? null : gapDays < 0 ? "late" : gapDays <= 7 ? "soon" : "planned",
    };
  });
}

export interface ReadinessInput {
  rules: EligibilityRuleSet | null;
  requirements: readonly Requirement[];
  deadline: string | null;
  today: string;
  classYear: string | null;
  privateAnswers: PrivateAnswers;
  haveResume: boolean;
  steps: readonly PlanStepView[];
  doneStepIds: ReadonlySet<string>;
}

export function buildReadinessView(input: ReadinessInput): ReadinessView {
  const rows = eligibilityRows(input.rules, input.classYear, input.privateAnswers, input.today);
  const reqRows = requirementRows(input.requirements, input.deadline, input.today, input.haveResume);
  return {
    eligibility: { status: overall(rows), rows },
    requirements: { rows: reqRows, met: reqRows.filter((r) => r.state === "met").length, total: reqRows.length },
    competitiveness: {
      status: "insufficient_data",
      text: "Not enough verified outcomes yet to describe how competitive this is. Novus never shows a chance or a score about you.",
    },
    nextActions: input.steps
      .filter((s) => !input.doneStepIds.has(s.id))
      .slice(0, 4)
      .map((s) => ({ id: s.id, title: s.title, due: s.due })),
  };
}
