import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoldenRuleSetsFileSchema } from "./golden/schema";
import { evaluateEligibility, parseRuleSet } from "./index";
import { AnswerBox, DeviceOnlyError, SensitiveSerializationError, createAnswerBox, evaluateWithAnswers } from "./sensitive";

const golden = GoldenRuleSetsFileSchema.parse(JSON.parse(readFileSync(path.join(import.meta.dirname, "golden", "rule-sets.json"), "utf8")));
const rs = parseRuleSet(golden.ruleSets["sample-identity-pell"]!.ruleSet);

describe("AnswerBox keeps answers out of every serialization path", () => {
  const box = createAnswerBox({ citizenship: "daca", pell: "recipient", identity: { gender_identity: ["woman"] } }, new Set(["community-member"]));

  it("JSON.stringify throws instead of sending anything", () => {
    expect(() => JSON.stringify(box)).toThrow(SensitiveSerializationError);
    expect(() => JSON.stringify({ payload: box })).toThrow(SensitiveSerializationError);
  });

  it("exposes no enumerable data, prints a mask and does not survive structuredClone", () => {
    expect(Object.keys(box)).toEqual([]);
    expect({ ...box }).toEqual({});
    expect(String(box)).toBe("[SensitiveAnswers]");
    expect(`${box}`).not.toContain("daca");
    const clone = structuredClone(box);
    expect(JSON.stringify(Object.entries(clone))).not.toContain("daca");
    expect(Object.isFrozen(box)).toBe(true);
  });

  it("validates answers strictly (unknown keys or values are refused, not ignored)", () => {
    expect(() => new AnswerBox({ citizenship: "martian" } as never)).toThrow();
    expect(() => new AnswerBox({ income: 10 } as never)).toThrow();
  });

  it("answers only sensitive catalogue fields", () => {
    expect(box.sensitiveValue("citizenship")).toBe("daca");
    expect(box.sensitiveValue("identity.gender_identity")).toEqual(["woman"]);
    expect(box.sensitiveValue("gpaBand")).toBeUndefined();
    expect(box.attestation("community-member")).toBe(true);
    expect(box.attestation("other")).toBeUndefined();
  });
});

describe("evaluateWithAnswers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a frozen result that refuses to serialize", () => {
    const r = evaluateWithAnswers(rs, {}, { asOf: "2026-11-11", answers: { pell: "recipient", identity: { gender_identity: ["woman"] } }, attestations: new Set(["community-member"]) });
    expect(r.status).toBe("eligible");
    expect(r.sensitiveEvaluated).toBe(true);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.rules[0])).toBe(true);
    expect(() => JSON.stringify(r)).toThrow(SensitiveSerializationError);
    expect(() => JSON.stringify({ body: r })).toThrow(SensitiveSerializationError);
  });

  it("never copies an answer value into the result", () => {
    const r = evaluateWithAnswers(rs, {}, {
      asOf: "2026-11-11",
      answers: createAnswerBox({ pell: "eligible_not_receiving", identity: { gender_identity: ["nonbinary"] } }),
    });
    const text = [...r.rules.map((x) => x.reason + x.officialText + x.missingFields.join()), ...r.pending.map((p) => p.selfCheckText)].join("|");
    expect(text).not.toContain("nonbinary");
    expect(text).not.toContain("eligible_not_receiving");
  });

  it("never contradicts the server result for the same inputs", () => {
    const server = evaluateEligibility(rs, {}, { asOf: "2026-11-11" });
    const device = evaluateWithAnswers(rs, {}, { asOf: "2026-11-11", answers: { pell: "not_recipient" } });
    expect(server.verdict).toBe("unknown");
    expect(device.verdict).toBe("not_met");
  });

  it("refuses to run inside a Cloudflare Worker", () => {
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    expect(() => evaluateWithAnswers(rs, {}, { asOf: "2026-11-11", answers: { citizenship: "us_citizen" } })).toThrow(DeviceOnlyError);
  });

  it("an answer value appears nowhere in the evaluation output", () => {
    const box = createAnswerBox({ identity: { gender_identity: ["woman"] } });
    const r = evaluateWithAnswers(rs, {}, { asOf: "2026-11-11", answers: box });
    const dump = JSON.stringify({ ...r, rules: r.rules.map((x) => ({ ...x })), pending: r.pending.map((x) => ({ ...x })) });
    expect(dump).not.toContain('"woman"');
  });
});
