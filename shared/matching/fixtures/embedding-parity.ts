import { embeddingText, embeddingTextHash, encodeVectorInt8, normalizeQueryText, queryTextHash } from "../embeddings";
import { scriptedMisspelling } from "../eval";
import { SAMPLE_CARDS } from "./sample-cards";

/**
 * Cross-language vectors for the embeddings leg: the TypeScript side (here) and the Python port
 * (pipeline/novus_pipeline/embeddings) must agree byte for byte on program text, its hash, the
 * query normalization and hash, and the int8 encoding. embedding-parity.json is this function's
 * output; embeddings.test.ts fails if they drift and the pipeline tests read the JSON.
 */
export interface ParityFixture {
  readonly programs: readonly { readonly card: Record<string, unknown>; readonly text: string; readonly textHash: string }[];
  readonly queries: readonly { readonly query: string; readonly normalized: string; readonly textHash: string }[];
  readonly vectors: readonly { readonly values: readonly number[]; readonly b64: string }[];
  readonly misspellings: readonly { readonly text: string; readonly typo: string | null }[];
}

const EXTRA_CARD = {
  name: "  Ｅxample Café   Fellowship ",
  aliases: ["", "  ECF  ", "Café Fellows"],
  organizationName: "Example  Org\tName",
  opportunityTypes: ["undergraduate_fellowship", "summer_internship"],
  majorFamilies: [],
  interestTags: ["data-science", "public_policy"],
  summary: "  Line one.\n\nLine   two ﬁne. ",
};

export function buildParityFixture(): ParityFixture {
  const cards = [...SAMPLE_CARDS.slice(0, 6), ...SAMPLE_CARDS.filter((c) => c.summary === null).slice(0, 1)];
  const programs = [
    ...cards.map((c) => ({
      card: { name: c.name, aliases: c.aliases, organizationName: c.organizationName, opportunityTypes: c.opportunityTypes, majorFamilies: c.majorFamilies, interestTags: c.interestTags, summary: c.summary },
      text: embeddingText(c),
      textHash: embeddingTextHash(c),
    })),
    { card: EXTRA_CARD, text: embeddingText(EXTRA_CARD as never), textHash: embeddingTextHash(EXTRA_CARD as never) },
  ];
  const queries = ["Ocean  Science Summer", "  ＲＥＵ\tbiology ", "Café fellowship"].map((query) => ({ query, normalized: normalizeQueryText(query), textHash: queryTextHash(query) }));
  const raw: number[][] = [
    [0.5, -0.25, 0, 1, -1],
    [0.0039370078740157, -0.0039370078740157, 0.5, 0.25],
    [0, 0, 0],
    [1e-9, 2e-9, -3e-9, 4e-9],
    [0.1, 0.2, 0.30000000000000004, -0.7, 0.05, 0.6],
  ];
  const typoInputs = [...SAMPLE_CARDS.map((c) => c.name), "Goldwater Scholarship", "AI", "Rhythm", "Strengths  Finder", "aeiouaeiou"];
  return {
    programs,
    queries,
    vectors: raw.map((values) => ({ values, b64: encodeVectorInt8(values) })),
    misspellings: typoInputs.map((text) => ({ text, typo: scriptedMisspelling(text) })),
  };
}
