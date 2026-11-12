import type { ProgramCard } from "../../contracts/registry";
import { EMBEDDINGS_FORMAT, embeddingText, embeddingTextHash, encodeVectorInt8, queryTextHash, type ProgramEmbeddingsFile } from "../embeddings";
import type { QueryEmbedder } from "../hybrid";
import { MATCHING_CONFIG } from "../config";
import { foldText } from "../text";

/**
 * A deterministic STAND-IN for the Gemini embedding model, for tests and the fixture eval only.
 * It maps words to a few hand-written concepts ("ocean" and "coastal" both light up `marine`), so
 * the embeddings leg can be exercised with no key and no network. It is not a language model and
 * its numbers say nothing about how Gemini vectors would score: the real comparison is rerun with
 * recorded Gemini vectors (pipeline/novus_pipeline/embeddings README, "Evaluating").
 *
 * Concept lists were written from general vocabulary before the eval was run, not tuned to it.
 */
export const CONCEPT_MODEL = "fixture-concepts";

const CONCEPTS: readonly (readonly [string, readonly string[]])[] = [
  ["marine", ["ocean", "sea", "marine", "coastal", "coast", "beach", "fish", "aquatic", "reef"]],
  ["ecology", ["ecology", "environment", "nature", "fieldwork", "wildlife", "climate", "conservation", "agricultur", "outdoor"]],
  ["biology", ["biology", "bio", "life", "biotech", "genetic", "molecular", "cell"]],
  ["research", ["research", "lab", "laboratory", "scientist", "science", "experiment", "reu", "discovery"]],
  ["finance", ["bank", "finance", "financial", "market", "trading", "invest", "wall", "analyst", "stock"]],
  ["software", ["software", "coding", "code", "programming", "developer", "computing", "computer", "tech", "technology", "app"]],
  ["data", ["machine", "learning", "ai", "artificial", "intelligence", "data", "ml", "analytics", "neural", "statistic"]],
  ["engineering", ["engineering", "engineer", "physics", "mechanical", "electrical", "physical"]],
  ["law", ["law", "legal", "lawyer", "attorney", "court", "justice"]],
  ["civic", ["civic", "government", "policy", "public", "city", "community", "politic", "local"]],
  ["health", ["health", "medicine", "medical", "clinical", "doctor", "premed", "med", "hospital", "nurse", "nursing"]],
  ["language", ["language", "abroad", "foreign", "spanish", "french", "arabic", "overseas", "immersion"]],
  ["conference", ["conference", "travel", "registration", "attend", "symposium"]],
  ["money", ["scholarship", "grant", "award", "funding", "funded", "money", "stipend", "fund"]],
  ["opensource", ["open", "source", "github", "contribut", "repository"]],
  ["competition", ["hackathon", "competition", "contest", "challenge", "weekend"]],
  ["service", ["service", "volunteer", "rural", "school", "teaching", "teach", "nonprofit"]],
  ["shadowing", ["shadow", "externship", "observe"]],
  ["gig", ["micro", "short", "gig", "freelance", "remote", "assignment"]],
  ["ambassador", ["ambassador", "marketing", "represent", "promote", "brand"]],
  ["leadership", ["leadership", "leader", "cohort"]],
  ["sprint", ["winter", "sprint", "break"]],
  ["apprentice", ["apprentice", "apprenticeship", "trade", "degree"]],
  ["explore", ["exploration", "explore", "insight", "workshop", "introduc", "career", "week"]],
  ["summer", ["summer"]],
];

export const CONCEPT_DIMS = CONCEPTS.length;

function conceptsOf(text: string): Float32Array {
  const v = new Float32Array(CONCEPT_DIMS);
  const words = foldText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  for (const w of words) {
    CONCEPTS.forEach(([, triggers], dim) => {
      // Short triggers must match the whole word; longer ones also match as a prefix ("market" -> "markets").
      if (triggers.some((t) => (t.length <= 3 ? w === t : w.startsWith(t)))) v[dim] = (v[dim] as number) + 1;
    });
  }
  return v;
}

export function conceptVector(text: string): Float32Array {
  return conceptsOf(text);
}

/** The test embedder: same function for programs and queries; null when no concept fires. */
export const conceptEmbedder: QueryEmbedder = async ({ text, dims }) => {
  const v = conceptsOf(text);
  if (dims !== CONCEPT_DIMS || v.every((x) => x === 0)) return null;
  return v;
};

/** A release vectors file for cards, built with the stand-in (int8, as the pipeline writes it). */
export function conceptEmbeddingsFile(cards: readonly ProgramCard[], queries: readonly string[] = []): ProgramEmbeddingsFile {
  const programs = cards
    .map((card) => ({ id: card.programCycleId, textHash: embeddingTextHash(card), vec: conceptsOf(embeddingText(card)) }))
    .filter((p) => p.vec.some((x) => x !== 0))
    .map((p) => ({ id: p.id, textHash: p.textHash, v: encodeVectorInt8(p.vec) }));
  return {
    format: EMBEDDINGS_FORMAT,
    model: CONCEPT_MODEL,
    dims: CONCEPT_DIMS,
    textVersion: MATCHING_CONFIG.dense.textVersion,
    docTask: MATCHING_CONFIG.dense.docTask,
    queryTask: MATCHING_CONFIG.dense.queryTask,
    encoding: "int8-b64",
    generatedAt: "2026-11-11T12:00:00Z",
    sourceRelease: null,
    programs,
    queries: queries
      .map((q) => ({ textHash: queryTextHash(q), vec: conceptsOf(q) }))
      .filter((q) => q.vec.some((x) => x !== 0))
      .map((q) => ({ textHash: q.textHash, v: encodeVectorInt8(q.vec) })),
  };
}

/** Align options for the stand-in model: its own name and dimensions, and a cosine floor of 0.3. */
export const CONCEPT_ALIGN = { models: [CONCEPT_MODEL], dims: CONCEPT_DIMS, minSimilarity: 0.3 } as const;
