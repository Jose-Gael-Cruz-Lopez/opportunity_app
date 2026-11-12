import type { DeadlineView, ProgramCard } from "@shared/contracts/registry";
import { PRODUCT } from "@shared/config/product";
import { addDays, compareIsoDates, daysBetween, isIsoDate, localDateIn, resolveDeadlineForViewer, type ViewerDeadline } from "@shared/time";

/**
 * Deadline view logic shared by Home, Explore and the Tracker. Deterministic and pure: every
 * function takes `now` and the viewer's zone, so tests pin them and screens agree.
 */

/** Deadline kinds that are something to submit (not decision dates or start dates). */
const ACTIONABLE_KINDS: ReadonlySet<DeadlineView["kind"]> = new Set([
  "application",
  "campus_internal",
  "nomination",
  "priority_round",
  "recommendation",
  "supplemental",
  "interest_form",
]);

export function viewerZone(timeZone: string | null | undefined): string {
  return timeZone ?? PRODUCT.fallbackTimeZone;
}

export function viewerToday(now: number, timeZone: string | null | undefined): string {
  return localDateIn(now, viewerZone(timeZone));
}

export interface UpcomingDeadline {
  readonly deadline: DeadlineView;
  readonly viewer: ViewerDeadline;
  /** The viewer-local calendar date the deadline falls on. */
  readonly date: string;
  /** Whole days from today to that date (0 = today). */
  readonly daysLeft: number;
}

/**
 * The next deadline the student has to act on. Campus and nomination steps count, so a
 * nomination-gated program surfaces its earlier campus date rather than the national one.
 * Rolling and TBD rows have no date and are skipped.
 */
export function nextDeadline(card: Pick<ProgramCard, "deadlines">, now: number, timeZone: string | null | undefined): UpcomingDeadline | null {
  const zone = viewerZone(timeZone);
  const today = localDateIn(now, zone);
  let best: UpcomingDeadline | null = null;
  for (const d of card.deadlines) {
    if (!ACTIONABLE_KINDS.has(d.kind)) continue;
    const viewer = resolveDeadlineForViewer(d, zone);
    if (viewer.instant !== null && viewer.instant < now) continue;
    const date = viewer.viewerLocalDate;
    if (!date || !isIsoDate(date) || compareIsoDates(date, today) < 0) continue;
    const candidate = { deadline: d, viewer, date, daysLeft: daysBetween(today, date) };
    if (!best || compareIsoDates(candidate.date, best.date) < 0) best = candidate;
  }
  return best;
}

export type StatusTone = "open" | "soon" | "off" | "predicted";

export interface CardStatus {
  readonly tone: StatusTone;
  /** Short label for the tag ("12 days left", "Opens Dec 1", "Rolling", "Closed"). */
  readonly label: string;
  readonly next: UpcomingDeadline | null;
}

/** Deadlines inside this many days read as "closing soon". */
export const SOON_DAYS = 14;

export function cardStatus(card: ProgramCard, now: number, timeZone: string | null | undefined): CardStatus {
  const today = viewerToday(now, timeZone);
  const next = nextDeadline(card, now, timeZone);
  if (card.status === "open") {
    if (next) {
      const label = next.daysLeft === 0 ? "Due today" : next.daysLeft === 1 ? "1 day left" : `${next.daysLeft} days left`;
      return { tone: next.daysLeft <= SOON_DAYS ? "soon" : "open", label, next };
    }
    return { tone: "open", label: card.deadlines.length === 0 ? "Rolling" : "Open", next: null };
  }
  if (card.status === "expected") {
    if (card.opensOn && compareIsoDates(card.opensOn, today) > 0) {
      return { tone: "soon", label: `Opens ${shortMonthDay(card.opensOn)}`, next: null };
    }
    if (card.prediction) return { tone: "predicted", label: `Expected ${shortMonthDay(card.prediction.p10)}`, next: null };
    return { tone: "predicted", label: "Dates expected", next: null };
  }
  if (card.status === "paused") return { tone: "off", label: "Paused", next: null };
  if (card.status === "ended") return { tone: "off", label: "Ended", next: null };
  return { tone: "off", label: "Closed", next: null };
}

function shortMonthDay(isoDate: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${isoDate}T12:00:00Z`));
}

/**
 * Sort key for "soonest deadline first": open cards with a date by that date, then rolling open
 * cards, then cards that open later, then closed ones. Ties break by name so the order is stable.
 */
export function compareBySoonest(a: ProgramCard, b: ProgramCard, now: number, timeZone: string | null | undefined): number {
  const rank = (card: ProgramCard): [number, string] => {
    const next = nextDeadline(card, now, timeZone);
    if (card.status === "open" && next) return [0, next.date];
    if (card.status === "open") return [1, ""];
    if (card.status === "expected") return [2, card.opensOn ?? card.prediction?.p10 ?? "9999-12-31"];
    return [3, ""];
  };
  const [ra, da] = rank(a);
  const [rb, db] = rank(b);
  if (ra !== rb) return ra - rb;
  if (da !== db) return compareIsoDates(da, db);
  return a.name.localeCompare(b.name);
}

export interface Countdown {
  /** Which step the countdown is for; campus steps come before the national date. */
  readonly scope: DeadlineView["scope"];
  readonly kind: DeadlineView["kind"];
  readonly daysLeft: number;
  readonly dueDate: string;
  readonly dueTime: string | null;
  readonly timeZoneLabel: string | null;
  /** Window start shown at the ruler's left end. */
  readonly openedOn: string;
  /** Position of today inside the window, 0..1. */
  readonly progress: number;
  /** Window length in days (for the accessible description). */
  readonly windowDays: number;
  /** Day number of today inside the window, 1-based. */
  readonly dayOfWindow: number;
}

/** Fallback window when a card has no opening date: the ruler then shows the last 90 days. */
const DEFAULT_WINDOW_DAYS = 90;

export function countdownFor(card: ProgramCard, now: number, timeZone: string | null | undefined): Countdown | null {
  const next = nextDeadline(card, now, timeZone);
  if (!next) return null;
  const today = viewerToday(now, timeZone);
  let openedOn = card.opensOn && compareIsoDates(card.opensOn, today) <= 0 ? card.opensOn : addDays(next.date, -DEFAULT_WINDOW_DAYS);
  if (compareIsoDates(openedOn, next.date) >= 0) openedOn = addDays(next.date, -1);
  const windowDays = Math.max(1, daysBetween(openedOn, next.date));
  const elapsed = Math.min(windowDays, Math.max(0, daysBetween(openedOn, today)));
  return {
    scope: next.deadline.scope,
    kind: next.deadline.kind,
    daysLeft: next.daysLeft,
    dueDate: next.date,
    dueTime: next.viewer.viewerLocalTime,
    timeZoneLabel: next.viewer.applicantLocal ? "your time" : null,
    openedOn,
    progress: elapsed / windowDays,
    windowDays,
    dayOfWindow: elapsed + 1,
  };
}
