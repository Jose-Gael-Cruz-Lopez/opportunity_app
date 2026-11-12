import { MATCHING_CONFIG } from "./config";
import { denseRanking, queryTextHash, unitVector, type DenseIndex } from "./embeddings";
import { screenQueryForEmbedding, type QueryScreenReason } from "./query-screen";
import { matchesFilters, search, type FilterContext, type ProgramSearchIndex, type ProgramSearchOptions, type ProgramSearchResult } from "./search";

/**
 * Phase 3 hybrid retrieval (plan 6.5): MiniSearch stays the lexical leg; the embeddings leg ranks
 * programs by cosine similarity to a query vector; the two are fused with Reciprocal Rank Fusion
 * (k = 60, fusion.ts). Reasons stay transparent: lexical hits keep their field codes and a
 * program only the embeddings leg found says MEANING_MATCH. The exposure boost passes through.
 *
 * Every failure path is lexical-only search, identical to `search()` without a dense ranking:
 * no index, no embedder (no key, AI off, viewer not cleared by the AI access gate), a screened
 * query, a timeout, an error or a vector of the wrong length. The status and reason returned are
 * categorical and safe to count; the query and its vector are never returned, logged or stored.
 */

/**
 * Embeds one query. Implemented in server/ai (the only Worker code allowed to call Gemini) and
 * injected here; returns null when unavailable. The model, dimensions and task type come from the
 * release's vectors file so both sides of the cosine match.
 */
export type QueryEmbedder = (request: {
  readonly text: string;
  readonly model: string;
  readonly dims: number;
  readonly taskType: string;
}) => Promise<ArrayLike<number> | null>;

export type DenseFallbackReason = "no_index" | "no_embedder" | QueryScreenReason | "timeout" | "error" | "bad_vector" | "no_dense_hits";

export type DenseLegResult =
  | { readonly status: "used"; readonly ranking: readonly string[]; readonly source: "precomputed" | "embedder" }
  | { readonly status: "lexical_only"; readonly reason: DenseFallbackReason };

export interface DenseLegOptions {
  readonly embed?: QueryEmbedder | null;
  readonly keep?: (id: string) => boolean;
  readonly timeoutMs?: number;
  readonly depth?: number;
}

const TIMEOUT = Symbol("timeout");

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A call that fails after the timeout already won must not become an unhandled rejection.
  work.catch(() => undefined);
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The embeddings leg for one query. A precomputed vector (labelled eval queries shipped in the
 * release file) is used without any network call; otherwise the screened query goes to `embed`.
 */
export async function denseLeg(dense: DenseIndex | null | undefined, query: string, opts: DenseLegOptions = {}): Promise<DenseLegResult> {
  if (!dense || dense.ids.length === 0) return { status: "lexical_only", reason: "no_index" };
  const screen = screenQueryForEmbedding(query);
  if (!screen.ok) return { status: "lexical_only", reason: screen.reason };
  const depth = opts.depth ?? MATCHING_CONFIG.fusion.depth;

  const finish = (vec: Float32Array, source: "precomputed" | "embedder"): DenseLegResult => {
    const ranking = denseRanking(dense, vec, depth, opts.keep);
    return ranking.length ? { status: "used", ranking, source } : { status: "lexical_only", reason: "no_dense_hits" };
  };

  const cached = dense.queryVectors.get(queryTextHash(screen.text));
  if (cached) return finish(cached, "precomputed");
  if (!opts.embed) return { status: "lexical_only", reason: "no_embedder" };

  let raw: ArrayLike<number> | null | typeof TIMEOUT;
  try {
    raw = await withTimeout(opts.embed({ text: screen.text, model: dense.model, dims: dense.dims, taskType: dense.queryTask }), opts.timeoutMs ?? MATCHING_CONFIG.dense.queryTimeoutMs);
  } catch {
    return { status: "lexical_only", reason: "error" };
  }
  if (raw === TIMEOUT) return { status: "lexical_only", reason: "timeout" };
  if (raw === null) return { status: "lexical_only", reason: "no_embedder" };
  const vec = unitVector(raw, dense.dims);
  if (!vec) return { status: "lexical_only", reason: "bad_vector" };
  return finish(vec, "embedder");
}

export interface HybridSearchOptions extends Omit<ProgramSearchOptions, "denseRanking"> {
  readonly dense?: DenseIndex | null;
  readonly embed?: QueryEmbedder | null;
  readonly timeoutMs?: number;
}

export interface HybridSearchResponse {
  readonly results: ProgramSearchResult[];
  /** "hybrid" when the embeddings leg took part, else "lexical"; safe to count, never a score. */
  readonly mode: "hybrid" | "lexical";
  readonly reason: DenseFallbackReason | null;
}

/**
 * Lexical + embeddings search, fused with RRF. Filters apply to both legs before fusion, so a
 * filtered-out program can never enter through the embeddings leg.
 */
export async function hybridSearch(index: ProgramSearchIndex, query: string, opts: HybridSearchOptions = {}): Promise<HybridSearchResponse> {
  const { dense, embed, timeoutMs, ...searchOpts } = opts;
  if (!query.trim()) return { results: [], mode: "lexical", reason: null };
  const filters = searchOpts.filters ?? {};
  const ctx: FilterContext = { now: searchOpts.now ?? Date.now(), timeZone: searchOpts.timeZone ?? null };
  const keep = (id: string): boolean => {
    const card = index.cards.get(id);
    return card !== undefined && matchesFilters(card, filters, ctx);
  };
  const leg = await denseLeg(dense, query, { embed, keep, timeoutMs });
  if (leg.status === "used") {
    return { results: search(index, query, { ...searchOpts, now: ctx.now, denseRanking: leg.ranking }), mode: "hybrid", reason: null };
  }
  return { results: search(index, query, { ...searchOpts, now: ctx.now }), mode: "lexical", reason: leg.reason };
}

/** Ids only, for the hybrid retrieval eval (no network: precomputed vectors or a test embedder). */
export async function hybridSearchIds(index: ProgramSearchIndex, dense: DenseIndex | null, query: string, k: number, embed?: QueryEmbedder | null): Promise<string[]> {
  const res = await hybridSearch(index, query, { dense, embed, limit: Math.min(k, MATCHING_CONFIG.search.maxLimit) });
  return res.results.map((r) => r.card.programCycleId);
}
