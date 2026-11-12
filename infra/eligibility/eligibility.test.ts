import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EligibilityRuleSet } from "../../shared/contracts/eligibility";
import { parseRuleSet } from "../../shared/eligibility/index";
import { boundaryProfiles, profileKeysRead, runBoundaryGate } from "./boundary";
import { loadGoldenFiles, runGoldenCases, sameJsonValue } from "./golden-runner";
import { eligibilityReleaseGate } from "./release-gate";
import { jsonText, nodeResultsFile, pythonCatalogue, PYTHON_DATA_DIR } from "./snapshots";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const GOLDEN = path.join(ROOT, "shared", "eligibility", "golden");
const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
const cases = readJson(path.join(GOLDEN, "cases.json"));
const ruleSets = readJson(path.join(GOLDEN, "rule-sets.json"));
const ASOF = "2027-01-15";

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe("generated files for the Python port and workerd parity", () => {
  const files: [string, unknown][] = [
    ["catalogue.json", pythonCatalogue()],
    ["node-results.json", nodeResultsFile({ cases, ruleSets })],
  ];
  for (const [name, value] of files) {
    it(`${PYTHON_DATA_DIR}/${name} is up to date`, () => {
      const file = path.join(ROOT, PYTHON_DATA_DIR, name);
      const text = jsonText(value);
      if (process.env.UPDATE_GOLDEN === "1") {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, text);
      }
      expect(existsSync(file), `${file} missing: run with UPDATE_GOLDEN=1`).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(text);
    });
  }

  it("node-results.json never carries a device-evaluated result", () => {
    const file = readJson(path.join(ROOT, PYTHON_DATA_DIR, "node-results.json")) as { results: Record<string, { sensitiveEvaluated: boolean }> };
    expect(Object.values(file.results).every((r) => r.sensitiveEvaluated === false)).toBe(true);
  });
});

describe("golden runner (Node)", () => {
  const snapshotFile = path.join(ROOT, PYTHON_DATA_DIR, "node-results.json");
  const snapshot = existsSync(snapshotFile) ? (readJson(snapshotFile) as { results: Record<string, unknown> }).results : {};

  it("passes on the committed golden files, with the snapshot", () => {
    const report = runGoldenCases({ cases, ruleSets, snapshot }, "node");
    expect(report.failures).toEqual([]);
    expect(report.cases).toBeGreaterThanOrEqual(50);
    expect(report.expectationsChecked).toBeGreaterThanOrEqual(40);
    expect(report.twinsChecked).toBeGreaterThan(0);
    expect(report.expectationsChecked + report.twinsChecked).toBe(report.cases);
  });

  it("detects a wrong label (negative control)", () => {
    const bad = clone(cases) as { cases: { id: string; device?: unknown; expect: { verdict: string; status: string } }[] };
    const target = bad.cases.find((c) => !c.device && c.expect.verdict === "not_met");
    expect(target).toBeDefined();
    if (!target) return;
    target.expect.verdict = "met";
    target.expect.status = "eligible";
    const report = runGoldenCases({ cases: bad, ruleSets }, "node");
    expect(report.failures.some((f) => f.startsWith(`case ${target.id} [node]: verdict`))).toBe(true);
  });

  it("detects a tampered rule set hash and a snapshot drift (negative controls)", () => {
    const badSets = clone(ruleSets) as { ruleSets: Record<string, { expectHash: string }> };
    const key = Object.keys(badSets.ruleSets)[0] as string;
    (badSets.ruleSets[key] as { expectHash: string }).expectHash = "0".repeat(64);
    expect(runGoldenCases({ cases, ruleSets: badSets }, "node").failures.some((f) => f.startsWith(`rule set ${key}`))).toBe(true);

    const drift = clone(snapshot) as Record<string, { status: string }>;
    const id = Object.keys(drift)[0] as string;
    (drift[id] as { status: string }).status = "drifted";
    expect(runGoldenCases({ cases, ruleSets, snapshot: drift }, "node").failures).toContain(`case ${id} [node]: differs from the Node snapshot`);
  });

  it("keeps JSON types apart when comparing", () => {
    expect(sameJsonValue({ a: [1, "x"] }, { a: [1, "x"] })).toBe(true);
    expect(sameJsonValue(true, 1)).toBe(false);
    expect(sameJsonValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe("boundary-profile gate", () => {
  const loaded = loadGoldenFiles({ cases, ruleSets });
  const targets = [...loaded.ruleSets.entries()].map(([label, ruleSet]) => ({ ruleSet, label }));

  it("passes on every sample rule set", () => {
    const report = runBoundaryGate(targets, ASOF);
    expect(report.failures).toEqual([]);
    expect(report.ruleSets).toBe(targets.length);
    expect(report.profiles).toBeGreaterThan(targets.length * 10);
  });

  it("generates profiles from the fields the rules read, never sensitive ones", () => {
    for (const { ruleSet } of targets) {
      const keys = profileKeysRead(ruleSet);
      expect(keys.every((k) => !["citizenship", "pell", "financialNeed", "firstGeneration"].includes(k))).toBe(true);
      const { single, rich } = boundaryProfiles(ruleSet, ASOF);
      expect(single[0]).toEqual({});
      for (const p of [...single, ...rich]) expect(Object.keys(p).every((k) => keys.includes(k))).toBe(true);
    }
  });

  it("fails a rule set whose logic cannot run (negative control)", () => {
    const base = targets.find((t) => t.ruleSet.rules.some((r) => !r.sensitive && r.fields.includes("enrollmentIntensity")));
    expect(base).toBeDefined();
    if (!base) return;
    const broken: EligibilityRuleSet = parseRuleSet({
      ...base.ruleSet,
      rules: base.ruleSet.rules.map((r) => (r.fields.includes("enrollmentIntensity") && !r.sensitive ? { ...r, logic: { "<": [{ var: "enrollmentIntensity" }, 3] } } : r)),
    });
    const report = runBoundaryGate([{ ruleSet: broken, label: "broken" }], ASOF);
    expect(report.failures.some((f) => f.startsWith("broken: rule") && f.includes("RULE_ERROR"))).toBe(true);
  });
});

describe("eligibility release gate", () => {
  const loaded = loadGoldenFiles({ cases, ruleSets });
  const targets = [...loaded.ruleSets.entries()].map(([label, ruleSet]) => ({ ruleSet, label }));

  it("is ok on the committed files", () => {
    const gate = eligibilityReleaseGate({ golden: { cases, ruleSets }, targets, asOf: ASOF });
    expect(gate.reasons).toEqual([]);
    expect(gate.ok).toBe(true);
  });

  it("caps and labels reasons", () => {
    const bad = clone(cases) as { cases: { device?: unknown; expect: { verdict: string } }[] };
    for (const c of bad.cases) if (!c.device) c.expect.verdict = c.expect.verdict === "met" ? "not_met" : "met";
    const gate = eligibilityReleaseGate({ golden: { cases: bad, ruleSets }, targets: [], asOf: ASOF });
    expect(gate.ok).toBe(false);
    expect(gate.reasons.length).toBeLessThanOrEqual(21);
    expect(gate.reasons.every((r) => r.startsWith("eligibility golden cases: "))).toBe(true);
    expect(gate.reasons.at(-1)).toMatch(/and \d+ more$/);
  });
});
