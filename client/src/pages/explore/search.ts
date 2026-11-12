import MiniSearch from "minisearch";
import type { ProgramCard } from "@shared/contracts/registry";
import { getOpportunityType } from "@shared/taxonomy";

/**
 * In-browser program search over the cards Explore already holds: typo-tolerant, prefix-aware
 * and alias-aware ("REU", "sprintship"), with no network round trip. It mirrors the planned
 * shared/matching search so the browser and POST /api/v1/search agree; when that module ships,
 * swap buildProgramIndex/searchPrograms for its buildIndex/search.
 */

/** Common shorthand students type, expanded to words the records contain. */
export const QUERY_ALIASES: Readonly<Record<string, string>> = {
  reu: "research experience undergraduates research program",
  surf: "summer undergraduate research fellowship research",
  sprintship: "sprinternship sprint",
  sprintern: "sprinternship sprint",
  "spring week": "insight week early career",
  insight: "insight early career exposure",
  oss: "open source",
  stem: "science technology engineering math",
  cs: "computing software computer science",
  swe: "software engineering internship",
  bio: "biology life sciences",
  apprentice: "apprenticeship",
};

interface IndexedProgram {
  id: string;
  name: string;
  organizationName: string;
  summary: string;
  tags: string;
  aliases: string;
  types: string;
}

function toDoc(card: ProgramCard): IndexedProgram {
  return {
    id: card.programCycleId,
    name: card.name,
    organizationName: card.organizationName,
    summary: card.summary ?? "",
    tags: card.interestTags.join(" "),
    aliases: card.aliases.join(" "),
    types: card.opportunityTypes
      .map((t) => `${t.replace(/_/g, " ")} ${getOpportunityType(t)?.label ?? ""}`)
      .join(" "),
  };
}

export type ProgramIndex = MiniSearch<IndexedProgram>;

export function buildProgramIndex(cards: readonly ProgramCard[]): ProgramIndex {
  const index = new MiniSearch<IndexedProgram>({
    fields: ["name", "organizationName", "summary", "tags", "aliases", "types"],
    storeFields: [],
    searchOptions: {
      boost: { name: 3, aliases: 3, organizationName: 2, tags: 1.5, types: 1.2 },
      prefix: true,
      // Fuzzy only for longer terms, so "ai" or "cs" do not match half the catalogue.
      fuzzy: (term) => (term.length >= 5 ? 0.2 : false),
      combineWith: "AND",
    },
  });
  index.addAll(cards.map(toDoc));
  return index;
}

/** Lower-cases, trims and appends alias expansions for known shorthand. */
export function expandQuery(raw: string): string {
  const q = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!q) return "";
  const extra = Object.entries(QUERY_ALIASES)
    .filter(([alias]) => q === alias || q.split(" ").includes(alias) || (alias.includes(" ") && q.includes(alias)))
    .map(([, expansion]) => expansion);
  return extra.length ? `${q} ${extra.join(" ")}` : q;
}

/**
 * Program cycle ids matching the query, best first. Tries every word first (AND); if nothing
 * matches, falls back to any word (OR) so a long query still finds something.
 */
export function searchPrograms(index: ProgramIndex, raw: string): string[] {
  const q = raw.trim().toLowerCase();
  if (!q) return [];
  const strict = index.search(q);
  if (strict.length > 0) return strict.map((r) => String(r.id));
  const expanded = expandQuery(raw);
  return index.search(expanded, { combineWith: "OR" }).map((r) => String(r.id));
}
