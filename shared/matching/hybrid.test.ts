import { describe, expect, it, vi } from "vitest";
import { MATCHING_CONFIG } from "./config";
import { alignEmbeddings, type DenseIndex } from "./embeddings";
import { compareRetrieval, generateKnownItemQueries, hybridGate, reciprocalRank, type RetrievalComparison } from "./eval";
import { CONCEPT_ALIGN, conceptEmbedder, conceptEmbeddingsFile } from "./fixtures/concept-embedder";
import { PARAPHRASE_QUERIES } from "./fixtures/hybrid-queries";
import { PROVISIONAL_QUERIES } from "./fixtures/queries";
import { SAMPLE_CARDS, SAMPLE_NOW, sampleCardBySlug } from "./fixtures/sample-cards";
import { fuseRankings, fuseWithLexicalTail } from "./fusion";
import { denseLeg, hybridSearch, hybridSearchIds, type QueryEmbedder } from "./hybrid";
import { buildIndex, search, searchIds } from "./search";
import { explainWhyShown } from "./why-shown";

const index = buildIndex(SAMPLE_CARDS);
const dense = alignEmbeddings(conceptEmbeddingsFile(SAMPLE_CARDS), SAMPLE_CARDS, CONCEPT_ALIGN).index as DenseIndex;
const id = (slug: string) => sampleCardBySlug(slug).programCycleId;

describe("fuseRankings (RRF, k = 60)", () => {
  it("uses k = 60 and depth 50 by default", () => {
    expect(MATCHING_CONFIG.fusion.rrfK).toBe(60);
    expect(MATCHING_CONFIG.fusion.depth).toBe(50);
  });

  it("puts agreement between legs above one leg's top pick", () => {
    // b is 10th in both legs; a is 1st in one leg only: 2/70 > 1/61.
    const lex = ["a", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "b"];
    const den = ["y1", "y2", "y3", "y4", "y5", "y6", "y7", "y8", "y9", "b"];
    expect(fuseRankings([lex, den]).indexOf("b")).toBeLessThan(fuseRankings([lex, den]).indexOf("a"));
  });

  it("keeps a single leg's order and breaks ties by first-seen (lexical first)", () => {
    expect(fuseRankings([["a", "b", "c"]])).toEqual(["a", "b", "c"]);
    expect(fuseRankings([["a", "b"], ["b", "a"]])).toEqual(["a", "b"]);
  });

  it("ignores repeats and cuts each leg at depth", () => {
    expect(fuseRankings([["a", "a", "b"]])).toEqual(["a", "b"]);
    expect(fuseRankings([["a", "b", "c"]], 60, 2)).toEqual(["a", "b"]);
  });

  it("applies exposure boosts only to retrieved ids, clamped to [0, fairWeight]", () => {
    expect(fuseRankings([["a", "b"]], 60, 50, new Map([["b", 0.08]]))).toEqual(["b", "a"]); // 1/62 + 0.08/61 > 1/61
    expect(fuseRankings([["a", "b"]], 60, 50, new Map([["z", 0.08]]))).toEqual(["a", "b"]);
    expect(fuseRankings([["a", "b"]], 60, 50, new Map([["a", -5]]))).toEqual(["a", "b"]);
    // A huge boost is clamped: it cannot jump a single-leg hit over a two-leg top-10 hit.
    const lex = ["a", "x1", "x2", "x3", "x4", "x5", "x6", "x7", "x8", "b"];
    const den = ["y1", "y2", "y3", "y4", "y5", "y6", "y7", "y8", "y9", "b"];
    const order = fuseRankings([lex, den], 60, 50, new Map([["a", 1000]]));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("a"));
  });

  it("fuseWithLexicalTail appends lexical ids past the cut and drops the dense tail", () => {
    const lex = Array.from({ length: 60 }, (_, i) => `l${i}`);
    const den = Array.from({ length: 60 }, (_, i) => `d${i}`);
    const out = fuseWithLexicalTail(lex, den);
    expect(out).toHaveLength(110); // 50 + 50 fused, plus the 10 lexical ids past the cut
    expect(out.slice(-10)).toEqual(lex.slice(50));
    expect(out).not.toContain("d55");
  });
});

