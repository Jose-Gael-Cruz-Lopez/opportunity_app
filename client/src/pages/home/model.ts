import type { InboxItem } from "@shared/contracts/events";
import type { ProgramCard } from "@shared/contracts/registry";
import type { Roadmap, RoadmapItem } from "@shared/contracts/roadmap";
import type { StudentProfile, TrackerItem } from "@shared/contracts/student";
import { addDays, compareIsoDates, isoWeekday, termKeyForDate } from "@shared/time";
import { compareBySoonest, nextDeadline } from "@/lib/deadlines";
import { eligibilityHint } from "@/lib/eligibility-hint";

/** Pure view models for Home. Everything takes `today`/`now`, so tests pin the calendar. */

// ---- This week -------------------------------------------------------------------------------

export interface WeekDay {
  readonly date: string;
  /** One-letter weekday for the strip. */
  readonly letter: string;
  readonly name: string;
  readonly day: number;
  readonly isToday: boolean;
  readonly hasEvent: boolean;
}

const LETTERS = ["M", "T", "W", "T", "F", "S", "S"] as const;
const NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** Monday-to-Sunday week containing `today`, marking days that have a deadline or plan item. */
export function buildWeek(today: string, eventDates: Iterable<string>): WeekDay[] {
  const events = new Set(eventDates);
  const monday = addDays(today, 1 - isoWeekday(today));
  return Array.from({ length: 7 }, (_, i) => {
    const date = addDays(monday, i);
    return {
      date,
      letter: LETTERS[i] as string,
      name: NAMES[i] as string,
      day: Number(date.slice(8, 10)),
      isToday: date === today,
      hasEvent: events.has(date),
    };
  });
}

export function weekRange(today: string): { start: string; end: string } {
  const start = addDays(today, 1 - isoWeekday(today));
  return { start, end: addDays(start, 6) };
}

/** Items on the plan card. */
export const PLAN_LIMIT = 4;

function itemDate(item: RoadmapItem): string | null {
  return item.dueOn ?? item.startBy;
}

/**
 * This week's plan: open or done roadmap items in the current term, those dated this week
 * first; if the week is empty, the next open items so the card is never blank.
 */
export function planForWeek(roadmap: Roadmap | null | undefined, today: string): RoadmapItem[] {
  if (!roadmap || roadmap.terms.length === 0) return [];
  const currentKey = termKeyForDate(today);
  const term = roadmap.terms.find((t) => t.term === currentKey) ?? roadmap.terms[0];
  if (!term) return [];
  const items = [...term.apply, ...term.prepare, ...term.milestones].filter((i) => i.state === "open" || i.state === "done");
  const { start, end } = weekRange(today);
  const inWeek = (i: RoadmapItem) => {
    const d = itemDate(i);
    return d !== null && compareIsoDates(d, start) >= 0 && compareIsoDates(d, end) <= 0;
  };
  const byDate = (a: RoadmapItem, b: RoadmapItem) => compareIsoDates(itemDate(a) ?? "9999-12-31", itemDate(b) ?? "9999-12-31");
  const thisWeek = items.filter(inWeek).sort(byDate);
  if (thisWeek.length > 0) return thisWeek.slice(0, PLAN_LIMIT);
  return items
    .filter((i) => i.state === "open")
    .sort(byDate)
    .slice(0, PLAN_LIMIT);
}

// ---- Picked for your season ------------------------------------------------------------------

export interface SeasonPick {
  readonly card: ProgramCard;
  readonly reason: string;
}

type PickProfile = Pick<StudentProfile, "classYear" | "majorFamily" | "timeZone" | "preferredOpportunityTypes">;

/**
 * One program to look at next. Ordered lexicographically, never by a score: open to the
 * student's year first, then a preferred type, then enough runway to prepare, then soonest.
 * Programs already tracked or not open to the student's year are skipped.
 */
