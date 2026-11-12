import { tokenize } from "./text";

/**
 * Query-side alias table: shorthand students type, expanded to words program records contain.
 * Per-program aliases ("Goldwater" for a long official name) live on the card itself and are
 * indexed; this table only covers generic acronyms and coinages that span many programs.
 *
 * Governance (plan 6.5): new entries come only from the development half of real search
 * phrasings or an approved opt-in form, never from the frozen test half, so the retrieval eval
 * never grades the system against its own alias table. Bump ALIAS_TABLE_VERSION on any change;
 * the release manifest records it.
 */
export const ALIAS_TABLE_VERSION = "aliases-v1";

export const ALIAS_TABLE: Readonly<Record<string, string>> = {
  reu: "research experiences for undergraduates research program",
  surf: "summer undergraduate research fellowship research",
  suli: "science undergraduate laboratory internships laboratory internship",
  mlt: "management leadership for tomorrow career prep",
  sprintship: "sprinternship sprint",
  sprinternship: "sprinternship sprint",
  sprintern: "sprinternship sprint",
  "spring week": "spring week insight early career",
  "insight week": "insight early career exposure",
  "insight program": "insight early career exposure",
  "discovery program": "discovery early career exposure",
  externship: "externship shadowing",
  shadowing: "externship shadowing",
  coop: "co op off cycle internship",
  "co op": "co op off cycle internship",
  apprentice: "apprenticeship",
  oss: "open source",
  gsoc: "open source mentorship",
  swe: "software engineering",
  sde: "software engineering",
  cs: "computer science computing",
  ml: "machine learning",
  ai: "artificial intelligence machine learning",
  stem: "science technology engineering math",
  bio: "biology life sciences",
  econ: "economics",
  poli: "political science policy",
  premed: "pre medical health",
  "pre med": "pre medical health",
  prelaw: "pre law",
  phd: "phd pipeline doctoral",
  hackathon: "hackathon competition",
  scholarship: "scholarship award",
  fellowship: "fellowship",
  internship: "internship",
  paid: "paid stipend salary",
  stipend: "stipend paid",
  "study abroad": "study abroad language",
  "public service": "government public service",
  gov: "government public service",
};

/** Alias keys pre-tokenized once, longest first so "spring week" wins over a shorter key. */
const ALIAS_KEYS: readonly { readonly tokens: readonly string[]; readonly expansion: string }[] = Object.entries(ALIAS_TABLE)
  .map(([key, expansion]) => ({ tokens: tokenize(key), expansion }))
  .filter((entry) => entry.tokens.length > 0)
  .sort((a, b) => b.tokens.length - a.tokens.length);

function containsSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

/**
 * Expansions that apply to a query, in table order and without duplicates. Matching is on whole
 * tokens, so "cs" never fires inside "physics".
 */
export function aliasExpansions(query: string): string[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const out: string[] = [];
  for (const entry of ALIAS_KEYS) {
    if (containsSequence(tokens, entry.tokens) && !out.includes(entry.expansion)) out.push(entry.expansion);
  }
  return out;
}
