import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GoldenRuleSetsFileSchema } from "./golden/schema";
import { checkRuleSet, parseRuleSet } from "./index";

const golden = GoldenRuleSetsFileSchema.parse(JSON.parse(readFileSync(path.join(import.meta.dirname, "golden", "rule-sets.json"), "utf8")));

describe("checkRuleSet", () => {
  it("passes every golden rule set without errors", () => {
    for (const [key, entry] of Object.entries(golden.ruleSets)) {
      const issues = checkRuleSet(parseRuleSet(entry.ruleSet)).filter((i) => i.severity === "error");
      expect(issues, key).toEqual([]);
    }
  });

  it("catches vocabulary typos, var defaults, encoded-but-empty dimensions and empty groups", () => {
    const base = parseRuleSet(golden.ruleSets["sample-partially-reviewed"]!.ruleSet);
    const rs = {
      ...base,
      coverage: { ...base.coverage, age: "encoded" as const },
      anyOf: [{ id: "empty", label: "Nothing" }],
      rules: [
        ...base.rules.filter((r) => r.id !== "residency"),
        { ...base.rules.find((r) => r.id === "residency")!, logic: { in: [{ var: ["residenceState", "CA"] }, ["CA", "Calfornia"]] } },
        { ...base.rules.find((r) => r.id === "visa-status")!, id: "visa-2", logic: { "==": [{ var: "citizenship" }, "green_card"] } },
      ],
    };
    const messages = checkRuleSet(rs).map((i) => `${i.severity}: ${i.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        'error: "Calfornia" is not a value of residenceState',
        'error: "green_card" is not a value of citizenship',
        "warning: var defaults are ignored: missing answers stay unknown",
        "error: dimension is encoded but no rule or attestation covers it",
        "error: anyOf group has no rules",
      ]),
    );
  });

  it("warns on numbers that would not hash the same in Python", () => {
    const base = parseRuleSet(golden.ruleSets["sample-gpa-field-age"]!.ruleSet);
    const rs = { ...base, rules: base.rules.map((r) => (r.id === "gpa-floor" ? { ...r, logic: { ">=": [{ var: "gpaMin" }, 3.123456] } } : r)) };
    expect(checkRuleSet(rs).some((i) => i.message.includes("at most 4 decimals"))).toBe(true);
  });
});
