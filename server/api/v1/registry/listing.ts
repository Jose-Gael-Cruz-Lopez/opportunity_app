import type { DeadlineListItem, DeadlineListQuery, ProgramListQuery, SearchRequest } from "@shared/contracts/api";
import type { ProgramCard } from "@shared/contracts/registry";
import { PRODUCT } from "@shared/config/product";
import { evaluateEligibility } from "@shared/eligibility";
import { matchesFilters, type SearchFilters } from "@shared/matching";
import { localDateIn, parseIsoInstant, toIsoInstant } from "@shared/time";
import { decodeCursor, encodeCursor } from "@server/db/util";
import { placementAt } from "./order";

/**
 * Pure list logic for the registry routes: query -> filters, the community-college filter,
 * offset cursors, and the upcoming-deadline list. No I/O, so it is unit-tested directly.
 */

export function filtersFromListQuery(q: ProgramListQuery): SearchFilters {
  return {
    types: q.type,
    categories: q.category,
    classYears: q.classYear,
    majorFamilies: q.majorFamily,
    statuses: q.status,
    deadlineAfter: q.deadlineAfter,
    deadlineBefore: q.deadlineBefore,
  };
}

export function filtersFromSearch(filters: SearchRequest["filters"]): SearchFilters {
  return { types: filters.types, classYears: filters.classYears, majorFamilies: filters.majorFamilies, statuses: filters.statuses };
}

/**
 * Whether a two-year (community college) student could be eligible, judged by the shared
 * evaluator on the institution level alone. Rules on other dimensions come back unknown, never
 * not_met, so only an explicit institution-level exclusion removes a card. The evaluation uses a
 * non-sensitive field only; nothing about a real student is involved.
 */
export function openToTwoYear(card: ProgramCard, asOf: string): boolean {
  if (!card.rules) return true;
  return evaluateEligibility(card.rules, { institutionLevel: "two_year" }, { asOf }).status !== "not_eligible";
}

/** Applies every list filter; `openToCommunityCollege` "false" keeps only cards that exclude two-year students. */
export function filterListCards(cards: readonly ProgramCard[], q: ProgramListQuery, now: number): ProgramCard[] {
  const filters = filtersFromListQuery(q);
  const ctx = { now, timeZone: null };
  const asOf = localDateIn(now, PRODUCT.fallbackTimeZone);
  return cards.filter((card) => {
    if (!matchesFilters(card, filters, ctx)) return false;
    if (q.openToCommunityCollege === undefined) return true;
    return openToTwoYear(card, asOf) === (q.openToCommunityCollege === "true");
  });
}

// ---------------------------------------------------------------------------------------------
// Offset cursors. A list is derived from one release's cards, so an offset plus the release it
// was issued for is enough; a cursor from an older release still pages forward (the list may
// have shifted by a few items, which is acceptable for a public catalogue).
// ---------------------------------------------------------------------------------------------

export function encodeOffsetCursor(offset: number, release: number): string {
  return encodeCursor({ k: offset, id: `r${release}` });
}

/** The offset in a cursor; 0 for none; null for a malformed one (the route answers 400). */
export function decodeOffsetCursor(raw: string | undefined): number | null {
  if (!raw) return 0;
  const c = decodeCursor(raw);
  if (!c || typeof c.k !== "number" || !Number.isInteger(c.k) || c.k < 0 || !/^r\d+$/.test(c.id)) return null;
  return c.k;
}

export interface Page<T> {
  readonly items: T[];
  readonly page: { readonly nextCursor: string | null; readonly limit: number };
}

export function paginate<T>(all: readonly T[], offset: number, limit: number, release: number): Page<T> {
  const items = all.slice(offset, offset + limit);
  const next = offset + limit < all.length ? encodeOffsetCursor(offset + limit, release) : null;
  return { items, page: { nextCursor: next, limit } };
}

// ---------------------------------------------------------------------------------------------
// Upcoming deadlines
// ---------------------------------------------------------------------------------------------

/** Kinds listed on the deadlines page: steps a student submits, not informational dates. */
const LISTED_KINDS: ReadonlySet<string> = new Set(["application", "priority_round", "interest_form", "recommendation", "supplemental"]);

interface PlacedItem {
  readonly item: DeadlineListItem;
  readonly placement: number;
  readonly sortAt: number;
}

/**
 * National deadlines due between now and `withinDays` ahead, from the release's cards. A
 * nomination-gated cycle enters the list at its estimated campus deadline (see ./order.ts), so
 * students see it while the campus window is still open. Campus rows are per institution and are
 * not part of this public list; students see their campus's dates on their own feed and Tracker.
 */
export function upcomingDeadlines(cards: readonly ProgramCard[], q: DeadlineListQuery, now: number): DeadlineListItem[] {
  if (q.scope === "campus") return [];
  const horizon = now + q.withinDays * 86_400_000;
  const filters: SearchFilters = { types: q.type, classYears: q.classYear };
  const placed: PlacedItem[] = [];
  for (const card of cards) {
    if (!matchesFilters(card, filters)) continue;
    for (const d of card.deadlines) {
      if (d.scope !== "national" || !LISTED_KINDS.has(d.kind) || d.precision === "rolling" || d.precision === "tbd") continue;
      const sortAt = d.sortAt ? parseIsoInstant(d.sortAt) : null;
      if (sortAt === null || sortAt < now) continue;
      const placement = placementAt(sortAt, card.flags.nominationRequired, now);
      if (placement > horizon) continue;
      placed.push({
        placement,
        sortAt,
        item: {
          deadlineId: d.id,
          programSlug: card.slug,
          programName: card.name,
          cycleKey: card.cycleKey,
          kind: d.kind,
          basis: d.basis,
          localDate: d.localDate,
          localTime: d.localTime,
          timeZone: d.timeZone,
          applicantLocal: d.tzMode === "applicant_local",
          sortAt: toIsoInstant(sortAt),
          nominationRequired: card.flags.nominationRequired,
        },
      });
    }
  }
  placed.sort((a, b) => a.placement - b.placement || a.sortAt - b.sortAt || (a.item.deadlineId ?? "").localeCompare(b.item.deadlineId ?? ""));
  return placed.map((p) => p.item);
}
