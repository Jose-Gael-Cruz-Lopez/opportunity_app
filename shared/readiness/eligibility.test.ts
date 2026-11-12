import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { missingEligibilityResult, summarizeEligibility } from "./eligibility";
import { evaluateEligibility, parseRuleSet } from "../eligibility";
import { GoldenRuleSetsFileSchema } from "../eligibility/golden/schema";
import { conditionalEligibility, eligibleResult, notEligibleResult } from "./test-fixtures";
import { EligibilityResultSchema } from "../contracts/eligibility";

describe("eligibility part (shown unchanged, summarized for copy)", () => {
  it("splits rules by verdict and pending items by who resolves them", () => {
    const s = summarizeEligibility(conditionalEligibility());
    expect(s.status).toBe("conditional");
    expect(s.met.map((r) => r.ruleId)).toEqual(["standing"]);
    expect(s.unknown.map((r) => r.ruleId)).toEqual(["citizenship", "institution-participates"]);
    expect(s.studentToResolve.map((p) => p.id)).toEqual(["citizenship", "institution-participates"]);
    expect(s.novusToResolve).toEqual([]);
    expect(s.headline).toBe("Eligible if 2 more rules apply to you.");
  });

  it("names the first failed rule when the student is not eligible", () => {
    const s = summarizeEligibility(notEligibleResult());
    expect(s.headline).toBe("Not eligible: The program is for third-year students.");
    expect(s.notMet).toHaveLength(1);
  });

  it("says what an eligible verdict rests on", () => {
    expect(summarizeEligibility(eligibleResult()).headline).toBe("You meet every eligibility rule Novus has checked.");
    expect(summarizeEligibility({ ...eligibleResult(), basedOnListedRequirements: true }).headline).toBe(
      "You meet every requirement the program lists.",
    );
  });

  it("a program without verified rules is unknown with a Novus item, never eligible", () => {
    const missing = missingEligibilityResult("2026-11-11");
    expect(EligibilityResultSchema.safeParse(missing).success).toBe(true);
    const s = summarizeEligibility(missing);
    expect(s.status).toBe("unknown");
    expect(s.novusToResolve.map((p) => p.kind)).toEqual(["rule_set_missing"]);
    expect(s.headline).toMatch(/see the official page/);
  });

  it("fixtures are valid evaluator results", () => {
    for (const r of [conditionalEligibility(), eligibleResult(), notEligibleResult()]) {
      expect(EligibilityResultSchema.safeParse(r).success).toBe(true);
    }
  });

  it("does not depend on rule order", () => {
    const r = conditionalEligibility();
    const reversed = { ...r, rules: [...r.rules].reverse(), pending: [...r.pending].reverse() };
    expect(summarizeEligibility(reversed)).toEqual(summarizeEligibility(r));
  });
});

describe("anyOf groups in the conditional headline", () => {
  // The golden sample rule set reduced to its "pathway" group (four-year OR transfer-bound).
  const golden = GoldenRuleSetsFileSchema.parse(
    JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "eligibility", "golden", "rule-sets.json"), "utf8")),
  );
  const full = parseRuleSet(golden.ruleSets["sample-gpa-field-age"]!.ruleSet);
  const pathwayOnly = () => {
    const rules = full.rules.filter((r) => r.group === "pathway");
    const dims = new Set(rules.map((r) => r.dimension));
    const coverage = Object.fromEntries(
      Object.entries(full.coverage).map(([dim, state]) => [dim, state === "encoded" && !dims.has(dim as never) ? "no_restriction" : state]),
    ) as typeof full.coverage;
    return { ...full, rules, coverage };
  };

  it("counts an unresolved group once, whatever its member count", () => {
    const result = evaluateEligibility(pathwayOnly(), {}, { asOf: "2026-11-11" });
    expect(result.status).toBe("conditional");
    const s = summarizeEligibility(result);
    expect(s.studentToResolve.map((p) => p.id).sort()).toEqual(["four-year", "transfer-bound"]);
    expect(s.studentConditions).toBe(1);
    expect(s.headline).toBe("Eligible if one of these applies to you.");
  });

  it("counts a group plus standalone rules as separate conditions", () => {
    const base = conditionalEligibility();
    const grouped = {
      ...base,
      rules: [
        ...base.rules,
        { ...base.rules[2]!, ruleId: "four-year", group: "pathway" },
        { ...base.rules[2]!, ruleId: "transfer-bound", group: "pathway" },
      ],
      pending: [
        ...base.pending,
        { ...base.pending[1]!, id: "four-year" },
        { ...base.pending[1]!, id: "transfer-bound" },
      ],
    };
    const s = summarizeEligibility(grouped);
    expect(s.studentConditions).toBe(3);
    expect(s.headline).toBe("Eligible if 3 more conditions apply to you.");
  });

  it("keeps the rule count when no group is open", () => {
    expect(summarizeEligibility(conditionalEligibility()).studentConditions).toBe(2);
  });
});