export function pickForSeason(
  cards: readonly ProgramCard[],
  profile: PickProfile | null,
  tracker: readonly TrackerItem[],
  now: number,
): SeasonPick | null {
  const tracked = new Set(tracker.map((t) => t.programCycleId));
  const zone = profile?.timeZone ?? null;
  const candidates = cards.filter((c) => (c.status === "open" || c.status === "expected") && !tracked.has(c.programCycleId) && eligibilityHint(c, profile).kind !== "not_your_year");
  if (candidates.length === 0) return null;

  const preferred = new Set(profile?.preferredOpportunityTypes ?? []);
  const keys = (c: ProgramCard): number[] => {
    const hint = eligibilityHint(c, profile).kind;
    const next = nextDeadline(c, now, zone);
    const runwayOk = !next || c.prepDays === null || next.daysLeft >= c.prepDays;
    return [hint === "open_to_you" ? 0 : 1, c.opportunityTypes.some((t) => preferred.has(t)) ? 0 : 1, runwayOk ? 0 : 1];
  };
  const sorted = [...candidates].sort((a, b) => {
    const ka = keys(a);
    const kb = keys(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return (ka[i] ?? 0) - (kb[i] ?? 0);
    return compareBySoonest(a, b, now, zone);
  });
  const card = sorted[0];
  if (!card) return null;
  return { card, reason: pickReason(card, profile, now) };
}

function pickReason(card: ProgramCard, profile: PickProfile | null, now: number): string {
  const parts: string[] = [];
  const year = profile?.classYear;
  if (year && card.classYears.includes(year)) parts.push("takes students in your year");
  const major = profile?.majorFamily;
  if (major && card.majorFamilies.includes(major)) parts.push("fits your field");
  const next = nextDeadline(card, now, profile?.timeZone ?? null);
  if (next) parts.push(`closes in ${next.daysLeft} ${next.daysLeft === 1 ? "day" : "days"}`);
  else if (card.status === "expected") parts.push("opens soon");
  if (parts.length === 0) return card.summary ?? "";
  const sentence = parts.join(", ").replace(/, ([^,]*)$/, " and $1");
  return `Shown because it ${sentence}.`;
}

// ---- Changes feed ----------------------------------------------------------------------------

export interface FeedRow {
  readonly id: string;
  readonly tone: "good" | "warn";
  readonly title: string;
  /** In-app path relative to /app, or null. */
  readonly href: string | null;
  readonly createdAt: string;
  readonly unread: boolean;
}

/** Changes that may need the student to act get the warm marker. */
const WARN_TYPES: ReadonlySet<InboxItem["type"]> = new Set(["deadline.changed", "cycle.status_changed", "cycle.urgent_recheck", "eligibility.changed", "deadline.reminder", "posting.closed"]);

export const FEED_LIMIT = 4;

export function feedRows(inbox: readonly InboxItem[]): FeedRow[] {
  return [...inbox]
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
    .slice(0, FEED_LIMIT)
    .map((item) => ({
      id: item.id,
      tone: WARN_TYPES.has(item.type) ? "warn" : "good",
      title: item.title,
      href: item.href ? item.href.replace(/^\/app(?=\/|$)/, "") || "/" : null,
      createdAt: item.createdAt,
      unread: item.readAt === null,
    }));
}

/** Dates this week that carry a tracked deadline or a plan item, for the week strip dots. */
export function eventDatesThisWeek(
  today: string,
  plan: readonly RoadmapItem[],
  trackedCards: readonly ProgramCard[],
  now: number,
  timeZone: string | null,
): string[] {
  const { start, end } = weekRange(today);
  const dates = [
    ...plan.map(itemDate),
    ...trackedCards.map((c) => nextDeadline(c, now, timeZone)?.date ?? null),
  ].filter((d): d is string => d !== null && compareIsoDates(d, start) >= 0 && compareIsoDates(d, end) <= 0);
  return [...new Set(dates)];
}

/** What a Home tile can show for the queries it depends on. */
export type TileState = "loading" | "error" | "ready";

interface QueryLike {
  readonly isPending: boolean;
  readonly isError: boolean;
}

/**
 * A tile is ready only when every query it reads has data. An error wins over loading so a
 * failed Tracker is reported at once, even while Programs is still on its way.
 */
export function tileState(...queries: readonly QueryLike[]): TileState {
  if (queries.some((q) => q.isError)) return "error";
  if (queries.some((q) => q.isPending)) return "loading";
  return "ready";
}
