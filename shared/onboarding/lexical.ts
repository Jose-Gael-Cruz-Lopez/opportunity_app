import MiniSearch from "minisearch";
import { normalizeForMatch } from "./text";

/**
 * Lexical retrieval with MiniSearch 7.2.0 (MIT): BM25+ with its default parameters
 * (k = 1.2, b = 0.7, d = 0.5) and plan 06's field boosts (name and aliases 3, organization 2,
 * tags and skills 2, description 1). The index is built from public program text on the device
 * or in the Worker, so the student's query never leaves where it runs.
 *
 * Two deliberate changes from a plain setup: stop words and one-letter tokens are dropped, and
 * prefix and fuzzy matching apply only to longer terms, because a query built from chip labels
 * ("Climate and environment") otherwise prefix-matches "and" into "android".
 */

export interface LexicalDoc {
  readonly id: string;
  readonly name: string;
  readonly aliases: string;
  readonly organization: string;
  readonly tags: string;
  readonly summary: string;
}

export const LEXICAL_BOOST = { name: 3, aliases: 3, organization: 2, tags: 2, summary: 1 } as const;
const FIELDS = ["name", "aliases", "organization", "tags", "summary"];

const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it", "of", "on",
  "or", "our", "the", "their", "this", "to", "with", "you", "your", "we", "who", "will", "all", "can",
]);

function processTerm(term: string): string | null {
  const t = normalizeForMatch(term).trim();
  if (t.length < 2 || STOP_WORDS.has(t)) return null;
  return t;
}

export function buildLexicalIndex(docs: readonly LexicalDoc[]): MiniSearch<LexicalDoc> {
  const index = new MiniSearch<LexicalDoc>({
    fields: FIELDS,
    idField: "id",
    processTerm: (term) => processTerm(term),
  });
  index.addAll([...docs]);
  return index;
}

export interface LexicalHit {
  readonly id: string;
  /** Internal BM25+ value, used only to order the list. */
  readonly value: number;
  readonly terms: readonly string[];
}

/**
 * Searches with OR semantics and returns hits for allowed ids, best first, at most `limit`.
 * `boostTerms` (for a program the student named) count three times.
 */
export function lexicalSearch(
  index: MiniSearch<LexicalDoc>,
  terms: readonly string[],
  allowed: ReadonlySet<string>,
  limit: number,
  boostTerms: readonly string[] = [],
): LexicalHit[] {
  const query = [...terms, ...boostTerms].join(" ").trim();
  if (!query) return [];
  const boosted = new Set(boostTerms.flatMap((t) => normalizeForMatch(t).trim().split(" ")).filter(Boolean));
  const results = index.search(query, {
    boost: { ...LEXICAL_BOOST },
    combineWith: "OR",
    prefix: (term) => term.length >= 4,
    fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
    boostTerm: (term) => (boosted.has(term) ? 3 : 1),
    filter: (r) => allowed.has(String(r.id)),
  });
  return results.slice(0, limit).map((r) => ({ id: String(r.id), value: r.score, terms: r.terms }));
}