describe("search() with a dense ranking", () => {
  it("is unchanged without dense ranking or boosts", () => {
    const a = search(index, "summer research", { now: SAMPLE_NOW, limit: 50 }).map((r) => r.card.slug);
    const b = search(index, "summer research", { now: SAMPLE_NOW, limit: 50, denseRanking: [] }).map((r) => r.card.slug);
    expect(b).toEqual(a);
  });

  it("labels dense-only hits MEANING_MATCH and keeps lexical field reasons", () => {
    const res = search(index, "ocean", { now: SAMPLE_NOW, denseRanking: [id("coastal-ecology-reu")] });
    const coastal = res.find((r) => r.card.slug === "coastal-ecology-reu");
    expect(coastal?.whyShown).toEqual([{ code: "MEANING_MATCH" }]);
    expect(explainWhyShown(coastal!)[0]?.text).toMatch(/Close in meaning/);
    const named = search(index, "coastal", { now: SAMPLE_NOW, denseRanking: [id("coastal-ecology-reu")] })[0];
    expect(named?.whyShown.map((w) => w.code)).toContain("NAME_MATCH");
  });

  it("never lets a filtered-out program in through the dense leg", () => {
    const res = search(index, "ocean", { now: SAMPLE_NOW, filters: { types: ["sprinternship"] }, denseRanking: [id("coastal-ecology-reu")] });
    expect(res.map((r) => r.card.slug)).not.toContain("coastal-ecology-reu");
  });

  it("returns integer ranks only, never a fused value", () => {
    const res = search(index, "data", { now: SAMPLE_NOW, denseRanking: [id("lattice-ml-fellowship")] });
    res.forEach((r, i) => {
      expect(r.rank).toBe(i);
      expect(Object.keys(r).sort()).toEqual(["card", "matchedTerms", "rank", "whyShown"]);
    });
  });
});

