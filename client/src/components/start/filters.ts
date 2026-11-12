import { OPPORTUNITY_CATEGORIES, type OpportunityCategory } from "@shared/contracts";
import type { SavedFilters } from "./storage";
import type { MatchView, Tier } from "./normalize";

/**
 * Match filters on the device. They narrow what is shown; they never re-rank, so the order
 * from findMatches (strong, good, stretch, then fused rank within a tier) is kept.
 */

export interface MatchFacts {
  types: readonly string[];
  paid: boolean;
  remote: boolean;
}

export function applyFilters(
  matches: readonly MatchView[],
  filters: SavedFilters,
  facts: (programId: string) => MatchFacts | undefined,
): MatchView[] {
  return matches.filter((m) => {
    if (filters.tiers.length && !filters.tiers.includes(m.tier)) return false;
    const f = facts(m.programId);
    if (!f) return true;
    if (filters.paidOnly && !f.paid) return false;
    if (filters.remoteOnly && !f.remote) return false;
    if (filters.types.length) {
      const wanted = new Set(filters.types.flatMap((c) => categorySlugs(c)));
      if (!f.types.some((t) => wanted.has(t))) return false;
    }
    return true;
  });
}

/** A filter chip may be a plain-language category (internships) or a single type slug. */
export function categorySlugs(key: string): string[] {
  const cat = (OPPORTUNITY_CATEGORIES as Record<string, readonly string[]>)[key];
  return cat ? [...cat] : [key];
}

/** Categories that actually appear among the matches, for the chip row. */
export function categoriesPresent(matches: readonly MatchView[], facts: (id: string) => MatchFacts | undefined): OpportunityCategory[] {
  const present = new Set<string>();
  for (const m of matches) for (const t of facts(m.programId)?.types ?? []) present.add(t);
  return (Object.keys(OPPORTUNITY_CATEGORIES) as OpportunityCategory[]).filter((c) =>
    OPPORTUNITY_CATEGORIES[c].some((slug) => present.has(slug)),
  );
}

export function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

/** Counts per tier, for "3 strong, 4 good" headers and the analytics event (counts only). */
export function tierCounts(matches: readonly MatchView[]): Record<Tier, number> {
  const out: Record<Tier, number> = { strong: 0, good: 0, stretch: 0 };
  for (const m of matches) out[m.tier] += 1;
  return out;
}

/** The first reveal shows three; "See more" shows the rest (study notes: 3 then see more). */
export const FIRST_REVEAL = 3;

export function visibleMatches(matches: readonly MatchView[], expanded: boolean): MatchView[] {
  return expanded ? [...matches] : matches.slice(0, FIRST_REVEAL);
}
