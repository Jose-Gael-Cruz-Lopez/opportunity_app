import type { ProgramCard } from "../contracts/registry";
import { alignEmbeddings, queryTextHash, type AlignOptions, type DenseAlignIssue, type ProgramEmbeddingsFile } from "./embeddings";
import { compareRetrieval, generateKnownItemQueries, hybridGate, type LabeledQuery, type RetrievalComparison } from "./eval";
import { hybridSearchIds } from "./hybrid";
import { buildIndex, searchIds } from "./search";

/**
 * The release step for the embeddings leg (release.build calls it; pure, no network). Given the
 * latest vectors file the pipeline uploaded and the cards a release ships, it decides whether
 * releases/{n}/embeddings.json is written. Embeddings never fail a release: any reason below
 * leaves the release lexical only, exactly as today, and is logged as a warning.
 *
 * Adoption needs evidence (S08-312: "adopted only if it beats MiniSearch on s06's retrieval
 * set"): the comparison runs only on labelled queries whose vectors the pipeline precomputed
 * (generated known-item queries plus any team-written set passed in), so no query is embedded
 * here. Hybrid ships when (1) the vectors align (allowlisted model, dimensions, text version,
 * coverage), (2) at least `minEvalQueries` labelled queries have vectors, (3) hybridGate passes
 * (no recall@10 loss, MRR within 0.02) and (4) hybrid beats lexical on recall@10 or MRR.
 */

export interface DenseReleaseOptions extends AlignOptions {
  /** Team-written labelled queries (dev/test half); generated known-item queries are always added. */
  readonly labelledQueries?: readonly LabeledQuery[];
  readonly minEvalQueries?: number;
}

export type DenseReleaseReason = DenseAlignIssue | "too_few_eval_vectors" | "hybrid_gate_failed" | "no_improvement";

export interface DenseReleaseDecision {
  readonly ship: boolean;
  /** The file to write when `ship`; restricted to this release's fresh vectors. */
  readonly file: ProgramEmbeddingsFile | null;
  readonly fresh: number;
  readonly stale: number;
  readonly missing: number;
  readonly coverage: number;
  readonly evalQueries: number;
  readonly comparison: RetrievalComparison | null;
  readonly reasons: readonly DenseReleaseReason[];
  /** Gate messages (numbers about the retrieval set, never about a student). */
  readonly gateMessages: readonly string[];
}

/** Default floor on labelled queries with vectors before a comparison counts (judgment). */
export const MIN_EVAL_QUERIES = 20;

export async function decideDenseRelease(raw: unknown, cards: readonly ProgramCard[], opts: DenseReleaseOptions = {}): Promise<DenseReleaseDecision> {
  const al = alignEmbeddings(raw, cards, opts);
  const base = { fresh: al.fresh, stale: al.stale, missing: al.missing, coverage: al.coverage };
  if (!al.index || !al.file) {
    return { ship: false, file: null, ...base, evalQueries: 0, comparison: null, reasons: al.issues, gateMessages: [] };
  }
  const dense = al.index;
  const queries = [...generateKnownItemQueries(cards), ...(opts.labelledQueries ?? [])].filter((q) => dense.queryVectors.has(queryTextHash(q.query)));
  if (queries.length < (opts.minEvalQueries ?? MIN_EVAL_QUERIES)) {
    return { ship: false, file: null, ...base, evalQueries: queries.length, comparison: null, reasons: ["too_few_eval_vectors"], gateMessages: [] };
  }
  const index = buildIndex(cards);
  // No embedder: only precomputed vectors are used, so nothing leaves the build.
  const comparison = await compareRetrieval(
    queries,
    (q, k) => searchIds(index, q, k),
    (q, k) => hybridSearchIds(index, dense, q, k, null),
  );
  const gate = hybridGate(comparison);
  const reasons: DenseReleaseReason[] = [];
  if (!gate.pass) reasons.push("hybrid_gate_failed");
  const improves = comparison.hybrid.meanRecall > comparison.lexical.meanRecall || comparison.hybrid.mrr > comparison.lexical.mrr;
  if (!improves) reasons.push("no_improvement");
  const ship = reasons.length === 0;
  return { ship, file: ship ? al.file : null, ...base, evalQueries: queries.length, comparison, reasons, gateMessages: gate.reasons };
}
