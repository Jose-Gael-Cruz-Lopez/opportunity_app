import type { ProgramCard } from "@shared/contracts";
import {
  getOpportunityType,
  OPPORTUNITY_GROUP_LABELS,
  OPPORTUNITY_GROUPS,
  OPPORTUNITY_TYPES,
  opportunityTypesInGroup,
  type OpportunityGroup,
  type OpportunityTypeSlug,
} from "@shared/taxonomy";
import { browseOrder } from "./views/explore";
import { groupOf } from "./view-model";

/**
 * Type hubs (/types/:type, plan s01 F-18 and s10 10.8.4). A hub is generated from verified
 * registry data and exists only once its family or type has at least HUB_MIN_VERIFIED programs a
 * person has verified, because thin pages generated in bulk read to search engines as scaled
 * content. Below the bar the path is a plain 404 and Explore's filter does the job instead.
 *
 * `:type` is either a family ("research", "early-career") or one opportunity type
 * ("research-program"). URLs use hyphens; the underscore spelling 301s to them.
 */

export const HUB_MIN_VERIFIED = 10;

export type HubKey = { readonly kind: "group"; readonly group: OpportunityGroup } | { readonly kind: "type"; readonly type: OpportunityTypeSlug };

/** Families that never get a hub: "other" is a catch-all, not a kind of opportunity. */
const NO_HUB_GROUPS: ReadonlySet<OpportunityGroup> = new Set<OpportunityGroup>(["other"]);

const GROUP_SET: ReadonlySet<string> = new Set(OPPORTUNITY_GROUPS);

export function hubSlug(key: HubKey): string {
  return (key.kind === "group" ? key.group : key.type).replace(/_/g, "-");
}

export function hubPath(key: HubKey): string {
  return `/types/${hubSlug(key)}`;
}

/**
 * The hub a path segment names, or null. `canonical` is false when the segment is spelled
 * differently from the hub's own path (upper case or underscores), so the route can 301.
 */
export function parseHubParam(raw: string): { key: HubKey; canonical: boolean } | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(raw)) return null;
  const id = raw.toLowerCase().replace(/-/g, "_");
  let key: HubKey | null = null;
  if (GROUP_SET.has(id) && !NO_HUB_GROUPS.has(id as OpportunityGroup)) key = { kind: "group", group: id as OpportunityGroup };
  else {
    const def = getOpportunityType(id);
    if (def && def.inScope && !NO_HUB_GROUPS.has(def.group)) key = { kind: "type", type: def.slug as OpportunityTypeSlug };
  }
  return key ? { key, canonical: raw === hubSlug(key) } : null;
}

export function hubLabel(key: HubKey): string {
  return key.kind === "group" ? OPPORTUNITY_GROUP_LABELS[key.group] : (getOpportunityType(key.type)?.label ?? key.type);
}

/** The family a hub belongs to (its own for a family hub). */
export function hubGroup(key: HubKey): OpportunityGroup {
  return key.kind === "group" ? key.group : groupOf(key.type);
}

/** Explore's filter for the hub's family: the fallback link for hubs below the bar. */
export function exploreHref(key: HubKey): string {
  return `/explore?group=${hubGroup(key)}`;
}

function matches(card: ProgramCard, key: HubKey): boolean {
  return key.kind === "group" ? card.opportunityTypes.some((t) => groupOf(t) === key.group) : card.opportunityTypes.includes(key.type);
}

/** Cards in a hub, in the same browse order as Explore. */
export function hubCards(cards: readonly ProgramCard[], key: HubKey, now: number): ProgramCard[] {
  return browseOrder(
    cards.filter((c) => matches(c, key)),
    now,
  );
}

/** Programs a person has verified (aging included; stale, re-checking and unverified are not). */
export function verifiedCount(cards: readonly ProgramCard[], opts: { realOnly?: boolean } = {}): number {
  return cards.filter((c) => c.verification.state === "verified" && (!opts.realOnly || !c.isSample)).length;
}

/** Whether the hub page exists at all. */
export function hubAvailable(cards: readonly ProgramCard[], key: HubKey, now: number): boolean {
  return verifiedCount(hubCards(cards, key, now)) >= HUB_MIN_VERIFIED;
}

/** Whether the hub may be indexed: the bar met by real programs alone (sample records never count). */
export function hubIndexable(cards: readonly ProgramCard[], key: HubKey, now: number): boolean {
  return verifiedCount(hubCards(cards, key, now), { realOnly: true }) >= HUB_MIN_VERIFIED;
}

/** Every hub key, families first in taxonomy order, then in-scope types by ordinal. */
export function allHubKeys(): HubKey[] {
  const groups: HubKey[] = OPPORTUNITY_GROUPS.filter((g) => !NO_HUB_GROUPS.has(g)).map((group) => ({ kind: "group", group }));
  const types: HubKey[] = OPPORTUNITY_TYPES.filter((t) => t.inScope && !NO_HUB_GROUPS.has(t.group)).map((t) => ({ kind: "type", type: t.slug }));
  return [...groups, ...types];
}

/** Hubs that pass the bar; `indexableOnly` keeps those real programs alone qualify (sitemap, llms.txt). */
export function availableHubs(cards: readonly ProgramCard[], now: number, opts: { indexableOnly?: boolean } = {}): HubKey[] {
  return allHubKeys().filter((key) => (opts.indexableOnly ? hubIndexable(cards, key, now) : hubAvailable(cards, key, now)));
}

/** The types inside a family hub with how many listed programs each has (types with none left out). */
export function subtypeCounts(cards: readonly ProgramCard[], key: HubKey): { type: OpportunityTypeSlug; label: string; count: number }[] {
  if (key.kind !== "group") return [];
  return opportunityTypesInGroup(key.group)
    .filter((t) => t.inScope)
    .map((t) => ({ type: t.slug as OpportunityTypeSlug, label: t.label, count: cards.filter((c) => c.opportunityTypes.includes(t.slug as OpportunityTypeSlug)).length }))
    .filter((t) => t.count > 0);
}

/**
 * One editorial sentence per family, written by Novus (no program facts, so nothing here can go
 * stale). Everything numeric on a hub is generated from the registry at render time.
 */
export const GROUP_INTROS: Readonly<Record<OpportunityGroup, string>> = {
  internships: "Paid roles built for students early in college, at companies, labs, museums and agencies, including co-ops and short projects.",
  early_career: "Short programs that show you an industry from the inside: insight days, spring weeks, sprints and job shadowing, often the first step toward an internship.",
  research: "Paid research with a mentor, from summer lab programs to pipelines into graduate school and open-source projects.",
  fellowships: "Cohorts with mentors, stipends and a network that lasts past the summer, plus grants for your own project and study abroad.",
  scholarships: "Named awards and scholarships. Where your campus must nominate you, the campus deadline comes first and we show it separately.",
  apprenticeships_training: "Earn while you learn: registered apprenticeships and paid training with a mentor and a paycheck from the first day.",
  service_government: "Public service, government programs and service years, including teaching fellowships.",
  events_competitions: "Conferences with travel support, and competitions in case, pitch, writing, arts and hackathons.",
  community_resources: "Communities, mentorship networks and free virtual job simulations you can start any time.",
  other: "",
};
