import MiniSearch, { type Query, type SearchResult as MiniSearchResult } from "minisearch";
import type { SearchHit } from "../contracts/api";
import type { ProgramCard, ReleaseArtifact } from "../contracts/registry";
import {
  MAJOR_FAMILY_LABELS,
  OPPORTUNITY_CATEGORIES,
  OPPORTUNITY_GROUP_LABELS,
  getOpportunityType,
  type ClassYear,
  type CycleStatus,
  type MajorFamily,
  type OpportunityCategory,
  type OpportunityGroup,
  type OpportunityTypeSlug,
} from "../taxonomy";
import { compareIsoDates } from "../time";
import { aliasExpansions } from "./aliases";
import { MATCHING_CONFIG } from "./config";
import { fuseWithLexicalTail } from "./fusion";
import { processTerm } from "./text";
import { deadlineLocalDate, timingContext } from "./timing";
import { encodeWhyShown, type WhyShown } from "./why-shown";

/**
 * Program search: MiniSearch 7.2.0 (BM25+) over the registry release, identical in the browser,
 * the Worker (POST /api/v1/search) and the MCP `search_programs` tool, so all three agree.
 *
 * - Fields and boosts follow plan 6.5 (name and aliases 3, Organization 2, tags 1; summary 0.5).
 * - Fuzzy 0.2 for terms of 4+ characters, prefix for 3+, so "goldwatter" and "fello" work but
 *   "ai" does not match half the catalogue.
 * - Every word is tried first (AND); OR results, including the alias expansions, follow, so a
 *   long or acronym query still finds something without burying exact hits.
 * - Results include not-eligible programs; callers label them, because hiding a program the
 *   student typed is confusing. Relevance values never leave this module: results carry an integer
 *   position, categorical why-shown codes and the matched terms.
 * - The query is never logged or stored here; callers record only a result-count bucket.
 * - Phase 3: `denseRanking` (from hybrid.ts) is fused with the lexical leg by Reciprocal Rank
 *   Fusion, k = 60; a program only the embeddings leg found carries MEANING_MATCH. Without it the
 *   order is the lexical order, unchanged.
 */

interface IndexDoc {
  readonly id: string;
  readonly name: string;
  readonly aliases: string;
  readonly organizationName: string;
  readonly tags: string;
  readonly summary: string;
}

const FIELDS = ["name", "aliases", "organizationName", "tags", "summary"] as const;
type Field = (typeof FIELDS)[number];

export interface ProgramSearchIndex {
  readonly mini: MiniSearch<IndexDoc>;
  readonly cards: ReadonlyMap<string, ProgramCard>;
  /** Release number when built from a release artifact, for parity checks. */
  readonly release: number | null;
}

/** Words a student might type for a card beyond its name: types, groups, fields and tags. */
function tagText(card: ProgramCard): string {
  const parts: string[] = [];
  for (const slug of card.opportunityTypes) {
    const def = getOpportunityType(slug);
    parts.push(slug.replace(/_/g, " "));
    if (def) parts.push(def.label, OPPORTUNITY_GROUP_LABELS[def.group]);
  }
  for (const family of card.majorFamilies) parts.push(MAJOR_FAMILY_LABELS[family]);
  for (const tag of card.interestTags) parts.push(tag in MAJOR_FAMILY_LABELS ? MAJOR_FAMILY_LABELS[tag as MajorFamily] : tag.replace(/[_-]/g, " "));
  if (card.flags.paid) parts.push("paid");
  return parts.join(" ");
}

function toDoc(card: ProgramCard): IndexDoc {
  return {
    id: card.programCycleId,
    name: card.name,
    aliases: card.aliases.join(" "),
    organizationName: card.organizationName,
    tags: tagText(card),
    summary: card.summary ?? "",
  };
}

function newMiniSearch(): MiniSearch<IndexDoc> {
  const cfg = MATCHING_CONFIG.search;
  return new MiniSearch<IndexDoc>({
    fields: [...FIELDS],
    storeFields: [],
    processTerm: (term) => processTerm(term),
    searchOptions: {
      boost: { ...cfg.boosts },
      prefix: (term) => term.length >= cfg.minPrefixTermLength,
      fuzzy: (term) => (term.length >= cfg.minFuzzyTermLength ? cfg.fuzzy : false),
      combineWith: "AND",
      bm25: { ...cfg.bm25 },
      processTerm: (term) => processTerm(term),
    },
  });
}

function isReleaseArtifact(source: readonly ProgramCard[] | ReleaseArtifact): source is ReleaseArtifact {
  return !Array.isArray(source);
}

