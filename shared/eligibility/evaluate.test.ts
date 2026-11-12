import { describe, expect, it } from "vitest";
import {
  ELIGIBILITY_DIMENSIONS,
  EligibilityResultSchema,
  type Coverage,
  type EligibilityDimension,
  type EligibilityRuleSet,
  type EligibilityRuleSetInput,
} from "../contracts/eligibility";
import { GPA_BANDS, GPA_BAND_BOUNDS, type GpaBand } from "../taxonomy";
import { buildEvalContext } from "./context";
import { evaluateEligibility, parseRuleSet, SensitiveInputRejectedError } from "./index";
import { MAX_TEXT } from "./reasons";

const ID = "00000000-0000-4000-8000-000000000001";
const CYCLE = "00000000-0000-4000-8000-000000000002";
const AS_OF = "2026-11-11";

type RuleInput = EligibilityRuleSetInput["rules"][number];

function coverage(over: Partial<Record<EligibilityDimension, Coverage>> = {}): Record<EligibilityDimension, Coverage> {
  return Object.fromEntries(ELIGIBILITY_DIMENSIONS.map((d) => [d, over[d] ?? "no_restriction"])) as Record<EligibilityDimension, Coverage>;
}

function ruleSet(rules: RuleInput[], over: Partial<EligibilityRuleSetInput> = {}): EligibilityRuleSet {
  const encoded = Object.fromEntries(rules.map((r) => [r.dimension, "encoded"]));
  return parseRuleSet({
    id: ID,
    programCycleId: CYCLE,
    version: 1,
    format: "jsonlogic-v1",
    state: "draft",
    createdVia: "sample",
    coverage: coverage(encoded),
    rules,
    ...over,
  });
}

const gpaRule = (floor: number, id = "gpa"): RuleInput => ({
  id,
  dimension: "gpa",
  logic: { ">=": [{ var: "gpaMin" }, floor] },
  fields: ["gpaMin"],
  sensitive: false,
  officialText: `Sample: GPA of at least ${floor}.`,
});
const stateRule = (states: string[], id = "residency"): RuleInput => ({
  id,
  dimension: "residency",
  logic: { in: [{ var: "residenceState" }, states] },
  fields: ["residenceState"],
  sensitive: false,
  officialText: "Sample: residents of listed states.",
});

describe("unknown propagation and coverage", () => {
  it("an empty profile is never eligible when any rule exists", () => {
    const r = evaluateEligibility(ruleSet([gpaRule(3)]), {}, { asOf: AS_OF });
    expect(r.verdict).toBe("unknown");
    expect(r.status).toBe("conditional");
    expect(r.rules[0]?.missingFields).toEqual(["gpaBand"]);
  });

  it("not_reviewed dimensions add a Novus item and can never yield eligible", () => {
    const rs = ruleSet([gpaRule(3)], { coverage: { ...coverage({ gpa: "encoded" }), age: "not_reviewed" } });
    const r = evaluateEligibility(rs, { gpaBand: "3_75_plus" }, { asOf: AS_OF });
    expect(r.rules[0]?.verdict).toBe("met");
    expect(r.verdict).toBe("unknown");
    expect(r.status).toBe("unknown");
    expect(r.pending).toEqual([expect.objectContaining({ id: "coverage:age", kind: "coverage", resolver: "novus" })]);
  });

  it("a dimension missing from coverage counts as not_reviewed", () => {
    const cov = coverage({ gpa: "encoded" });
    delete (cov as Partial<typeof cov>).team;
    const r = evaluateEligibility(ruleSet([gpaRule(3)], { coverage: cov }), { gpaBand: "3_75_plus" }, { asOf: AS_OF });
    expect(r.pending.map((p) => p.id)).toEqual(["coverage:team"]);
  });

  it("none_stated yields eligible on non-launch dimensions and is flagged", () => {
    const r = evaluateEligibility(ruleSet([gpaRule(3)], { coverage: coverage({ gpa: "encoded", age: "none_stated" }) }), { gpaBand: "3_75_plus" }, { asOf: AS_OF });
    expect(r.status).toBe("eligible");
    expect(r.basedOnListedRequirements).toBe(true);
  });

  it("an encoded dimension without any rule is treated as not reviewed", () => {
    const r = evaluateEligibility(ruleSet([gpaRule(3)], { coverage: coverage({ gpa: "encoded", age: "encoded" }) }), { gpaBand: "3_75_plus" }, { asOf: AS_OF });
    expect(r.status).toBe("unknown");
    expect(r.pending.map((p) => p.id)).toEqual(["coverage:age"]);
  });

  it("a not_met rule decides the result even while others are unknown, and pending lists what is also open", () => {
    const r = evaluateEligibility(ruleSet([gpaRule(3.5), stateRule(["CA"])]), { gpaBand: "3_0_to_3_24" }, { asOf: AS_OF });
    expect(r.verdict).toBe("not_met");
    expect(r.status).toBe("not_eligible");
    expect(r.pending.map((p) => p.id)).toEqual(["residency"]);
  });
});

