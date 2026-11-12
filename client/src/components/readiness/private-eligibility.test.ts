import { describe, expect, it } from "vitest";
import { EligibilityResultSchema, EligibilityRuleSetSchema, type EligibilityRuleSet } from "@shared/contracts/eligibility";
import { SensitiveAnswersSchema, type SensitiveAnswers } from "@shared/contracts/sensitive";
import {
  answerFor,
  applyPrivateAnswers,
  baseResultFromRuleSet,
  combineAny,
  evaluatePrivateRule,
  isUnanswered,
  overallVerdict,
  questionFor,
  questionsForOpenRules,
  withAnswer,
} from "./private-eligibility";
import { SAMPLE_PROGRAM_DETAIL, SAMPLE_READINESS } from "./fixtures";

const ruleSet = SAMPLE_PROGRAM_DETAIL.ruleSet as EligibilityRuleSet;
const base = SAMPLE_READINESS.eligibility;

describe("reading answers", () => {
  it("reads flat and identity answers and treats prefer-not as unanswered", () => {
    const a: SensitiveAnswers = { citizenship: "us_citizen", identity: { race_ethnicity: ["asian"] } };
    expect(answerFor(a, "citizenship")).toBe("us_citizen");
    expect(answerFor(a, "identity.race_ethnicity")).toEqual(["asian"]);
    expect(isUnanswered("citizenship", undefined)).toBe(true);
    expect(isUnanswered("citizenship", "prefer_not")).toBe(true);
    expect(isUnanswered("firstGeneration", "not_sure")).toBe(true);
    expect(isUnanswered("identity.race_ethnicity", [])).toBe(true);
    expect(isUnanswered("citizenship", "daca")).toBe(false);
  });

  it("writes answers immutably and the result validates as SensitiveAnswers", () => {
    const a0 = {};
    const a1 = withAnswer(a0, "citizenship", "permanent_resident");
    const a2 = withAnswer(a1, "identity.gender_identity", ["woman"]);
    const a3 = withAnswer(a2, "citizenship", undefined);
    expect(a0).toEqual({});
    expect(a2).toEqual({ citizenship: "permanent_resident", identity: { gender_identity: ["woman"] } });
    expect(a3).toEqual({ identity: { gender_identity: ["woman"] } });
    expect(SensitiveAnswersSchema.safeParse(a2).success).toBe(true);
  });
});

describe("evaluatePrivateRule", () => {
  const citizenship = ruleSet.rules.find((r) => r.id === "citizenship")!;
  const standing = ruleSet.rules.find((r) => r.id === "standing")!;

  it("decides a sensitive rule from the answer", () => {
    expect(evaluatePrivateRule(citizenship, { citizenship: "us_citizen" })).toEqual({ verdict: "met", missing: [] });
    expect(evaluatePrivateRule(citizenship, { citizenship: "f1" })).toEqual({ verdict: "not_met", missing: [] });
    expect(evaluatePrivateRule(citizenship, { citizenship: "prefer_not" })).toEqual({ verdict: "unknown", missing: ["citizenship"] });
    expect(evaluatePrivateRule(citizenship, {})).toEqual({ verdict: "unknown", missing: ["citizenship"] });
  });

  it("leaves non-sensitive and mixed rules to the shared evaluator", () => {
    expect(evaluatePrivateRule(standing, { citizenship: "us_citizen" })).toBeNull();
    const mixed = { ...citizenship, id: "mixed", fields: ["citizenship", "classYear"] as typeof citizenship.fields };
    expect(evaluatePrivateRule(mixed, { citizenship: "us_citizen" })).toBeNull();
  });

  it("reads identity lists through JsonLogic", () => {
    const rule = {
      ...citizenship,
      id: "identity",
      dimension: "identity" as const,
      logic: { in: ["woman", { var: "identity.gender_identity" }] },
      fields: ["identity.gender_identity"] as typeof citizenship.fields,
    };
    expect(evaluatePrivateRule(rule, { identity: { gender_identity: ["woman"] } })?.verdict).toBe("met");
    expect(evaluatePrivateRule(rule, { identity: { gender_identity: ["man"] } })?.verdict).toBe("not_met");
    expect(evaluatePrivateRule(rule, { identity: { gender_identity: ["prefer_not"] } })?.verdict).toBe("unknown");
  });
});

