import { PRODUCT } from "../config/product";
import { READINESS_CONFIG } from "../readiness/config";

/**
 * Matching, search and ordering constants. Every value is published on /methods; values marked
 * "judgment" are product choices to revisit with the retrieval eval and persona fixtures, not
 * measured facts. Nothing here is a weight on a student-facing score: there is no such score.
 */
export const MATCHING_CONFIG = {
  search: {
    /**
     * Field boosts (plan 6.5): name and aliases 3, Organization 2, tags 1. The summary is indexed
     * at 0.5 (judgment) so topical queries ("marine biology") still reach programs whose name
     * says nothing about the topic, without letting long summaries outrank a name hit.
     */
    boosts: { name: 3, aliases: 3, organizationName: 2, tags: 1, summary: 0.5 },
    /** Edit distance as a share of term length (MiniSearch rounds it), only for terms this long. */
    fuzzy: 0.2,
    minFuzzyTermLength: 4,
    /** Prefix matching for partially typed words; shorter terms would match half the catalogue. */
    minPrefixTermLength: 3,
    /** BM25+ parameters: MiniSearch 7.2.0 defaults, restated so a library upgrade cannot move them. */
    bm25: { k: 1.2, b: 0.7, d: 0.5 },
    defaultLimit: 10,
    maxLimit: 100,
    maxMatchedTerms: 10,
  },
  fusion: {
    /**
     * Reciprocal Rank Fusion constant k = 60, the value Cormack, Clarke and Buettcher (SIGIR 2009)
     * fixed in their experiments and found robust. RRF(d) = sum over legs of 1 / (k + rank). A
     * large k flattens the curve, so a document two legs both rank 10th (2/70 = 0.0286) beats one
     * a single leg ranks 1st (1/61 = 0.0164): agreement between legs wins over one leg's opinion.
     */
    rrfK: 60,
    /**
     * Each leg is cut to its top 50 before fusion so long tails add no noise. Lexical hits past
     * the cut follow the fused list in lexical order, so paging never loses a lexical result.
     */
    depth: 50,
  },
  dense: {
    /**
     * Phase 3 embeddings leg (plan 6.5, s08 D11). Program vectors are computed offline by the
     * pipeline (pipeline/novus_pipeline/embeddings, through novus_llm) from public program text
     * only, and shipped with the release; query vectors come from a Worker route only for short,
     * screened, non-sensitive queries and only when a key exists. With no key, no vectors or a
     * failed gate, search is lexical only and behaves exactly as before.
     *
     * Model and dimensions must match between program and query vectors; the release file names
     * both, and a query vector of another length is refused. `gemini-embedding-001` supports
     * task types and Matryoshka truncation to 768 (vectors below 3072 are renormalized here).
     * Checked against the google-genai 3.1.0 SDK in pipeline/.venv on 2026-11-11; re-check the
     * Gemini embeddings page before launch. Judgment: 768 balances size (about 1 KB per program
     * as int8 base64) against quality.
     */
    models: ["gemini-embedding-001"] as readonly string[],
    defaultModel: "gemini-embedding-001",
    dims: 768,
    /** Bump when embeddingText changes; every stored vector then counts as stale. */
    textVersion: 1,
    docTask: "RETRIEVAL_DOCUMENT",
    queryTask: "RETRIEVAL_QUERY",
    /**
     * Cosine floor below which a program is not a dense hit (judgment, per model; calibrate on
     * the dev half). Without it every query would "find" the whole catalogue.
     */
    minSimilarity: { "gemini-embedding-001": 0.55 } as Readonly<Record<string, number>>,
    /** Release gate: at least this share of shipped cards must have a fresh vector (judgment). */
    minCoverage: 0.8,
    /** Query screen: only short queries are embedded (judgment). */
    minQueryChars: 3,
    maxQueryChars: 80,
    maxQueryWords: 8,
    /** The query-vector call is abandoned after this long and search stays lexical. */
    queryTimeoutMs: 800,
  },
  timing: {
    /** Bucket edges on days until start-by (plan 6.6.1). */
    startNowDays: 14,
    startSoonDays: 45,
    /** Expected cycles opening (or p10) within this many days, at medium or high confidence, join Act now. */
    openingSoonDays: 30,
    /** Campus lead-time defaults until a program has five known campus deadlines (plan 6.4.5). */
    campusL80Days: READINESS_CONFIG.campus.l80Days,
    campusL50Days: READINESS_CONFIG.campus.l50Days,
  },
  diversity: {
    /** Greedy re-rank (judgment): at most orgCap per Organization and typeCap per type in any window. */
    window: 10,
    orgCap: 2,
    typeCap: 4,
  },
  eval: {
    k: 10,
    minRecallAtK: 0.9,
    maxZeroResultRate: 0.05,
    /** 95% two-sided normal quantile for Wilson intervals. */
    z: 1.959964,
    personaTopN: 20,
    personaWindowDays: 45,
    minPersonaRecall: 0.9,
    /**
     * Hybrid gate (judgment): hybrid may not lose recall@k against lexical on the same queries,
     * and its MRR may not fall more than this below lexical's; otherwise the release ships
     * lexical only.
     */
    maxHybridMrrLoss: 0.02,
  },
  exposure: {
    /**
     * Phase 3 only (plan 6.6.2): b_fair = weight * clamp(1 - e/median e, 0, 1). In search it is
     * added to the fused RRF value as b_fair / (k + 1), i.e. at most 8% of one leg's rank-1
     * contribution: it reorders items already retrieved and never adds one.
     */
    fairWeight: 0.08,
    windowDays: 28,
  },
  notInterestedDays: PRODUCT.notInterestedDays,
  fallbackTimeZone: PRODUCT.fallbackTimeZone,
} as const;

export type MatchingConfig = typeof MATCHING_CONFIG;
