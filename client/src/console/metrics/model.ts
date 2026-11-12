import type { AdminMetricsView, Cell, FunnelStep, Rate } from "./api";

/** Pure formatting for the metrics page; the page renders what these return. */

export const HIDDEN_TEXT = "fewer than 5";

export const STEP_LABELS: Record<FunnelStep, string> = {
  started: "Onboarding started",
  quiz_completed: "Quiz done",
  resume_parsed: "Resume read on device",
  matches_shown: "Matches shown",
  first_door_chosen: "First door chosen",
  first_step_done: "First step done",
  tracker_created: "Saved to Tracker",
};

export const STATUS_LABELS: Record<string, string> = {
  interested: "Interested",
  applying: "Applying",
  submitted: "Submitted",
  decided: "Decided",
  not_applying: "Not applying",
};

const NUMBER = new Intl.NumberFormat("en-US");

export function countText(c: Cell): string {
  return c.n === null ? HIDDEN_TEXT : NUMBER.format(c.n);
}

/** A share as a whole percent ("75%"), or an en dash when it cannot be computed. */
export function rateText(r: Rate): string {
  return r === null ? "–" : `${Math.round(r * 100)}%`;
}

/** Bar length in percent of the largest shown value; hidden cells get no bar. */
export function barPercent(c: Cell, max: number): number {
  if (c.n === null || max <= 0) return 0;
  return Math.max(c.n > 0 ? 1 : 0, Math.min(100, Math.round((c.n / max) * 100)));
}

export function maxShown(cells: readonly Cell[]): number {
  return cells.reduce((m, c) => (c.n !== null && c.n > m ? c.n : m), 0);
}

/** "Nov 9" for a YYYY-MM-DD week start (UTC). */
export function weekLabel(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * Retention cell shade: 0-100 percent of the accent mixed into the surface, in steps of 10 so
 * close rates read alike. Text switches to the dark ink when the fill gets light.
 */
export function retentionShade(r: Rate): { mix: number; darkText: boolean } | null {
  if (r === null) return null;
  const mix = Math.round(Math.min(1, Math.max(0, r)) * 10) * 10;
  return { mix: Math.max(mix, 10), darkText: mix >= 60 };
}

export type FreshnessTone = "good" | "late" | "none";

/** Median days since verification against the plan's target (under 14, REQ-022). */
export function freshnessTone(median: number | null, target: number): FreshnessTone {
  if (median === null) return "none";
  return median < target ? "good" : "late";
}

export function daysText(d: number | null): string {
  if (d === null) return "–";
  return `${d % 1 === 0 ? d : d.toFixed(1)} d`;
}

/** What the page says above the event-based sections when they cannot have data yet. */
export function ingestNotice(view: AdminMetricsView): string | null {
  if (view.ingest.eventsDb === "unbound") return "The events database is not bound here, so the funnel reads empty and retention is not measured.";
  if (view.ingest.eventRows === 0)
    return "No analytics events are recorded yet, so the funnel reads empty. Events arrive once students use onboarding with analytics allowed; Tracker, reminder and registry numbers below are live.";
  return null;
}

/** Why the retention table is absent: events are keyed by browsing session, never by person. */
export const RETENTION_NOT_MEASURED =
  "Not measured. Analytics events carry only a browsing-session id (rotated after 30 idle minutes), never an account, so no one can be followed from week to week. Retention needs a founder decision on a consented, keyed actor or a count from account activity.";

/** Note under the funnel: its actor is a browsing session, not a person. */
export const FUNNEL_ACTOR_NOTE =
  "Counted per browsing session: a student who pauses for more than 30 minutes and comes back starts a new funnel, so later steps are undercounted.";

export function timeText(iso: string | null): string {
  return iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "never";
}
