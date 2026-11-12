import type { ProgramCard } from "@shared/contracts/registry";
import type { StudentProfile } from "@shared/contracts/student";
import { getOpportunityType, OPPORTUNITY_GROUP_LABELS, OPPORTUNITY_GROUPS, type OpportunityGroup } from "@shared/taxonomy";
import { compareBySoonest } from "@/lib/deadlines";

/**
 * Explore filter state. It lives in the URL (?q=&group=&paid=1...) so a filtered view can be
 * bookmarked, shared and restored with the back button. Filters use only non-sensitive data
 * (class year, pay, status); status and identity rules are checked on the program page, in the
 * browser, and never hide a card here.
 */

export interface ExploreFilters {
  readonly q: string;
  readonly group: OpportunityGroup | "all";
  readonly openToMyYear: boolean;
  readonly paid: boolean;
  readonly openNow: boolean;
}

export const DEFAULT_FILTERS: ExploreFilters = {
  q: "",
  group: "all",
  openToMyYear: false,
  paid: false,
  openNow: false,
};

const FLAG_PARAMS = {
  openToMyYear: "year",
  paid: "paid",
  openNow: "open",
} as const satisfies Record<string, string>;

type FlagKey = keyof typeof FLAG_PARAMS;
export const FLAG_KEYS = Object.keys(FLAG_PARAMS) as FlagKey[];

function isGroup(value: string | null): value is OpportunityGroup {
  return !!value && (OPPORTUNITY_GROUPS as readonly string[]).includes(value);
}

export function parseFilters(search: string): ExploreFilters {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const group = params.get("group");
  const flags = Object.fromEntries(FLAG_KEYS.map((k) => [k, params.get(FLAG_PARAMS[k]) === "1"])) as Record<FlagKey, boolean>;
  return {
    q: (params.get("q") ?? "").slice(0, 200),
    group: isGroup(group) ? group : "all",
    ...flags,
  };
}

/** Query string without defaults, so the URL stays short. */
export function serializeFilters(filters: ExploreFilters): string {
  const params = new URLSearchParams();
  if (filters.q.trim()) params.set("q", filters.q.trim());
  if (filters.group !== "all") params.set("group", filters.group);
  for (const key of FLAG_KEYS) if (filters[key]) params.set(FLAG_PARAMS[key], "1");
  const s = params.toString();
  return s ? `?${s}` : "";
}

export function groupsOf(card: Pick<ProgramCard, "opportunityTypes">): Set<OpportunityGroup> {
  return new Set(card.opportunityTypes.map((t) => getOpportunityType(t)?.group).filter((g): g is OpportunityGroup => !!g));
}

export interface GroupCount {
  readonly group: OpportunityGroup;
  readonly label: string;
  readonly count: number;
}

/** Groups that have at least one card, in taxonomy order. */
export function groupCounts(cards: readonly ProgramCard[]): GroupCount[] {
  const counts = new Map<OpportunityGroup, number>();
  for (const card of cards) for (const g of groupsOf(card)) counts.set(g, (counts.get(g) ?? 0) + 1);
  return OPPORTUNITY_GROUPS.filter((g) => (counts.get(g) ?? 0) > 0).map((g) => ({ group: g, label: OPPORTUNITY_GROUP_LABELS[g], count: counts.get(g) ?? 0 }));
}

export interface FilterContext {
  readonly profile: Pick<StudentProfile, "classYear" | "majorFamily" | "timeZone"> | null;
  readonly now: number;
  /** Search hits in rank order; null when there is no query. */
  readonly searchHits: readonly string[] | null;
}

/**
 * Applies filters and orders the result: by search rank when there is a query, otherwise
 * soonest deadline first. Never by a score about the student.
 */
export function applyFilters(cards: readonly ProgramCard[], filters: ExploreFilters, ctx: FilterContext): ProgramCard[] {
  const year = ctx.profile?.classYear ?? null;
  const kept = cards.filter((card) => {
    if (filters.group !== "all" && !groupsOf(card).has(filters.group)) return false;
    if (filters.paid && !card.flags.paid) return false;
    if (filters.openNow && card.status !== "open") return false;
    if (filters.openToMyYear && year && card.classYears.length > 0 && !card.classYears.includes(year)) return false;
    return true;
  });

  if (ctx.searchHits) {
    const rank = new Map(ctx.searchHits.map((id, i) => [id, i]));
    return kept.filter((c) => rank.has(c.programCycleId)).sort((a, b) => (rank.get(a.programCycleId) ?? 0) - (rank.get(b.programCycleId) ?? 0));
  }
  const zone = ctx.profile?.timeZone ?? null;
  return [...kept].sort((a, b) => compareBySoonest(a, b, ctx.now, zone));
}

export function activeFilterCount(filters: ExploreFilters): number {
  return (filters.group !== "all" ? 1 : 0) + FLAG_KEYS.filter((k) => filters[k]).length;
}
