import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../eligibility/hash";
import { MATCHING_CONFIG } from "./config";
import {
  EMBEDDINGS_FORMAT,
  ProgramEmbeddingsFileSchema,
  alignEmbeddings,
  decodeVectorInt8,
  denseRanking,
  embeddingText,
  embeddingTextHash,
  encodeVectorInt8,
  normalizeQueryText,
  queryTextHash,
  unitVector,
  type ProgramEmbeddingsFile,
} from "./embeddings";
import { CONCEPT_ALIGN, CONCEPT_DIMS, conceptEmbeddingsFile, conceptVector } from "./fixtures/concept-embedder";
import { buildParityFixture } from "./fixtures/embedding-parity";
import { SAMPLE_CARDS, sampleCardBySlug } from "./fixtures/sample-cards";

const coastal = sampleCardBySlug("coastal-ecology-reu");

describe("embeddingText", () => {
  it("lays out raw card fields in a fixed order", () => {
    expect(embeddingText(coastal)).toBe(
      [
        "Coastal Ecology REU Site",
        "Also known as: Coastal REU",
        "Organization: Example Marine Lab",
        "Type: research program",
        "Fields: life sciences; agriculture environment",
        "Topics: life sciences",
        "Ten-week summer research in marine biology and coastal field ecology with a faculty mentor.",
      ].join("\n"),
    );
  });

  it("omits empty lines and normalizes whitespace and compatibility forms", () => {
    const text = embeddingText({ name: " Ｘ Lab ", aliases: ["", " "], organizationName: "Org", opportunityTypes: [], majorFamilies: [], interestTags: [], summary: null });
    expect(text).toBe("X Lab\nOrganization: Org");
  });

  it("hashes text with a version tag, so a summary edit or a version bump changes the hash", () => {
    const h = embeddingTextHash(coastal);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(sha256Hex(`novus-embed-program-v${MATCHING_CONFIG.dense.textVersion}\n${embeddingText(coastal)}`));
    expect(embeddingTextHash({ ...coastal, summary: "Edited." })).not.toBe(h);
    expect(embeddingTextHash(coastal, 2)).not.toBe(h);
    // Fields that are not embedded (deadlines, flags) do not change it.
    expect(embeddingTextHash({ ...coastal, deadlines: [] })).toBe(h);
  });

  it("normalizes queries before hashing", () => {
    expect(normalizeQueryText("  Ocean\tSCIENCE  ")).toBe("ocean science");
    expect(queryTextHash("Ocean science")).toBe(queryTextHash(" ocean   SCIENCE "));
    expect(queryTextHash("ocean")).not.toBe(embeddingTextHash({ ...coastal, name: "ocean" }));
  });
});

describe("int8 codec", () => {
  it("round-trips direction (cosine about 1)", () => {
    const v = Array.from({ length: 768 }, (_, i) => Math.sin(i * 1.7) * (i % 7 === 0 ? 3 : 1));
    const back = decodeVectorInt8(encodeVectorInt8(v), 768) as Float32Array;
    const unit = unitVector(v, 768) as Float32Array;
    let dot = 0;
    for (let i = 0; i < 768; i++) dot += (back[i] as number) * (unit[i] as number);
    expect(dot).toBeGreaterThan(0.999);
  });

  it("rejects a wrong length, bad base64 and all-zero vectors", () => {
    expect(decodeVectorInt8(encodeVectorInt8([1, 2, 3]), 4)).toBeNull();
    expect(decodeVectorInt8("!!!!", 3)).toBeNull();
    expect(decodeVectorInt8(encodeVectorInt8([0, 0, 0]), 3)).toBeNull();
    expect(unitVector([1, Number.NaN], 2)).toBeNull();
    expect(unitVector([1, 2], 3)).toBeNull();
  });

  it("encodes negatives as two's complement, rounding half away from zero", () => {
    expect(encodeVectorInt8([1, -1])).toBe("f4E="); // 127, -127
    expect(encodeVectorInt8([254, -1, 1])).toBe(encodeVectorInt8([127, -0.5, 0.5]));
  });
});

describe("cross-language parity fixture", () => {
  it("matches what the TypeScript side computes today", () => {
    const onDisk = JSON.parse(readFileSync(new URL("./fixtures/embedding-parity.json", import.meta.url), "utf8")) as unknown;
    expect(onDisk).toEqual(JSON.parse(JSON.stringify(buildParityFixture())));
  });
});

function file(overrides: Partial<ProgramEmbeddingsFile> = {}): ProgramEmbeddingsFile {
  return { ...conceptEmbeddingsFile(SAMPLE_CARDS), ...overrides };
}