describe("anyOf groups", () => {
  const rs = ruleSet(
    [
      { ...stateRule(["CA"], "ca"), group: "where" },
      { ...stateRule(["OR"], "or"), group: "where" },
    ],
    { anyOf: [{ id: "where", label: "Lives in CA or OR" }] },
  );
  it("is yes when any member is yes", () => {
    expect(evaluateEligibility(rs, { residenceState: "OR" }, { asOf: AS_OF }).verdict).toBe("met");
  });
  it("is no when all members are no", () => {
    expect(evaluateEligibility(rs, { residenceState: "TX" }, { asOf: AS_OF }).verdict).toBe("not_met");
  });
  it("is unknown otherwise, and lists only the open members", () => {
    const r = evaluateEligibility(rs, {}, { asOf: AS_OF });
    expect(r.verdict).toBe("unknown");
    expect(r.pending.map((p) => p.id).sort()).toEqual(["ca", "or"]);
  });
  it("an empty group is a Novus item", () => {
    const empty = ruleSet([stateRule(["CA"])], { anyOf: [{ id: "nobody", label: "Unused" }] });
    const r = evaluateEligibility(empty, { residenceState: "CA" }, { asOf: AS_OF });
    expect(r.status).toBe("unknown");
    expect(r.pending.map((p) => p.id)).toEqual(["group:nobody"]);
  });
});

describe("rule errors and authoring mistakes stay safe", () => {
  it("a type error makes the rule unknown with a Novus resolver, never yes", () => {
    const bad: RuleInput = { ...gpaRule(3), logic: { ">=": [{ var: "gpaMin" }, "3.0"] } };
    const r = evaluateEligibility(ruleSet([bad]), { gpaBand: "3_75_plus" }, { asOf: AS_OF });
    expect(r.rules[0]).toMatchObject({ verdict: "unknown", reasonCode: "RULE_ERROR", resolver: "novus" });
    expect(r.status).toBe("unknown");
  });

  it("var defaults never fill a missing answer", () => {
    const r = evaluateEligibility(ruleSet([{ ...gpaRule(3), logic: { ">=": [{ var: ["gpaMin", 4] }, 3] } }]), {}, { asOf: AS_OF });
    expect(r.rules[0]?.verdict).toBe("unknown");
  });

  it("a missing rule set is unknown with a rule_set_missing item", () => {
    const r = evaluateEligibility(null, {}, { asOf: AS_OF });
    expect(r).toMatchObject({ verdict: "unknown", status: "unknown", ruleSet: null });
    expect(r.pending[0]).toMatchObject({ kind: "rule_set_missing", resolver: "novus" });
  });

  it("asOf must be an ISO date (no clock is ever read)", () => {
    expect(() => evaluateEligibility(null, {}, { asOf: "11/11/2026" })).toThrow(RangeError);
  });
});

describe("server entry point refuses device-only inputs", () => {
  it.each(["answers", "sensitive", "sensitiveAnswers", "attestations"])("rejects opts.%s", (key) => {
    const opts = { asOf: AS_OF, [key]: { citizenship: "us_citizen" } } as unknown as Parameters<typeof evaluateEligibility>[2];
    expect(() => evaluateEligibility(null, {}, opts)).toThrow(SensitiveInputRejectedError);
  });

  it("sensitive rules are never evaluated on the server, so the contract refinement holds", () => {
    const rs = ruleSet([
      { id: "cit", dimension: "citizenship", logic: { in: [{ var: "citizenship" }, ["us_citizen"]] }, fields: ["citizenship"], sensitive: true, officialText: "Sample: citizens." },
    ]);
    // Even a profile object smuggling a status key changes nothing: the field reader never looks.
    const profile = { citizenship: "us_citizen" } as unknown as Parameters<typeof evaluateEligibility>[1];
    const r = evaluateEligibility(rs, profile, { asOf: AS_OF });
    expect(r.rules[0]).toMatchObject({ verdict: "unknown", reasonCode: "SENSITIVE_ON_DEVICE", resolver: "student" });
    expect(r.sensitiveEvaluated).toBe(false);
    expect(() => EligibilityResultSchema.parse(r)).not.toThrow();
  });
});

