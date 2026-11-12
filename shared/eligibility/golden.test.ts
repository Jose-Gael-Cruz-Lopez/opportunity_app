import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EligibilityResultSchema, type EligibilityResult, type EligibilityRuleSet } from "../contracts/eligibility";
import { toJsonSchema } from "../contracts/json-schema";
import type { SensitiveAnswers } from "../contracts/sensitive";
import type { EvalContext } from "./context";
import { GoldenCasesFileSchema, GoldenRuleSetsFileSchema, type GoldenCase } from "./golden/schema";
import { ENGINE_VERSION, computeRuleSetHash, evaluateEligibility, parseRuleSet } from "./index";
import { DIMENSION_LABELS, REASON_TEMPLATES, SELF_CHECK_TEMPLATES } from "./reasons";
import { evaluateWithAnswers } from "./sensitive";

/**
 * Node runner for the golden files. The same JSON is the contract for the workerd and browser
 * runners (to be configured) and for the Python pipeline. Besides each case's expectations it
 * checks three invariants on every case: the redacted twin (no device answers) never contradicts
 * the full result, forgetting any profile answer never flips met <-> not_met, and rule order does
 * not matter.
 */

const dir = path.join(import.meta.dirname, "golden");
const readJson = (name: string): unknown => JSON.parse(readFileSync(path.join(dir, name), "utf8"));
const casesFile = GoldenCasesFileSchema.parse(readJson("cases.json"));
const ruleSetsFile = GoldenRuleSetsFileSchema.parse(readJson("rule-sets.json"));

