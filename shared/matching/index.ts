/**
 * shared/matching: search, order and plain-language reasons for the browser, the Worker and MCP.
 *
 * - buildIndex / search: MiniSearch BM25+ over the registry release, with filters and aliases.
 * - rankForStudent: order v0, a lexicographic comparator over published categorical keys, a
 *   weekly-rotating tie-break and a diversity pass; returns integer rank keys, why-shown codes and
 *   a facet checklist.
 * - explainWhyShown: codes to sentences.
 * - hybridSearch (Phase 3): lexical + embeddings legs fused by RRF (k = 60), lexical-only
 *   whenever there is no key, no vectors, a screened query or any failure. See README.md.
 *
 * No function here returns a fit, match or relevance number about a student. Pure: no I/O, no
 * storage, no network, and nothing here accepts SensitiveAnswers (eligibility results that already
 * include them are folded in by the browser before ordering).
 */
export { ALIAS_TABLE, ALIAS_TABLE_VERSION, aliasExpansions } from "./aliases";
export { MATCHING_CONFIG, type MatchingConfig } from "./config";
export {
  FACETS,
  FACET_STATUSES,
  facetMatches,
  isOpenToAllMajors,
  majorMatches,
  studentFamily,
  type Facet,
  type FacetExtras,
  type FacetMatch,
  type FacetStatus,
  type MatchingProfile,
  type MaterialsState,
} from "./facets";
export { fuseRankings, fuseWithLexicalTail } from "./fusion";
export {
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
  type AlignOptions,
  type DenseAlignIssue,
  type DenseAlignment,
  type DenseIndex,
  type ProgramEmbeddingsFile,
} from "./embeddings";
export {
  denseLeg,
  hybridSearch,
  hybridSearchIds,
  type DenseFallbackReason,
  type DenseLegOptions,
  type DenseLegResult,
  type HybridSearchOptions,
  type HybridSearchResponse,
  type QueryEmbedder,
} from "./hybrid";
export { screenQueryForEmbedding, type QueryScreenReason, type QueryScreenResult } from "./query-screen";
export { MIN_EVAL_QUERIES, decideDenseRelease, type DenseReleaseDecision, type DenseReleaseOptions, type DenseReleaseReason } from "./dense-release";
export {
  FIT_BANDS,
  diversify,
  fitBandFor,
  rankForStudent,
  type DiversityOptions,
  type EligibilityLike,
  type EligibilityLookup,
  type FitBand,
  type RankOptions,
  type RankedItem,
  type RankedTiming,
} from "./order";
export {
  buildIndex,
  filterCards,
  matchesFilters,
  nextDeadlineDate,
  search,
  searchIds,
  toSearchHit,
  type FilterContext,
  type ProgramSearchIndex,
  type ProgramSearchOptions,
  type ProgramSearchResult,
  type SearchFilters,
} from "./search";
export { fmix32, fnv1a32, foldText, isoWeekKey, rotationKey, shortDate } from "./text";
export {
  SECTIONS,
  TIMING_BUCKETS,
  computeTiming,
  deadlineLocalDate,
  timingContext,
  type CampusUncertainty,
  type DeadlineStep,
  type Section,
  type TimingBucketName,
  type TimingContext,
  type TimingInfo,
} from "./timing";
export { WHY_SHOWN_CODES, encodeWhyShown, explainWhyShown, whyShownText, type WhyShown, type WhyShownCode, type WhyShownLine } from "./why-shown";
export {
  compareRetrieval,
  evaluateRanker,
  generateKnownItemQueries,
  hybridGate,
  reciprocalRank,
  personaRecall,
  recallAtK,
  retrievalGate,
  runRetrievalEval,
  scriptedMisspelling,
  wilsonInterval,
  type GateResult,
  type LabeledQuery,
  type RankerReport,
  type RetrievalComparison,
  type RetrievalReport,
} from "./eval";
export { exposureFromPositions, exposureGini, fairnessBoosts, positionWeight, type ExposureInput } from "./exposure";
