import type { ProgramCard } from "../contracts/registry";
import { addDays, compareIsoDates } from "../time";
import { MATCHING_CONFIG } from "./config";
import type { RankedItem } from "./order";
import { searchIds, type ProgramSearchIndex } from "./search";
import { tokenize } from "./text";

/**
 * Offline evaluation: the retrieval eval that gates each release (plan 6.5, S06-055) and
 * persona surfacing for order v0 (plan 6.11). Pure functions over ids; no query text is stored.
 */

export interface LabeledQuery {
  readonly id: string;
  readonly query: string;
  /** programCycleIds that should be found. */
  readonly relevant: readonly string[];
  /** Generated known-item, team-written provisional, or real (dev/test half). */
  readonly source: "generated" | "provisional" | "dev" | "test";
}

/** Wilson score interval for a binomial proportion (two-sided, z = 1.96 by default). */
export function wilsonInterval(successes: number, n: number, z: number = MATCHING_CONFIG.eval.z): { readonly lower: number; readonly upper: number } {
  if (n <= 0) return { lower: 0, upper: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lower: Math.max(0, (centre - half) / denom), upper: Math.min(1, (centre + half) / denom) };
}

/** recall@k = |R ∩ top k| / min(k, |R|); 1 when nothing is relevant (vacuous). */
export function recallAtK(ranked: readonly string[], relevant: readonly string[], k: number): number {
  if (relevant.length === 0) return 1;
  const top = new Set(ranked.slice(0, k));
  const hits = relevant.filter((id) => top.has(id)).length;
  return hits / Math.min(k, relevant.length);
}

export interface RetrievalReport {
  readonly n: number;
  readonly k: number;
  /** Mean per-query recall@k. */
  readonly meanRecall: number;
  /** Queries with full recall@k (the binomial count the Wilson interval is computed on). */
  readonly fullRecallCount: number;
  readonly recallInterval: { readonly lower: number; readonly upper: number };
  readonly zeroResultCount: number;
  readonly zeroResultRate: number;
  /** Ids of queries that missed, for alias work on the dev half only. */
  readonly missedQueryIds: readonly string[];
}

/** Runs labelled queries against an index and reports recall@k, its Wilson interval and zero results. */
export function runRetrievalEval(index: ProgramSearchIndex, queries: readonly LabeledQuery[], k: number = MATCHING_CONFIG.eval.k): RetrievalReport {
  let recallSum = 0;
  let full = 0;
  let zero = 0;
  const missed: string[] = [];
  for (const q of queries) {
    const ids = searchIds(index, q.query, k);
    if (ids.length === 0) zero += 1;
    const r = recallAtK(ids, q.relevant, k);
    recallSum += r;
    if (r >= 1) full += 1;
    else missed.push(q.id);
  }
  const n = queries.length;
  return {
    n,
    k,
    meanRecall: n ? recallSum / n : 1,
    fullRecallCount: full,
    recallInterval: wilsonInterval(full, n),
    zeroResultCount: zero,
    zeroResultRate: n ? zero / n : 0,
    missedQueryIds: missed,
  };
}

export interface GateResult {
  readonly pass: boolean;
  readonly reasons: readonly string[];
}

/** The release gate: recall@10 at least 0.9 and at most 5% zero-result queries. */
export function retrievalGate(
  report: RetrievalReport,
  minRecall: number = MATCHING_CONFIG.eval.minRecallAtK,
  maxZeroRate: number = MATCHING_CONFIG.eval.maxZeroResultRate,
): GateResult {
  const reasons: string[] = [];
  if (report.meanRecall < minRecall) reasons.push(`recall@${report.k} ${report.meanRecall.toFixed(3)} is below ${minRecall}`);
  if (report.zeroResultRate > maxZeroRate) reasons.push(`zero-result rate ${report.zeroResultRate.toFixed(3)} is above ${maxZeroRate}`);
  return { pass: reasons.length === 0, reasons };
}

/**
 * A scripted misspelling: doubles one consonant in the longest word ("goldwater" -> "goldwatter"
 * style). Deterministic, so the generated set is stable across runs.
 */
export function scriptedMisspelling(text: string): string | null {
  const words = text.split(/\s+/);
  let longest = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (/^[A-Za-z]{6,}$/.test(w) && (longest < 0 || w.length > (words[longest] as string).length)) longest = i;
  }
  if (longest < 0) return null;
  const word = words[longest] as string;
  for (let i = Math.floor(word.length * 0.6); i < word.length; i++) {
    if (/[bcdfghjklmnpqrstvwxz]/i.test(word[i] as string)) {
      words[longest] = word.slice(0, i + 1) + word[i] + word.slice(i + 1);
      return words.join(" ");
    }
  }
  return null;
}

/** Known-item queries from names, aliases and scripted misspellings (plan 6.5). */
export function generateKnownItemQueries(cards: readonly ProgramCard[]): LabeledQuery[] {
  const out: LabeledQuery[] = [];
  for (const card of cards) {
    const relevant = [card.programCycleId];
    out.push({ id: `name:${card.slug}`, query: card.name, relevant, source: "generated" });
    card.aliases.forEach((alias, i) => {
      if (tokenize(alias).length > 0) out.push({ id: `alias:${card.slug}:${i}`, query: alias, relevant, source: "generated" });
    });
    const typo = scriptedMisspelling(card.name);
    if (typo) out.push({ id: `typo:${card.slug}`, query: typo, relevant, source: "generated" });
  }
  return out;
}

