import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EligibilityRuleSet } from "../contracts/eligibility";
import { GoldenRuleSetsFileSchema } from "./golden/schema";
import {
  ENGINE_VERSION,
  RuleSetVersionError,
  applyTemplate,
  assertImmutable,
  canonicalJson,
  compareResults,
  computeRuleSetHash,
  currentRuleSet,
  diffRuleSets,
  evaluateEligibility,
  hashMatches,
  isResultStale,
  parseRuleSet,
  reviseRuleSet,
  sha256Hex,
  supersedeRuleSet,
  verifyRuleSet,
  type RuleSetTemplate,
} from "./index";

const golden = GoldenRuleSetsFileSchema.parse(JSON.parse(readFileSync(path.join(import.meta.dirname, "golden", "rule-sets.json"), "utf8")));
const base = (): EligibilityRuleSet => parseRuleSet(golden.ruleSets["sample-gpa-field-age"]!.ruleSet);
const by = { verifiedBy: "Novus Curator AB", verifiedAt: "2026-11-11T15:00:00Z" };

function shuffleKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shuffleKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, shuffleKeys(v)]));
}

describe("canonical JSON and SHA-256", () => {
  it("matches node:crypto on known vectors and on Unicode", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    for (const s of ["a".repeat(55), "a".repeat(56), "a".repeat(64), "a".repeat(1000), "é ✓ 𝄞 中文", JSON.stringify(base())]) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });

  it("sorts keys, drops undefined members, prints shortest numbers and refuses non-finite ones", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], c: undefined })).toBe('{"a":[true,null,"x"],"b":1}');
    expect(canonicalJson({ n: 3.3, m: 4.0, z: -0 })).toBe('{"m":4,"n":3.3,"z":0}');
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(RangeError);
    expect(() => canonicalJson([undefined])).toThrow(RangeError);
  });

  it("the rule-set hash ignores key order, ids, state and evidence quotes", () => {
    const rs = base();
    const h = computeRuleSetHash(rs);
    expect(computeRuleSetHash(shuffleKeys(rs) as EligibilityRuleSet)).toBe(h);
    const renamed: EligibilityRuleSet = { ...rs, id: "00000000-0000-4000-8000-000000000999", version: 7, evidence: {} };
    expect(computeRuleSetHash(renamed)).toBe(h);
    expect(computeRuleSetHash({ ...rs, rules: rs.rules.slice(1) })).not.toBe(h);
  });
});

