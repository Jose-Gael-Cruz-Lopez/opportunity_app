import { describe, expect, it } from "vitest";
import { generateKnownItemQueries, recallAtK, retrievalGate, runRetrievalEval, scriptedMisspelling, wilsonInterval } from "./eval";
import { exposureFromPositions, exposureGini, fairnessBoosts, positionWeight } from "./exposure";
import { SAMPLE_CARDS } from "./fixtures/sample-cards";
import { PROVISIONAL_QUERIES } from "./fixtures/queries";
import { fuseRankings } from "./fusion";
import { buildIndex } from "./search";

describe("wilsonInterval", () => {
  it("gives about 0.88 as the lower bound for 140 of 150", () => {
    const { lower, upper } = wilsonInterval(140, 150);
    expect(lower).toBeCloseTo(0.881, 2);
    expect(upper).toBeCloseTo(0.964, 2);
  });

  it("handles the edges", () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1 });
    expect(wilsonInterval(10, 10).upper).toBeCloseTo(1, 12);
    expect(wilsonInterval(0, 10).lower).toBe(0);
  });
});

describe("recallAtK", () => {
  it("divides by min(k, |R|)", () => {
    expect(recallAtK(["a", "b", "c"], ["a"], 10)).toBe(1);
    expect(recallAtK(["a", "b", "c"], ["c", "d"], 2)).toBe(0);
    expect(recallAtK(["a", "b"], ["a", "b", "c"], 2)).toBe(1);
    expect(recallAtK([], [], 10)).toBe(1);
  });
});

describe("scriptedMisspelling", () => {
  it("doubles a consonant in the longest word", () => {
    expect(scriptedMisspelling("Goldwater Scholarship")).toBe("Goldwater Scholarrship");
    expect(scriptedMisspelling("Goldwater")).toBe("Goldwatter");
    expect(scriptedMisspelling("AI")).toBeNull();
  });
});

describe("retrieval eval on the sample release", () => {
  const index = buildIndex(SAMPLE_CARDS);

  it("passes the gate on generated known-item queries", () => {
    const queries = generateKnownItemQueries(SAMPLE_CARDS);
    expect(queries.length).toBeGreaterThan(SAMPLE_CARDS.length);
    const report = runRetrievalEval(index, queries);
    expect(report.missedQueryIds).toEqual([]);
    expect(retrievalGate(report).pass).toBe(true);
  });

  it("passes the gate on the provisional team-written queries", () => {
    const report = runRetrievalEval(index, PROVISIONAL_QUERIES);
    expect(report.zeroResultCount).toBe(0);
    expect(report.meanRecall).toBeGreaterThanOrEqual(0.9);
    expect(retrievalGate(report)).toEqual({ pass: true, reasons: [] });
  });

  it("fails the gate with reasons when recall or zero results miss", () => {
    const bad = runRetrievalEval(index, [{ id: "x", query: "zzzzqqq", relevant: [SAMPLE_CARDS[0]!.programCycleId], source: "provisional" }]);
    const gate = retrievalGate(bad);
    expect(gate.pass).toBe(false);
    expect(gate.reasons).toHaveLength(2);
  });
});

describe("fuseRankings (RRF, k = 60)", () => {
  it("orders by summed reciprocal ranks and returns ids only", () => {
    // a: 1/61 + 1/62, c: 1/63 + 1/61, b: 1/62
    expect(fuseRankings([["a", "b", "c"], ["c", "a"]])).toEqual(["a", "c", "b"]);
  });

  it("cuts each leg at the depth and ignores repeats", () => {
    expect(fuseRankings([["a", "a", "b", "c"]], 60, 2)).toEqual(["a", "b"]);
  });
});

describe("exposure (Phase 3 helpers)", () => {
  it("uses v_j = 1 / log2(1 + j)", () => {
    expect(positionWeight(1)).toBe(1);
    expect(positionWeight(3)).toBe(0.5);
    expect(exposureFromPositions([1, 3])).toBe(1.5);
    expect(() => positionWeight(0)).toThrow();
  });

  it("boosts only under-exposed items above the median relevance, bounded by the weight", () => {
    const boosts = fairnessBoosts([
      { id: "seen", exposure: 10, relevance: 5 },
      { id: "unseen", exposure: 0, relevance: 6 },
      { id: "mid", exposure: 4, relevance: 4 },
      { id: "low", exposure: 0, relevance: 1 },
    ]);
    expect(boosts.get("unseen")).toBeCloseTo(0.08);
    expect(boosts.get("seen")).toBe(0);
    expect(boosts.get("low")).toBe(0); // below median relevance
    for (const v of boosts.values()) expect(v).toBeLessThanOrEqual(0.08);
  });

  it("computes the exposure Gini", () => {
    expect(exposureGini([1, 1, 1])).toBe(0);
    expect(exposureGini([0, 0, 3])).toBeCloseTo(2 / 3);
  });
});
