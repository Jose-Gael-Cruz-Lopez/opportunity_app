import { describe, expect, it } from "vitest";
import {
  EXPOSURE_BOOST_MAX,
  RRF_K,
  binaryEntropy,
  cosine,
  exposureBoost,
  jaccard,
  median,
  mmrSelect,
  ranksWithTies,
  reciprocalRankFusion,
  type MmrCandidate,
} from "./rank";

describe("reciprocal rank fusion", () => {
  it("sums 1 / (k + rank) with k = 60", () => {
    expect(RRF_K).toBe(60);
    const a = new Map([["x", 1], ["y", 2]]);
    const b = new Map([["y", 1]]);
    const fused = reciprocalRankFusion([a, b]);
    expect(fused.get("x")).toBeCloseTo(1 / 61, 12);
    expect(fused.get("y")).toBeCloseTo(1 / 62 + 1 / 61, 12);
    // An item high in two lists beats one that tops a single list.
    expect((fused.get("y") ?? 0) > (fused.get("x") ?? 0)).toBe(true);
  });

  it("gives exact ties the average rank, so tie-break order cannot leak", () => {
    const ranks = ranksWithTies([{ id: "a", v: 3 }, { id: "b", v: 3 }, { id: "c", v: 1 }], (x) => x.id, (p, q) => p.v === q.v);
    expect(ranks.get("a")).toBe(1.5);
    expect(ranks.get("b")).toBe(1.5);
    expect(ranks.get("c")).toBe(3);
  });
});

describe("MMR", () => {
  const c = (id: string, rel: number, features: string[]): MmrCandidate => ({ id, rel, features: new Set(features), key: id });

  it("trades a little relevance for a different organization and type", () => {
    const picked = mmrSelect(
      [c("a", 1, ["org:x", "type:intern"]), c("b", 0.95, ["org:x", "type:intern"]), c("c", 0.8, ["org:y", "type:research"])],
      { lambda: 0.7, limit: 2 },
    );
    expect(picked.map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("is pure relevance at lambda 1 and respects a hard cap", () => {
    const items = [c("a", 1, ["org:x"]), c("b", 0.9, ["org:x"]), c("c", 0.8, ["org:x"]), c("d", 0.1, ["org:y"])];
    expect(mmrSelect(items, { lambda: 1, limit: 3 }).map((p) => p.id)).toEqual(["a", "b", "c"]);
    let taken = 0;
    const capped = mmrSelect(items, { lambda: 1, limit: 3, accept: (m) => !m.features.has("org:x") || taken < 2, onTake: (m) => { if (m.features.has("org:x")) taken++; } });
    expect(capped.map((p) => p.id)).toEqual(["a", "b", "d"]);
  });

  it("breaks exact ties by key", () => {
    expect(mmrSelect([c("b", 0.5, []), c("a", 0.5, [])], { lambda: 0.7, limit: 1 })[0]?.id).toBe("a");
  });
});

describe("exposure boost", () => {
  it("follows b_fair = 0.08 * clamp(1 - eps / median, 0, 1)", () => {
    expect(EXPOSURE_BOOST_MAX).toBe(0.08);
    expect(exposureBoost(0, 10)).toBeCloseTo(0.08, 12);
    expect(exposureBoost(5, 10)).toBeCloseTo(0.04, 12);
    expect(exposureBoost(10, 10)).toBe(0);
    expect(exposureBoost(30, 10)).toBe(0);
    expect(exposureBoost(3, 0)).toBe(0);
  });
});

describe("helpers", () => {
  it("computes jaccard, median, cosine and entropy", () => {
    expect(jaccard(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3, 12);
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 2], [1])).toBe(0);
    expect(binaryEntropy(0.5)).toBe(1);
    expect(binaryEntropy(0)).toBe(0);
    expect(binaryEntropy(0.2)).toBeCloseTo(0.7219, 3);
  });
});