describe("alignEmbeddings", () => {
  it("keeps every fresh vector and builds a unit-row matrix", () => {
    const al = alignEmbeddings(file(), SAMPLE_CARDS, CONCEPT_ALIGN);
    expect(al.issues).toEqual([]);
    expect(al.index).not.toBeNull();
    expect(al.fresh).toBe(al.index?.ids.length);
    expect(al.coverage).toBeGreaterThanOrEqual(MATCHING_CONFIG.dense.minCoverage);
    const m = al.index?.matrix as Float32Array;
    let norm = 0;
    for (let i = 0; i < CONCEPT_DIMS; i++) norm += (m[i] as number) ** 2;
    expect(norm).toBeCloseTo(1, 5);
    expect(ProgramEmbeddingsFileSchema.parse(al.file)).toBeTruthy();
  });

  it("drops a vector whose program text changed since it was embedded", () => {
    const edited = SAMPLE_CARDS.map((c) => (c.slug === "coastal-ecology-reu" ? { ...c, summary: "Now about deep-space radio astronomy." } : c));
    const al = alignEmbeddings(file(), edited, CONCEPT_ALIGN);
    expect(al.stale).toBe(1);
    expect(al.index?.ids).not.toContain(coastal.programCycleId);
    expect(al.file?.programs.some((p) => p.id === coastal.programCycleId)).toBe(false);
  });

  it("counts cards never embedded and ignores vectors of cards the release does not ship", () => {
    const extra = { id: "not-shipped", textHash: "0".repeat(64), v: encodeVectorInt8(conceptVector("ocean")) };
    const f = file({ programs: [...file().programs.slice(1), extra] });
    const al = alignEmbeddings(f, SAMPLE_CARDS, CONCEPT_ALIGN);
    expect(al.missing).toBeGreaterThanOrEqual(1);
    expect(al.index?.ids).not.toContain("not-shipped");
  });

  it("turns the leg off for low coverage, an unlisted model, other dimensions, another text version or a bad file", () => {
    expect(alignEmbeddings(file({ programs: file().programs.slice(0, 3) }), SAMPLE_CARDS, CONCEPT_ALIGN)).toMatchObject({ index: null, issues: ["low_coverage"] });
    expect(alignEmbeddings(file(), SAMPLE_CARDS).issues).toEqual(["model_not_allowlisted", "dims_mismatch"]);
    expect(alignEmbeddings(file({ textVersion: 99 }), SAMPLE_CARDS, CONCEPT_ALIGN).issues).toEqual(["text_version_mismatch"]);
    expect(alignEmbeddings({ format: "other" }, SAMPLE_CARDS).issues).toEqual(["unknown_format"]);
    expect(alignEmbeddings(null, SAMPLE_CARDS).index).toBeNull();
    expect(alignEmbeddings(file({ format: EMBEDDINGS_FORMAT, encoding: "f32" as never }), SAMPLE_CARDS, CONCEPT_ALIGN).index).toBeNull();
  });

  it("loads precomputed eval-query vectors by query hash", () => {
    const al = alignEmbeddings(conceptEmbeddingsFile(SAMPLE_CARDS, ["Ocean science summer"]), SAMPLE_CARDS, CONCEPT_ALIGN);
    expect(al.index?.queryVectors.has(queryTextHash("ocean science summer"))).toBe(true);
  });
});

describe("denseRanking", () => {
  const index = alignEmbeddings(file(), SAMPLE_CARDS, CONCEPT_ALIGN).index!;
  const q = unitVector(conceptVector("ocean wildlife"), CONCEPT_DIMS)!;

  it("ranks by cosine and applies the floor", () => {
    const ids = denseRanking(index, q);
    expect(ids[0]).toBe(coastal.programCycleId);
    expect(ids.length).toBeLessThan(index.ids.length);
  });

  it("respects depth and keep, and refuses a vector of another length", () => {
    expect(denseRanking({ ...index, minSimilarity: -1 }, q, 3)).toHaveLength(3);
    expect(denseRanking(index, q, 50, (id) => id !== coastal.programCycleId)).not.toContain(coastal.programCycleId);
    expect(denseRanking(index, new Float32Array(3))).toEqual([]);
  });

  it("breaks cosine ties by id, deterministically", () => {
    const flat = { ...index, minSimilarity: -1 };
    const zeroish = unitVector(Array.from({ length: CONCEPT_DIMS }, (_, i) => (i === CONCEPT_DIMS - 1 ? 1 : 0)), CONCEPT_DIMS)!;
    const a = denseRanking(flat, zeroish);
    expect(a).toEqual(denseRanking(flat, zeroish));
  });
});