describe("applyPrivateAnswers", () => {
  it("keeps the server result when nothing is answered", () => {
    const r = applyPrivateAnswers(base, ruleSet, {});
    expect(r.status).toBe("conditional");
    expect(r.sensitiveEvaluated).toBe(false);
    expect(r.pending).toHaveLength(1);
    expect(EligibilityResultSchema.safeParse(r).success).toBe(true);
  });

  it("becomes eligible when the private answer meets the rule", () => {
    const r = applyPrivateAnswers(base, ruleSet, { citizenship: "permanent_resident" });
    expect(r.verdict).toBe("met");
    expect(r.status).toBe("eligible");
    expect(r.pending).toEqual([]);
    expect(r.sensitiveEvaluated).toBe(true);
    expect(r.rules.find((x) => x.ruleId === "citizenship")?.reasonCode).toBe("SENSITIVE_MET_ON_DEVICE");
    // A browser-side result with sensitiveEvaluated may carry decided sensitive rules.
    expect(EligibilityResultSchema.safeParse(r).success).toBe(true);
  });

  it("becomes not eligible when it does not, without echoing the answer", () => {
    const r = applyPrivateAnswers(base, ruleSet, { citizenship: "j1" });
    expect(r.status).toBe("not_eligible");
    expect(JSON.stringify(r)).not.toContain("j1");
  });

  it("does not mutate its inputs", () => {
    const before = JSON.stringify(base);
    applyPrivateAnswers(base, ruleSet, { citizenship: "us_citizen" });
    expect(JSON.stringify(base)).toBe(before);
  });

  it("lets the student confirm attestations and open non-sensitive rules", () => {
    const withAttestation = {
      ...base,
      pending: [...base.pending, { id: "residency", kind: "attestation" as const, dimension: "residency" as const, sensitive: false, resolver: "student" as const, selfCheckText: "Live in a coastal state." }],
    };
    const r1 = applyPrivateAnswers(withAttestation, ruleSet, { citizenship: "us_citizen" });
    expect(r1.status).toBe("conditional");
    const r2 = applyPrivateAnswers(withAttestation, ruleSet, { citizenship: "us_citizen" }, new Set(["residency"]));
    expect(r2.status).toBe("eligible");
  });

  it("stays unknown while Novus still has to check something", () => {
    const withNovus = { ...base, pending: [...base.pending, { id: "coverage:transfer", kind: "coverage" as const, dimension: "transfer" as const, sensitive: false, resolver: "novus" as const, selfCheckText: "Not reviewed." }] };
    expect(applyPrivateAnswers(withNovus, ruleSet, { citizenship: "us_citizen" }).status).toBe("unknown");
  });
});

describe("verdict combination", () => {
  it("treats anyOf groups as OR and the rest as AND", () => {
    expect(combineAny(["not_met", "met"])).toBe("met");
    expect(combineAny(["not_met", "not_met"])).toBe("not_met");
    expect(combineAny(["not_met", "unknown"])).toBe("unknown");
    const rule = base.rules[0]!;
    const rules = [
      { ...rule, ruleId: "a", group: "g", verdict: "not_met" as const },
      { ...rule, ruleId: "b", group: "g", verdict: "met" as const },
      { ...rule, ruleId: "c", group: "all", verdict: "met" as const },
    ];
    expect(overallVerdict(rules, [])).toBe("met");
    expect(overallVerdict([...rules, { ...rule, ruleId: "d", group: "all", verdict: "not_met" as const }], [])).toBe("not_met");
  });
});

describe("baseResultFromRuleSet (withheld programs)", () => {
  it("starts every rule unknown with a self-check, and decides sensitive ones on the device", () => {
    const start = baseResultFromRuleSet(ruleSet, "2026-11-11");
    expect(EligibilityResultSchema.safeParse(start).success).toBe(true);
    expect(start.rules.every((r) => r.verdict === "unknown")).toBe(true);
    expect(start.pending.map((p) => p.id)).toEqual(ruleSet.rules.map((r) => r.id));
    const confirmedAll = new Set(ruleSet.rules.filter((r) => !r.sensitive).map((r) => r.id));
    const done = applyPrivateAnswers(start, ruleSet, { citizenship: "us_national" }, confirmedAll);
    expect(done.status).toBe("eligible");
  });
});

describe("questions", () => {
  it("asks only about sensitive fields of open rules, once each", () => {
    const qs = questionsForOpenRules(base, ruleSet);
    expect(qs.map((q) => q.field)).toEqual(["citizenship"]);
    expect(qs[0]?.options.some((o) => o.value === "prefer_not")).toBe(true);
  });

  it("builds identity questions as multi-select with prefer-not", () => {
    const q = questionFor("identity.race_ethnicity");
    expect(q?.multiple).toBe(true);
    expect(q?.options.at(-1)?.value).toBe("prefer_not");
    expect(questionFor("identity.foster_care")?.multiple).toBe(false);
    expect(questionFor("classYear")).toBeNull();
  });

  it("the fixture rule set is valid", () => {
    expect(EligibilityRuleSetSchema.safeParse(ruleSet).success).toBe(true);
  });
});