/** Builds the search index from a release artifact (client-core) or a plain list of cards. */
export function buildIndex(source: readonly ProgramCard[] | ReleaseArtifact): ProgramSearchIndex {
  const cards: readonly ProgramCard[] = isReleaseArtifact(source) ? source.cards : source;
  const mini = newMiniSearch();
  const byId = new Map<string, ProgramCard>();
  for (const card of cards) {
    if (byId.has(card.programCycleId)) continue; // one card per cycle; a duplicate would break MiniSearch
    byId.set(card.programCycleId, card);
    mini.add(toDoc(card));
  }
  return { mini, cards: byId, release: isReleaseArtifact(source) ? source.release : null };
}

// ---------------------------------------------------------------------------------------------
// Filters (all non-sensitive; private status filters run on the device over eligibility results)
// ---------------------------------------------------------------------------------------------

export interface SearchFilters {
  readonly types?: readonly OpportunityTypeSlug[];
  readonly categories?: readonly OpportunityCategory[];
  readonly groups?: readonly OpportunityGroup[];
  /** Cards open to every class year always pass. */
  readonly classYears?: readonly ClassYear[];
  /** Field filter; cards open to all majors always pass. */
  readonly majorFamilies?: readonly MajorFamily[];
  readonly statuses?: readonly CycleStatus[];
  /** true keeps only paid programs (stipend, salary or award). */
  readonly paid?: boolean;
  /** true keeps only programs with no application fee and no participant cost. */
  readonly noCostToApply?: boolean;
  /** Next actionable deadline on or after / on or before these dates, in the viewer's zone. */
  readonly deadlineAfter?: string;
  readonly deadlineBefore?: string;
}

export interface FilterContext {
  readonly now: number;
  readonly timeZone?: string | null;
}

function intersects<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.some((x) => b.includes(x));
}

/** The earliest upcoming submission-type deadline in the viewer's zone, for the deadline window filter. */
export function nextDeadlineDate(card: ProgramCard, ctx: FilterContext): string | null {
  const t = timingContext(ctx.now, ctx.timeZone ?? null);
  let best: string | null = null;
  for (const d of card.deadlines) {
    if (d.kind === "decision_expected" || d.kind === "program_start") continue;
    const dated = deadlineLocalDate(d, t.timeZone);
    if (!dated) continue;
    const upcoming = dated.instant !== null ? dated.instant >= t.now : compareIsoDates(dated.date, t.today) >= 0;
    if (upcoming && (best === null || compareIsoDates(dated.date, best) < 0)) best = dated.date;
  }
  return best;
}

/** True when a card passes every filter that is set. */
export function matchesFilters(card: ProgramCard, filters: SearchFilters, ctx?: FilterContext): boolean {
  if (filters.types?.length && !intersects(card.opportunityTypes, filters.types)) return false;
  if (filters.categories?.length) {
    const slugs: readonly string[] = filters.categories.flatMap((c) => OPPORTUNITY_CATEGORIES[c]);
    if (!card.opportunityTypes.some((t) => slugs.includes(t))) return false;
  }
  if (filters.groups?.length && !card.opportunityTypes.some((t) => filters.groups?.includes(getOpportunityType(t)?.group ?? "other"))) return false;
  if (filters.classYears?.length && card.classYears.length > 0 && !intersects(card.classYears, filters.classYears)) return false;
  if (filters.majorFamilies?.length && card.majorFamilies.length > 0 && !intersects(card.majorFamilies, filters.majorFamilies)) return false;
  if (filters.statuses?.length && !filters.statuses.includes(card.status)) return false;
  if (filters.paid === true && !card.flags.paid) return false;
  if (filters.noCostToApply === true && (card.flags.applicationFee || card.flags.participantCost)) return false;
  if (filters.deadlineAfter || filters.deadlineBefore) {
    const next = nextDeadlineDate(card, ctx ?? { now: Date.now() });
    if (!next) return false;
    if (filters.deadlineAfter && compareIsoDates(next, filters.deadlineAfter) < 0) return false;
    if (filters.deadlineBefore && compareIsoDates(next, filters.deadlineBefore) > 0) return false;
  }
  return true;
}

/** Filters without a query (Explore browse); order comes from rankForStudent. */
export function filterCards(cards: readonly ProgramCard[], filters: SearchFilters, ctx?: FilterContext): ProgramCard[] {
  return cards.filter((c) => matchesFilters(c, filters, ctx));
}

// ---------------------------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------------------------

export interface ProgramSearchOptions {
  readonly filters?: SearchFilters;
  readonly limit?: number;
  readonly offset?: number;
  /** Clock and zone for the deadline window filter. */
  readonly now?: number;
  readonly timeZone?: string | null;
  /**
   * Phase 3 only: programCycleIds from a dense (embedding) leg, best first, fused with the
   * lexical leg by Reciprocal Rank Fusion (hybrid.ts builds it). Off by default (plan s08 D11).
   */
  readonly denseRanking?: readonly string[];
  /**
   * Phase 3 only: merit-weighted exposure boosts b_fair (exposure.ts fairnessBoosts), computed on
   * the server from served positions. They reorder retrieved results slightly and never add one.
   */
  readonly exposureBoosts?: ReadonlyMap<string, number>;
}

