import type { ProgramCard } from "@shared/contracts/registry";
import type { TrackerItem } from "@shared/contracts/student";
import { countdownFor, nextDeadline, type Countdown } from "./deadlines";

/**
 * Counts about the student's own tracker (what they saved, applied to, and what is due). These
 * are activity counts the student controls, not a rating of the student.
 */

export interface TrackedProgram {
  readonly item: TrackerItem;
  readonly card: ProgramCard | null;
}

/** Joins tracker rows to cards by cycle id, falling back to the program slug. */
export function joinTracked(cards: readonly ProgramCard[], tracker: readonly TrackerItem[]): TrackedProgram[] {
  const byCycle = new Map(cards.map((c) => [c.programCycleId, c]));
  const bySlug = new Map(cards.map((c) => [c.slug, c]));
  return tracker.map((item) => ({ item, card: byCycle.get(item.programCycleId) ?? bySlug.get(item.programSlug) ?? null }));
}

/** Statuses that still need work before a deadline. */
function isActive(item: TrackerItem): boolean {
  return item.status === "interested" || item.status === "applying";
}

export interface TrackerSummary {
  /** Everything tracked except programs marked "not applying". */
  readonly tracked: number;
  readonly applying: number;
  readonly submitted: number;
  /** Active programs with a deadline in the next `windowDays` days. */
  readonly dueSoon: number;
  /** Active deadlines per week for the next `weeks` weeks (index 0 = this week). */
  readonly weeklyDue: readonly number[];
  /** The soonest active deadline, for the countdown card. */
  readonly nextUp: { readonly card: ProgramCard; readonly countdown: Countdown } | null;
}

export function summarizeTracker(
  cards: readonly ProgramCard[],
  tracker: readonly TrackerItem[],
  now: number,
  timeZone: string | null | undefined,
  opts: { windowDays?: number; weeks?: number } = {},
): TrackerSummary {
  const windowDays = opts.windowDays ?? 30;
  const weeks = opts.weeks ?? 8;
  const joined = joinTracked(cards, tracker);
  const weeklyDue = Array.from({ length: weeks }, () => 0);
  let dueSoon = 0;
  let nextUp: TrackerSummary["nextUp"] = null;

  for (const { item, card } of joined) {
    if (!card || !isActive(item)) continue;
    const next = nextDeadline(card, now, timeZone);
    if (!next) continue;
    if (next.daysLeft <= windowDays) dueSoon++;
    const week = Math.floor(next.daysLeft / 7);
    if (week < weeks) weeklyDue[week] = (weeklyDue[week] ?? 0) + 1;
    const countdown = countdownFor(card, now, timeZone);
    if (countdown && (!nextUp || countdown.daysLeft < nextUp.countdown.daysLeft)) nextUp = { card, countdown };
  }

  return {
    tracked: tracker.filter((t) => t.status !== "not_applying").length,
    applying: tracker.filter((t) => t.status === "applying").length,
    submitted: tracker.filter((t) => t.status === "submitted" || t.status === "decided").length,
    dueSoon,
    weeklyDue,
    nextUp,
  };
}