describe("reasons and evidence", () => {
  it("renders reasons from templates, bounded to the contract length, with evidence attached", () => {
    const long = "Sample: ".concat("x".repeat(390));
    const rs = ruleSet([{ ...gpaRule(3), officialText: long, evidenceKey: "e1" }], {
      evidence: { e1: { basis: "snapshot", url: "https://example.org/rules", quote: "(sample) GPA 3.0", retrievedOn: "2026-11-01" } },
    });
    const r = evaluateEligibility(rs, {}, { asOf: AS_OF });
    const rule = r.rules[0]!;
    expect(rule.reason.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(rule.reason.startsWith("Eligible if you meet this rule:")).toBe(true);
    expect(rule.evidence?.url).toBe("https://example.org/rules");
    expect(r.pending[0]!.selfCheckText.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(() => EligibilityResultSchema.parse(r)).not.toThrow();
  });

  it("missing-field reasons name fields, never values", () => {
    const r = evaluateEligibility(ruleSet([stateRule(["CA"])]), {}, { asOf: AS_OF });
    expect(r.rules[0]!.reason).toContain("state of residence");
  });
});

describe("date-relative rules", () => {
  const standing: RuleInput = {
    id: "standing",
    dimension: "standing",
    logic: { "<=": [1, { var: "semestersRemaining" }, 4] },
    fields: ["semestersRemaining"],
    sensitive: false,
    asOf: "program_start",
    officialText: "Sample: one to four semesters left at the program start.",
  };
  const inst = { id: ID, level: "four_year" as const, calendar: "semester" as const };
  const ctx = (start: string | null) =>
    buildEvalContext({
      institution: inst,
      deadlines: start
        ? [{ kind: "program_start", scope: "national", institutionId: null, basis: "official", localDate: start }]
        : [],
    });

  it("the same student flips only when the anchor moves, not when today moves", () => {
    const p = { expectedGraduationTerm: "spring-2029" };
    expect(evaluateEligibility(ruleSet([standing]), p, { asOf: "2026-11-11", context: ctx("2027-09") }).verdict).toBe("met");
    expect(evaluateEligibility(ruleSet([standing]), p, { asOf: "2027-06-30", context: ctx("2027-09") }).verdict).toBe("met");
    expect(evaluateEligibility(ruleSet([standing]), p, { asOf: "2026-11-11", context: ctx("2026-09") }).verdict).toBe("not_met");
  });

  it("rules judged today use opts.asOf", () => {
    const today = { ...standing, asOf: "today" as const };
    expect(evaluateEligibility(ruleSet([today]), { expectedGraduationTerm: "spring-2029" }, { asOf: "2027-01-15", context: ctx(null) }).verdict).toBe("not_met");
    expect(evaluateEligibility(ruleSet([today]), { expectedGraduationTerm: "spring-2029" }, { asOf: "2027-06-30", context: ctx(null) }).verdict).toBe("met");
  });

  it("unsupported calendars leave standing unknown for the student to check", () => {
    const other = buildEvalContext({ institution: { ...inst, calendar: "continuous" }, deadlines: [{ kind: "program_start", scope: "national", institutionId: null, basis: "official", localDate: "2027-09-01" }] });
    const r = evaluateEligibility(ruleSet([standing]), { expectedGraduationTerm: "spring-2029" }, { asOf: AS_OF, context: other });
    expect(r.rules[0]).toMatchObject({ verdict: "unknown", reasonCode: "CALENDAR_CONVERSION", resolver: "student" });
  });
});

// -------------------------------------------------------------------------------------------
// Seeded property tests (fast-check is not installed; a fixed-seed PRNG keeps them reproducible)
// -------------------------------------------------------------------------------------------

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STATES = ["CA", "OR", "WA", "TX", "NY"];
const YEARS = ["first_year", "second_year", "third_year"];
const REAL_BANDS = GPA_BANDS.filter((b) => GPA_BAND_BOUNDS[b] !== null) as GpaBand[];
const FLOORS = [2.0, 2.5, 2.8, 3.0, 3.3, 3.5, 3.6, 3.75];

function randomRuleSet(rand: () => number): EligibilityRuleSet {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const rules: RuleInput[] = [];
  const anyOf: { id: string; label: string }[] = [];
  const n = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < n; i++) {
    const kind = Math.floor(rand() * 3);
    const group = rand() < 0.3 ? "g1" : "all";
    if (group === "g1" && anyOf.length === 0) anyOf.push({ id: "g1", label: "Group" });
    if (kind === 0) rules.push({ ...gpaRule(pick(FLOORS), `r${i}`), group });
    else if (kind === 1) rules.push({ ...stateRule(STATES.filter(() => rand() < 0.5), `r${i}`), group });
    else rules.push({ id: `r${i}`, dimension: "standing", group, logic: { "!=": [{ var: "classYear" }, pick(YEARS)] }, fields: ["classYear"], sensitive: false, officialText: "Sample." });
  }
  const cov = coverage(Object.fromEntries(rules.map((r) => [r.dimension, "encoded"])));
  if (rand() < 0.2) cov.age = "not_reviewed";
  return ruleSet(rules, { anyOf, coverage: cov });
}

function randomProfile(rand: () => number): Record<string, string> {
  const p: Record<string, string> = {};
  if (rand() < 0.7) p.gpaBand = REAL_BANDS[Math.floor(rand() * REAL_BANDS.length)] as string;
  if (rand() < 0.7) p.residenceState = STATES[Math.floor(rand() * STATES.length)] as string;
  if (rand() < 0.7) p.classYear = YEARS[Math.floor(rand() * YEARS.length)] as string;
  return p;
}

describe("properties over 400 random rule sets and profiles", () => {
  const rand = prng(20261111);
  const samples = Array.from({ length: 400 }, () => ({ rs: randomRuleSet(rand), profile: randomProfile(rand) }));
  const flips = (a: string, b: string): boolean => (a === "met" && b === "not_met") || (a === "not_met" && b === "met");

  it("clause and group order never change the result", () => {
    for (const { rs, profile } of samples) {
      const a = evaluateEligibility(rs, profile, { asOf: AS_OF });
      const b = evaluateEligibility({ ...rs, rules: [...rs.rules].reverse() }, profile, { asOf: AS_OF });
      expect(b.verdict).toBe(a.verdict);
      expect(b.status).toBe(a.status);
    }
  });

  it("adding an answer never flips met <-> not_met", () => {
    for (const { rs, profile } of samples) {
      const full = evaluateEligibility(rs, profile, { asOf: AS_OF });
      for (const key of Object.keys(profile)) {
        const less = { ...profile };
        delete less[key];
        expect(flips(full.verdict, evaluateEligibility(rs, less, { asOf: AS_OF }).verdict)).toBe(false);
      }
    }
  });

  it("every not_met names a not_met rule; not_reviewed never yields met; results satisfy the contract", () => {
    for (const { rs, profile } of samples) {
      const r = evaluateEligibility(rs, profile, { asOf: AS_OF });
      if (r.verdict === "not_met") expect(r.rules.some((x) => x.verdict === "not_met")).toBe(true);
      if (rs.coverage.age === "not_reviewed") expect(r.verdict).not.toBe("met");
      if (r.status === "conditional") expect(r.pending.every((p) => p.resolver === "student")).toBe(true);
      expect(() => EligibilityResultSchema.parse(r)).not.toThrow();
    }
  });

  it("GPA verdicts match a brute-force check of every GPA (in hundredths) inside the band", () => {
    for (const band of REAL_BANDS) {
      const { min, max } = GPA_BAND_BOUNDS[band]!;
      const gpas: number[] = [];
      for (let h = Math.round(min * 100); h < Math.round(max * 100); h++) gpas.push(h / 100);
      for (const floor of [...FLOORS, 3.25, 3.49, 3.74]) {
        const passes = gpas.filter((g) => g >= floor).length;
        const expected = passes === gpas.length ? "met" : passes === 0 ? "not_met" : "unknown";
        const r = evaluateEligibility(ruleSet([gpaRule(floor)]), { gpaBand: band }, { asOf: AS_OF });
        expect(r.rules[0]!.verdict, `${band} >= ${floor}`).toBe(expected);
      }
    }
  });
});