export interface ProgramSearchResult {
  readonly card: ProgramCard;
  /** 0-based position for this query; an integer, never a relevance value. */
  readonly rank: number;
  readonly whyShown: readonly WhyShown[];
  readonly matchedTerms: readonly string[];
}

interface LexicalHit {
  readonly id: string;
  readonly terms: readonly string[];
  readonly fields: ReadonlySet<Field>;
}

const FIELD_CODES: readonly (readonly [Field, WhyShown])[] = [
  ["name", { code: "NAME_MATCH" }],
  ["aliases", { code: "ALIAS_MATCH" }],
  ["organizationName", { code: "ORG_MATCH" }],
  ["tags", { code: "TOPIC_MATCH" }],
  ["summary", { code: "TOPIC_MATCH" }],
];

function toLexical(r: MiniSearchResult): LexicalHit {
  const fields = new Set<Field>();
  for (const names of Object.values(r.match)) for (const f of names) fields.add(f as Field);
  return { id: String(r.id), terms: r.terms, fields };
}

function matchCodes(hit: LexicalHit | undefined): WhyShown[] {
  // Only the embeddings leg found it: say so rather than claim a word matched.
  if (!hit) return [{ code: "MEANING_MATCH" }];
  const out: WhyShown[] = [];
  for (const [field, code] of FIELD_CODES) {
    if (hit.fields.has(field) && !out.some((w) => w.code === code.code)) out.push(code);
  }
  return out;
}

/** Lexical leg: AND hits first, then OR hits (with alias expansions) not already listed. */
function lexicalSearch(index: ProgramSearchIndex, query: string, keep: (id: string) => boolean): LexicalHit[] {
  const filter = (r: MiniSearchResult) => keep(String(r.id));
  const strict = index.mini.search(query, { combineWith: "AND", filter }).map(toLexical);
  const expansions = aliasExpansions(query);
  const loose: Query = expansions.length ? { combineWith: "OR", queries: [query, ...expansions] } : query;
  const broad = index.mini.search(loose, { combineWith: "OR", filter }).map(toLexical);
  const seen = new Set(strict.map((h) => h.id));
  return [...strict, ...broad.filter((h) => !seen.has(h.id))];
}

/**
 * Searches the index. Returns at most `limit` results from `offset`, best first. An empty or
 * whitespace query returns nothing; Explore's browse view uses filterCards + rankForStudent.
 */
export function search(index: ProgramSearchIndex, query: string, opts: ProgramSearchOptions = {}): ProgramSearchResult[] {
  const q = query.trim();
  if (!q) return [];
  const cfg = MATCHING_CONFIG.search;
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? cfg.defaultLimit)), cfg.maxLimit);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const filters = opts.filters ?? {};
  const ctx: FilterContext = { now: opts.now ?? Date.now(), timeZone: opts.timeZone ?? null };
  const verdicts = new Map<string, boolean>();
  const keep = (id: string): boolean => {
    let v = verdicts.get(id);
    if (v === undefined) {
      const card = index.cards.get(id);
      v = card !== undefined && matchesFilters(card, filters, ctx);
      verdicts.set(id, v);
    }
    return v;
  };

  const lexical = lexicalSearch(index, q, keep);
  const byId = new Map(lexical.map((h) => [h.id, h]));
  const dense = opts.denseRanking?.filter(keep) ?? [];
  const lexicalIds = lexical.map((h) => h.id);
  const boosts = opts.exposureBoosts;
  const orderedIds = dense.length || (boosts && boosts.size) ? fuseWithLexicalTail(lexicalIds, dense, boosts) : lexicalIds;

  return orderedIds.slice(offset, offset + limit).map((id, i) => {
    const hit = byId.get(id);
    return {
      card: index.cards.get(id) as ProgramCard,
      rank: offset + i,
      whyShown: matchCodes(hit),
      matchedTerms: (hit?.terms ?? []).slice(0, cfg.maxMatchedTerms),
    };
  });
}

/** Ids only, for the retrieval eval and the MCP tool's candidate list. */
export function searchIds(index: ProgramSearchIndex, query: string, k: number): string[] {
  return search(index, query, { limit: Math.min(k, MATCHING_CONFIG.search.maxLimit) }).map((r) => r.card.programCycleId);
}

/** The wire shape of POST /api/v1/search (SearchHit): codes encoded, at most 6, no score. */
export function toSearchHit(result: ProgramSearchResult): SearchHit {
  return {
    card: result.card,
    rank: result.rank,
    whyShown: result.whyShown.slice(0, 6).map(encodeWhyShown),
    matchedTerms: result.matchedTerms.slice(0, 10).map((t) => t.slice(0, 60)),
  };
}
