import { MATCHING_CONFIG } from "./config";

/**
 * Reciprocal Rank Fusion (Cormack, Clarke and Buettcher, SIGIR 2009) for the Phase 3 hybrid
 * search: RRF(d) = sum over rankers of 1 / (k + rank_r(d)), with 1-based ranks over each
 * ranker's top `depth` and k = 60 (MATCHING_CONFIG.fusion.rrfK, where the choice is explained).
 * It needs ranks only, so BM25 and cosine scales never need calibrating.
 *
 * Optional exposure boosts (plan 6.6.2, b_fair in [0, fairWeight]) add b_fair / (k + 1) to an id
 * that is already in the fused set: at most 8% of one leg's rank-1 contribution. A boost never
 * adds an id, and at k = 60 it can never lift a single-leg hit above one both legs rank in their
 * top 10 (1/61 + 0.08/61 = 0.0177 < 2/70 = 0.0286).
 *
 * Only ids leave this function, best first. The fused values order one query's results and are
 * never stored, returned or shown: users read any number beside a card as a judgment of them.
 */
export function fuseRankings(
  rankings: readonly (readonly string[])[],
  k: number = MATCHING_CONFIG.fusion.rrfK,
  depth: number = MATCHING_CONFIG.fusion.depth,
  boosts?: ReadonlyMap<string, number>,
): string[] {
  const fused = new Map<string, number>();
  const firstSeen = new Map<string, number>();
  let order = 0;
  for (const ranking of rankings) {
    const seen = new Set<string>();
    let rank = 0;
    for (const id of ranking) {
      if (seen.has(id)) continue; // a ranker lists each id once; ignore accidental repeats
      seen.add(id);
      rank += 1;
      if (rank > depth) break;
      fused.set(id, (fused.get(id) ?? 0) + 1 / (k + rank));
      if (!firstSeen.has(id)) firstSeen.set(id, order++);
    }
  }
  if (boosts && boosts.size > 0) {
    const cap = MATCHING_CONFIG.exposure.fairWeight;
    for (const [id, value] of fused) {
      const b = boosts.get(id);
      // Clamp: a boost is never negative (no penalty through this door) and never above the weight.
      if (b !== undefined && Number.isFinite(b) && b > 0) fused.set(id, value + Math.min(b, cap) / (k + 1));
    }
  }
  // Ties (equal fused value) keep first-seen order, so the lexical leg wins ties when listed first.
  return [...fused.keys()].sort((a, b) => (fused.get(b) as number) - (fused.get(a) as number) || (firstSeen.get(a) as number) - (firstSeen.get(b) as number));
}

/**
 * The hybrid order: the RRF fusion of each leg's top `depth`, then every lexical id past the cut
 * in lexical order, so `offset` paging never loses a result the lexical leg found. Dense-only
 * ids past the cut are dropped: they matched nothing the student typed.
 */
export function fuseWithLexicalTail(
  lexical: readonly string[],
  dense: readonly string[],
  boosts?: ReadonlyMap<string, number>,
  k: number = MATCHING_CONFIG.fusion.rrfK,
  depth: number = MATCHING_CONFIG.fusion.depth,
): string[] {
  const legs = dense.length > 0 ? [lexical, dense] : [lexical];
  const head = fuseRankings(legs, k, depth, boosts);
  const inHead = new Set(head);
  return [...head, ...lexical.filter((id) => !inHead.has(id))];
}
