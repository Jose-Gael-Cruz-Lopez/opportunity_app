import { describe, expect, it } from "vitest";
import { decideDenseRelease } from "./dense-release";
import { ProgramEmbeddingsFileSchema } from "./embeddings";
import { generateKnownItemQueries } from "./eval";
import { CONCEPT_ALIGN, conceptEmbeddingsFile } from "./fixtures/concept-embedder";
import { PARAPHRASE_QUERIES } from "./fixtures/hybrid-queries";
import { SAMPLE_CARDS } from "./fixtures/sample-cards";

const known = generateKnownItemQueries(SAMPLE_CARDS).map((q) => q.query);
const paraphrase = PARAPHRASE_QUERIES.map((q) => q.query);

describe("decideDenseRelease", () => {
  it("ships when vectors align, enough labelled queries have vectors, the gate passes and hybrid improves", async () => {
    const raw = conceptEmbeddingsFile(SAMPLE_CARDS, [...known, ...paraphrase]);
    const d = await decideDenseRelease(raw, SAMPLE_CARDS, { ...CONCEPT_ALIGN, labelledQueries: PARAPHRASE_QUERIES });
    expect(d.reasons).toEqual([]);
    expect(d.ship).toBe(true);
    expect(d.evalQueries).toBeGreaterThanOrEqual(20);
    expect(d.comparison!.hybrid.mrr).toBeGreaterThan(d.comparison!.lexical.mrr);
    expect(ProgramEmbeddingsFileSchema.parse(d.file)).toBeTruthy();
  });

  it("stays lexical when only known-item queries exist (nothing to improve on)", async () => {
    const d = await decideDenseRelease(conceptEmbeddingsFile(SAMPLE_CARDS, known), SAMPLE_CARDS, CONCEPT_ALIGN);
    expect(d.ship).toBe(false);
    expect(d.reasons).toContain("no_improvement");
    expect(d.file).toBeNull();
  });

  it("stays lexical with too few labelled query vectors", async () => {
    const d = await decideDenseRelease(conceptEmbeddingsFile(SAMPLE_CARDS, paraphrase.slice(0, 3)), SAMPLE_CARDS, { ...CONCEPT_ALIGN, labelledQueries: PARAPHRASE_QUERIES });
    expect(d).toMatchObject({ ship: false, reasons: ["too_few_eval_vectors"], comparison: null });
  });

  it("stays lexical on an unusable file and reports why", async () => {
    expect((await decideDenseRelease({ nope: true }, SAMPLE_CARDS)).reasons).toEqual(["unknown_format"]);
    expect((await decideDenseRelease(conceptEmbeddingsFile(SAMPLE_CARDS), SAMPLE_CARDS)).reasons).toEqual(["model_not_allowlisted", "dims_mismatch"]);
  });

  it("stays lexical when hybrid would bury known items", async () => {
    // Every known-item query gets the same vector, pointing at one program: the dense leg then
    // pushes that program above the named one, so MRR drops and the gate fails.
    const raw = conceptEmbeddingsFile(SAMPLE_CARDS, [...known, ...paraphrase]);
    const v = raw.queries[0]!.v;
    const poisoned = { ...raw, queries: raw.queries.map((q) => ({ ...q, v })) };
    const d = await decideDenseRelease(poisoned, SAMPLE_CARDS, { ...CONCEPT_ALIGN, labelledQueries: PARAPHRASE_QUERIES });
    expect(d.ship).toBe(false);
    expect(d.reasons).toContain("hybrid_gate_failed");
    expect(d.gateMessages.length).toBeGreaterThan(0);
  });
});