function semverAtLeast(have: string, need: string): boolean {
  const a = have.split(".").map(Number);
  const b = need.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

function ruleSetFor(c: GoldenCase): EligibilityRuleSet | null {
  if (c.ruleSet === null) return null;
  const entry = ruleSetsFile.ruleSets[c.ruleSet];
  if (!entry) throw new Error(`unknown rule set ${c.ruleSet}`);
  return parseRuleSet(entry.ruleSet);
}

function contextFor(c: GoldenCase): EvalContext {
  return casesFile.contexts[c.context] as unknown as EvalContext;
}

function run(c: GoldenCase, ruleSet: EligibilityRuleSet | null, withDevice: boolean): EligibilityResult {
  const opts = { asOf: c.asOf, context: contextFor(c) };
  const profile = c.profile as Parameters<typeof evaluateEligibility>[1];
  if (withDevice && c.device) {
    return evaluateWithAnswers(ruleSet, profile, {
      ...opts,
      answers: c.device.answers as SensitiveAnswers,
      attestations: new Map(Object.entries(c.device.attestations)),
    });
  }
  return evaluateEligibility(ruleSet, profile, opts);
}

const verdictMap = (r: EligibilityResult): Record<string, string> => Object.fromEntries(r.rules.map((x) => [x.ruleId, x.verdict]));
const flips = (a: string, b: string): boolean => (a === "met" && b === "not_met") || (a === "not_met" && b === "met");

describe("golden files", () => {
  it("are supported by this engine version", () => {
    expect(semverAtLeast(ENGINE_VERSION, casesFile.engineMin)).toBe(true);
  });

  it("store rule sets already normalized, with the expected hash", () => {
    for (const [key, entry] of Object.entries(ruleSetsFile.ruleSets)) {
      const parsed = parseRuleSet(entry.ruleSet);
      expect(parsed, key).toEqual(entry.ruleSet);
      expect(computeRuleSetHash(parsed), key).toBe(entry.expectHash);
      expect(parsed.createdVia, key).toBe("sample");
      expect(parsed.state, key).toBe("draft");
    }
  });

  it("have unique case ids and cover every reason code family", () => {
    const ids = casesFile.cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const codes = new Set(casesFile.cases.flatMap((c) => Object.values(c.expect.reasonCodes)));
    for (const code of ["MET", "NOT_MET", "MISSING_FIELD", "STRADDLES_LIMIT", "CALENDAR_CONVERSION", "BORDERLINE_FIELD", "PARTICIPATION_UNCONFIRMED",
      "SENSITIVE_ON_DEVICE", "SENSITIVE_UNANSWERED", "CONTEXT_MISSING", "ATTESTATION_ON_DEVICE", "ATTESTATION_CONFIRMED", "ATTESTATION_DECLINED", "ATTESTATION_UNANSWERED"]) {
      expect(codes.has(code), code).toBe(true);
    }
  });

  it("mirror the reason templates for other runtimes", () => {
    const expected = { reasons: REASON_TEMPLATES, selfCheck: SELF_CHECK_TEMPLATES, dimensionLabels: DIMENSION_LABELS };
    const file = path.join(dir, "reason-templates.json");
    const text = `${JSON.stringify(expected, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(file, text);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  it("publish a JSON Schema of their format for pydantic", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        casesFile: toJsonSchema(GoldenCasesFileSchema, { title: "GoldenCasesFile" }),
        ruleSetsFile: toJsonSchema(GoldenRuleSetsFileSchema, { title: "GoldenRuleSetsFile" }),
      },
    };
    const file = path.join(dir, "golden-files.schema.json");
    const text = `${JSON.stringify(schema, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === "1") writeFileSync(file, text);
    expect(readFileSync(file, "utf8")).toBe(text);
  });
});

describe.each(casesFile.cases.filter((c) => c.runtimes.includes("node")).map((c) => [c.id, c] as const))("golden case %s", (_id, c) => {
  const ruleSet = ruleSetFor(c);
  const result = run(c, ruleSet, true);

  it("matches the hand-labelled expectation", () => {
    expect(result.verdict).toBe(c.expect.verdict);
    expect(result.status).toBe(c.expect.status);
    expect(verdictMap(result)).toEqual(c.expect.rules);
    expect(Object.fromEntries(result.rules.map((r) => [r.ruleId, r.reasonCode]))).toEqual(c.expect.reasonCodes);
    for (const r of result.rules) expect(r.missingFields, r.ruleId).toEqual(c.expect.missingFields?.[r.ruleId] ?? []);
    const pending = result.pending.map((p) => ({ id: p.id, kind: p.kind, resolver: p.resolver, sensitive: p.sensitive }));
    const byId = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    expect([...pending].sort(byId)).toEqual([...c.expect.pending].sort(byId));
    expect(result.basedOnListedRequirements).toBe(c.expect.basedOnListedRequirements);
    expect(result.asOf).toBe(c.asOf);
    expect(result.sensitiveEvaluated).toBe(Boolean(c.device));
  });

  it("satisfies the result contract", () => {
    expect(() => EligibilityResultSchema.parse({ ...result })).not.toThrow();
  });

  it("redacted twin never contradicts the full result and keeps sensitive rules unknown", () => {
    const twin = run(c, ruleSet, false);
    expect(twin.sensitiveEvaluated).toBe(false);
    expect(flips(result.verdict, twin.verdict)).toBe(false);
    const full = verdictMap(result);
    for (const r of twin.rules) {
      const isAttestation = r.group === "attestations";
      if (r.sensitive || isAttestation) {
        expect(r.verdict, r.ruleId).toBe("unknown");
        expect(["SENSITIVE_ON_DEVICE", "ATTESTATION_ON_DEVICE"]).toContain(r.reasonCode);
      } else {
        expect(r.verdict, r.ruleId).toBe(full[r.ruleId]);
      }
    }
    const hasDeviceOnly = (ruleSet?.rules.some((r) => r.sensitive) ?? false) || (ruleSet?.attestations.length ?? 0) > 0;
    if (hasDeviceOnly) expect(twin.verdict).not.toBe("met");
  });

  it("never flips met <-> not_met when a profile answer is forgotten", () => {
    for (const key of Object.keys(c.profile)) {
      const profile = { ...c.profile };
      delete profile[key];
      const less = run({ ...c, profile }, ruleSet, true);
      expect(flips(result.verdict, less.verdict), key).toBe(false);
      const before = verdictMap(result);
      for (const r of less.rules) expect(flips(before[r.ruleId] as string, r.verdict), `${key}:${r.ruleId}`).toBe(false);
    }
  });

  it("does not depend on rule, group or attestation order", () => {
    if (!ruleSet) return;
    const reversed = { ...ruleSet, rules: [...ruleSet.rules].reverse(), attestations: [...ruleSet.attestations].reverse(), anyOf: [...ruleSet.anyOf].reverse() };
    const again = run(c, reversed, true);
    expect(again.verdict).toBe(result.verdict);
    expect(again.status).toBe(result.status);
    expect(verdictMap(again)).toEqual(verdictMap(result));
  });
});