describe("denseLeg fallbacks: every failure is lexical only", () => {
  const embed: QueryEmbedder = conceptEmbedder;

  it("no index, no embedder, screened query", async () => {
    expect(await denseLeg(null, "ocean science", { embed })).toEqual({ status: "lexical_only", reason: "no_index" });
    expect(await denseLeg(dense, "ocean science", {})).toEqual({ status: "lexical_only", reason: "no_embedder" });
    expect(await denseLeg(dense, "DACA ocean science", { embed })).toEqual({ status: "lexical_only", reason: "sensitive_term" });
  });

  it("does not call the embedder for a screened query", async () => {
    const spy = vi.fn(embed);
    await denseLeg(dense, "my visa status", { embed: spy });
    await denseLeg(dense, "jo@example.org", { embed: spy });
    expect(spy).not.toHaveBeenCalled();
  });

  it("passes the release's model, dimensions and query task to the embedder", async () => {
    const spy = vi.fn(embed);
    await denseLeg(dense, "Ocean Science", { embed: spy });
    expect(spy).toHaveBeenCalledWith({ text: "ocean science", model: dense.model, dims: dense.dims, taskType: MATCHING_CONFIG.dense.queryTask });
  });

  it("timeout, thrown error, null, wrong length", async () => {
    const slow: QueryEmbedder = () => new Promise((resolve) => setTimeout(() => resolve([1]), 200));
    expect(await denseLeg(dense, "ocean science", { embed: slow, timeoutMs: 10 })).toEqual({ status: "lexical_only", reason: "timeout" });
    const lateFailure: QueryEmbedder = () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 30));
    expect(await denseLeg(dense, "ocean science", { embed: lateFailure, timeoutMs: 5 })).toEqual({ status: "lexical_only", reason: "timeout" });
    await new Promise((resolve) => setTimeout(resolve, 40)); // the late rejection must stay handled
    expect(await denseLeg(dense, "ocean science", { embed: async () => Promise.reject(new Error("503")) })).toEqual({ status: "lexical_only", reason: "error" });
    expect(await denseLeg(dense, "ocean science", { embed: async () => null })).toEqual({ status: "lexical_only", reason: "no_embedder" });
    expect(await denseLeg(dense, "ocean science", { embed: async () => [1, 2, 3] })).toEqual({ status: "lexical_only", reason: "bad_vector" });
  });

  it("no hit above the cosine floor", async () => {
    const orthogonal: QueryEmbedder = async ({ dims }) => Array.from({ length: dims }, (_, i) => (i === 0 ? 1 : 0));
    expect(await denseLeg({ ...dense, minSimilarity: 0.999 }, "ocean science", { embed: orthogonal })).toEqual({ status: "lexical_only", reason: "no_dense_hits" });
  });

  it("uses a precomputed query vector without calling the embedder", async () => {
    const withQueries = alignEmbeddings(conceptEmbeddingsFile(SAMPLE_CARDS, ["ocean science summer"]), SAMPLE_CARDS, CONCEPT_ALIGN).index as DenseIndex;
    const spy = vi.fn(embed);
    const leg = await denseLeg(withQueries, " Ocean  Science Summer", { embed: spy });
    expect(leg).toMatchObject({ status: "used", source: "precomputed" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("hybridSearch", () => {
  it("falls back to exactly the lexical results with no key", async () => {
    for (const q of ["ocean science summer", "summit bank", "reu", "DACA research"]) {
      const res = await hybridSearch(index, q, { dense, embed: null, now: SAMPLE_NOW });
      expect(res.mode).toBe("lexical");
      expect(res.results).toEqual(search(index, q, { now: SAMPLE_NOW }));
    }
    expect((await hybridSearch(index, "ocean", { now: SAMPLE_NOW })).reason).toBe("no_index");
    expect(await hybridSearch(index, "  ", { dense, embed: conceptEmbedder })).toEqual({ results: [], mode: "lexical", reason: null });
  });

  it("finds a paraphrase the lexical leg misses", async () => {
    const q = "wildlife fieldwork";
    expect(searchIds(index, q, 10)).not.toContain(id("coastal-ecology-reu"));
    const res = await hybridSearch(index, q, { dense, embed: conceptEmbedder, now: SAMPLE_NOW });
    expect(res.mode).toBe("hybrid");
    expect(res.results[0]?.card.slug).toBe("coastal-ecology-reu");
    expect(res.results[0]?.whyShown).toEqual([{ code: "MEANING_MATCH" }]);
  });

  it("keeps exact name hits on top", async () => {
    for (const card of SAMPLE_CARDS) {
      const ids = await hybridSearchIds(index, dense, card.name, 10, conceptEmbedder);
      expect([card.slug, ids[0]]).toEqual([card.slug, card.programCycleId]);
    }
  });

  it("passes exposure boosts through", async () => {
    const lexical = await hybridSearch(index, "summit bank", { now: SAMPLE_NOW });
    const last = lexical.results.at(-1)!.card.programCycleId;
    const boosted = await hybridSearch(index, "summit bank", { now: SAMPLE_NOW, exposureBoosts: new Map([[last, 0.08]]) });
    expect(boosted.results.map((r) => r.card.programCycleId).indexOf(last)).toBeLessThan(lexical.results.length - 1);
  });
});

// ---------------------------------------------------------------------------------------------
// Retrieval evaluation: lexical vs hybrid on labelled fixtures (recall@10, MRR)
// ---------------------------------------------------------------------------------------------

describe("retrieval eval: lexical vs hybrid (stand-in embedder, sample cards)", () => {
  const lexicalRanker = (q: string, k: number) => searchIds(index, q, k);
  const hybridRanker = (q: string, k: number) => hybridSearchIds(index, dense, q, k, conceptEmbedder);
  const sets = {
    known: generateKnownItemQueries(SAMPLE_CARDS),
    provisional: PROVISIONAL_QUERIES,
    paraphrase: PARAPHRASE_QUERIES,
  } as const;
  const results: Record<string, RetrievalComparison> = {};

  it("computes recall@10 and MRR for both legs on every set", async () => {
    for (const [name, qs] of Object.entries(sets)) results[name] = await compareRetrieval(qs, lexicalRanker, hybridRanker, 10);
    results.all = await compareRetrieval([...sets.known, ...sets.provisional, ...sets.paraphrase], lexicalRanker, hybridRanker, 10);
    const rows = Object.entries(results).map(([name, c]) => ({
      set: name,
      n: c.lexical.n,
      "lexical recall@10": c.lexical.meanRecall.toFixed(3),
      "hybrid recall@10": c.hybrid.meanRecall.toFixed(3),
      "lexical MRR": c.lexical.mrr.toFixed(3),
      "hybrid MRR": c.hybrid.mrr.toFixed(3),
      wins: c.hybridWins.length,
      losses: c.hybridLosses.length,
    }));
    console.table(rows); // eslint-disable-line no-console -- the eval report; no query text from users
    expect(Object.keys(results)).toHaveLength(4);
  });

  it("hybrid loses no recall on known-item or provisional queries", () => {
    expect(results.known!.hybrid.meanRecall).toBeGreaterThanOrEqual(results.known!.lexical.meanRecall);
    expect(results.provisional!.hybrid.meanRecall).toBeGreaterThanOrEqual(results.provisional!.lexical.meanRecall);
    expect(results.known!.hybridLosses).toEqual([]);
  });

  it("hybrid improves recall@10 and MRR on paraphrase queries", () => {
    expect(results.paraphrase!.hybrid.meanRecall).toBeGreaterThan(results.paraphrase!.lexical.meanRecall);
    expect(results.paraphrase!.hybrid.mrr).toBeGreaterThan(results.paraphrase!.lexical.mrr);
    expect(results.paraphrase!.hybrid.zeroResultCount).toBe(0);
  });

  it("passes the hybrid gate on all labelled queries", () => {
    expect(hybridGate(results.all!)).toEqual({ pass: true, reasons: [] });
  });

  it("the gate fails a hybrid that buries known items", async () => {
    const reversed = async (q: string, k: number) => (await hybridRanker(q, 50)).reverse().slice(0, k);
    const bad = await compareRetrieval(sets.known, lexicalRanker, reversed, 10);
    const gate = hybridGate(bad);
    expect(gate.pass).toBe(false);
    expect(gate.reasons.join(" ")).toMatch(/MRR|recall/);
  });

  it("reciprocalRank is 1/rank of the first relevant id", () => {
    expect(reciprocalRank(["a", "b", "c"], ["c", "b"])).toBeCloseTo(0.5, 12);
    expect(reciprocalRank(["a"], ["z"])).toBe(0);
  });
});