/**
 * Persona surfacing (plan 6.11): recall = |R ∩ top N| / min(N, |R|), where R is the persona's
 * eligible or conditional Act-now items whose start-by (or deadline when prepDays is unknown)
 * falls within `windowDays` of `today`. |R| is returned too, because a fixed share of R cannot
 * fit in N slots once R grows past N.
 */
export function personaRecall(
  ranked: readonly RankedItem[],
  today: string,
  topN: number = MATCHING_CONFIG.eval.personaTopN,
  windowDays: number = MATCHING_CONFIG.eval.personaWindowDays,
): { readonly recall: number; readonly relevantCount: number } {
  const horizon = addDays(today, windowDays);
  const relevant = ranked.filter((item) => {
    if (item.eligibility !== "eligible" && item.eligibility !== "conditional") return false;
    if (item.section !== "act_now") return false;
    const date = item.timing.startBy ?? item.timing.effectiveDate;
    return date !== null && compareIsoDates(date, horizon) <= 0;
  });
  const top = new Set(ranked.slice(0, topN).map((i) => i.programCycleId));
  const hits = relevant.filter((i) => top.has(i.programCycleId)).length;
  return { recall: relevant.length ? hits / Math.min(topN, relevant.length) : 1, relevantCount: relevant.length };
}

// ---------------------------------------------------------------------------------------------
// Lexical vs hybrid comparison (Phase 3): recall@k and MRR on the same labelled queries
// ---------------------------------------------------------------------------------------------

/** Reciprocal rank of the first relevant id (1-based); 0 when none is in the list. */
export function reciprocalRank(ranked: readonly string[], relevant: readonly string[]): number {
  const want = new Set(relevant);
  const i = ranked.findIndex((id) => want.has(id));
  return i < 0 ? 0 : 1 / (i + 1);
}

export interface RankerReport {
  readonly n: number;
  readonly k: number;
  readonly meanRecall: number;
  /** Mean reciprocal rank over the top k (a first hit below k counts 0). */
  readonly mrr: number;
  readonly fullRecallCount: number;
  readonly recallInterval: { readonly lower: number; readonly upper: number };
  readonly zeroResultCount: number;
  readonly missedQueryIds: readonly string[];
}

/** Runs any ranker (lexical, hybrid) over labelled queries. Pure apart from the ranker itself. */
export async function evaluateRanker(
  queries: readonly LabeledQuery[],
  rank: (query: string, k: number) => readonly string[] | Promise<readonly string[]>,
  k: number = MATCHING_CONFIG.eval.k,
): Promise<RankerReport> {
  let recallSum = 0;
  let rrSum = 0;
  let full = 0;
  let zero = 0;
  const missed: string[] = [];
  for (const q of queries) {
    const ids = (await rank(q.query, k)).slice(0, k);
    if (ids.length === 0) zero += 1;
    const r = recallAtK(ids, q.relevant, k);
    recallSum += r;
    rrSum += reciprocalRank(ids, q.relevant);
    if (r >= 1) full += 1;
    else missed.push(q.id);
  }
  const n = queries.length;
  return {
    n,
    k,
    meanRecall: n ? recallSum / n : 1,
    mrr: n ? rrSum / n : 1,
    fullRecallCount: full,
    recallInterval: wilsonInterval(full, n),
    zeroResultCount: zero,
    missedQueryIds: missed,
  };
}

export interface RetrievalComparison {
  readonly lexical: RankerReport;
  readonly hybrid: RankerReport;
  /** Query ids where hybrid recall@k is higher / lower than lexical. */
  readonly hybridWins: readonly string[];
  readonly hybridLosses: readonly string[];
}

/** Lexical and hybrid on the same queries, with per-query wins and losses on recall@k. */
export async function compareRetrieval(
  queries: readonly LabeledQuery[],
  lexical: (query: string, k: number) => readonly string[] | Promise<readonly string[]>,
  hybrid: (query: string, k: number) => readonly string[] | Promise<readonly string[]>,
  k: number = MATCHING_CONFIG.eval.k,
): Promise<RetrievalComparison> {
  const wins: string[] = [];
  const losses: string[] = [];
  for (const q of queries) {
    const a = recallAtK((await lexical(q.query, k)).slice(0, k), q.relevant, k);
    const b = recallAtK((await hybrid(q.query, k)).slice(0, k), q.relevant, k);
    if (b > a) wins.push(q.id);
    else if (b < a) losses.push(q.id);
  }
  return { lexical: await evaluateRanker(queries, lexical, k), hybrid: await evaluateRanker(queries, hybrid, k), hybridWins: wins, hybridLosses: losses };
}

/**
 * The hybrid gate: hybrid ships only if it loses no recall@k against lexical and its MRR is at
 * most `maxMrrLoss` below lexical's, on the same queries. A failure keeps the release lexical.
 */
export function hybridGate(cmp: RetrievalComparison, maxMrrLoss: number = MATCHING_CONFIG.eval.maxHybridMrrLoss): GateResult {
  const reasons: string[] = [];
  if (cmp.hybrid.meanRecall < cmp.lexical.meanRecall) {
    reasons.push(`hybrid recall@${cmp.hybrid.k} ${cmp.hybrid.meanRecall.toFixed(3)} is below lexical ${cmp.lexical.meanRecall.toFixed(3)}`);
  }
  if (cmp.hybrid.mrr < cmp.lexical.mrr - maxMrrLoss) reasons.push(`hybrid MRR ${cmp.hybrid.mrr.toFixed(3)} is more than ${maxMrrLoss} below lexical ${cmp.lexical.mrr.toFixed(3)}`);
  return { pass: reasons.length === 0, reasons };
}