describe("versions: draft -> verified -> superseded", () => {
  it("verifying sets the hash and who verified it; verified content cannot change in place", () => {
    const v1 = verifyRuleSet(base(), by);
    expect(v1.state).toBe("verified");
    expect(hashMatches(v1)).toBe(true);
    expect(() => verifyRuleSet(v1, by)).toThrow(RuleSetVersionError);
    const edited = { ...v1, rules: v1.rules.slice(1) };
    expect(() => assertImmutable(v1, edited)).toThrow(/immutable/);
    expect(() => assertImmutable(v1, { ...v1 })).not.toThrow();
  });

  it("changes become a new draft at version + 1 that keeps rule ids", () => {
    const v1 = verifyRuleSet(base(), by);
    const v2 = reviseRuleSet(v1, { id: "00000000-0000-4000-8000-000000000555", changes: { rules: v1.rules.filter((r) => r.id !== "age-18") } });
    expect(v2).toMatchObject({ version: 2, state: "draft", hash: null, verifiedBy: null });
    expect(() => assertImmutable(v1, v2)).not.toThrow();
    expect(() => reviseRuleSet(v2, { id: v2.id })).toThrow(RuleSetVersionError);
    const v2v = verifyRuleSet(v2, by);
    expect(currentRuleSet([v1, v2v], v1.programCycleId)?.version).toBe(2);
    expect(currentRuleSet([supersedeRuleSet(v1), v2], v1.programCycleId)).toBeNull();
    expect(() => supersedeRuleSet(v2)).toThrow(RuleSetVersionError);
  });

  it("diffs compare rules by stable id", () => {
    const v1 = verifyRuleSet(base(), by);
    const changed = v1.rules.map((r) => (r.id === "gpa-floor" ? { ...r, logic: { ">=": [{ var: "gpaMin" }, 3.5] } } : r)).filter((r) => r.id !== "age-18");
    const v2 = reviseRuleSet(v1, {
      id: "00000000-0000-4000-8000-000000000556",
      changes: { rules: changed, coverage: { ...v1.coverage, age: "no_restriction" } },
    });
    const diff = diffRuleSets(v1, v2);
    expect(diff.hashChanged).toBe(true);
    const byId = Object.fromEntries(diff.rules.map((r) => [r.id, r.change]));
    expect(byId).toMatchObject({ "gpa-floor": "changed", "age-18": "removed", "class-year": "unchanged" });
    expect(diff.coverage).toEqual([{ dimension: "age", from: "encoded", to: "no_restriction" }]);
    expect(diff.dimensions).toEqual(["gpa", "age"]);
    // Reordering alone is not a change.
    expect(diffRuleSets(v1, { ...v1, rules: [...v1.rules].reverse() }).rules.every((r) => r.change === "unchanged")).toBe(true);
  });

  it("results record the rule-set version, and go stale when rules or the engine change", () => {
    const v1 = verifyRuleSet(base(), by);
    const result = evaluateEligibility(v1, { gpaBand: "3_5_to_3_74" }, { asOf: "2026-11-11" });
    expect(result.ruleSet).toEqual({ id: v1.id, version: 1, hash: v1.hash });
    expect(isResultStale(result, v1, ENGINE_VERSION)).toBe(false);
    expect(isResultStale(result, v1, "0.9.0")).toBe(true);
    const v2 = verifyRuleSet(reviseRuleSet(v1, { id: "00000000-0000-4000-8000-000000000557" }), by);
    expect(isResultStale(result, v2, ENGINE_VERSION)).toBe(true);
  });

  it("compareResults reports verdict and per-rule changes for alerts", () => {
    const rs = base();
    const before = evaluateEligibility(rs, { gpaBand: "3_5_to_3_74" }, { asOf: "2026-11-11" });
    const after = evaluateEligibility(rs, { gpaBand: "3_0_to_3_24" }, { asOf: "2026-11-11" });
    expect(compareResults(before, before)).toEqual({ changed: false, verdictChanged: false, ruleIds: [] });
    expect(compareResults(before, after)).toMatchObject({ changed: true, ruleIds: ["gpa-floor"] });
  });
});

describe("templates", () => {
  const template: RuleSetTemplate = {
    key: "sample-baseline@2027",
    coverage: { citizenship: "no_restriction", residency: "encoded" },
    rules: [
      { id: "residency", dimension: "residency", group: "all", logic: { in: [{ var: "residenceState" }, ["CA"]] }, fields: ["residenceState"], sensitive: false, asOf: "today", borderline: [], officialText: "Sample baseline: California residents.", evidenceKey: null },
    ],
    anyOf: [],
    attestations: [],
  };

  it("merges template rules, lets the rule set override by id, and hashes the merged body", () => {
    const own = parseRuleSet({ ...base(), templateKey: template.key });
    const merged = applyTemplate(template, own);
    expect(merged.rules.map((r) => r.id)).toContain("residency");
    expect(merged.coverage.residency).toBe("encoded");
    expect(computeRuleSetHash(merged)).not.toBe(computeRuleSetHash(own));
    const override = parseRuleSet({ ...own, rules: [...own.rules, { ...template.rules[0]!, officialText: "Sample site: Oregon.", logic: { in: [{ var: "residenceState" }, ["OR"]] } }] });
    const merged2 = applyTemplate(template, override);
    expect(merged2.rules.filter((r) => r.id === "residency")).toHaveLength(1);
    expect(merged2.rules.find((r) => r.id === "residency")?.officialText).toBe("Sample site: Oregon.");
    expect(() => applyTemplate(template, base())).toThrow(RuleSetVersionError);
  });
});
