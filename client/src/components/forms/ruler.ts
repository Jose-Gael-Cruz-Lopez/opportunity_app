import { daysBetween } from "@shared/time";

/**
 * Math for the countdown ruler card: where "today" sits inside an application window, and how
 * many days are left. Dates are ISO calendar dates in the viewer's zone; the caller resolves the
 * deadline instant to a local date first (shared/time's resolveDeadlineForViewer).
 */

export interface RulerInput {
  /** Day the window opened; null when unknown (the ruler then counts back a default span). */
  readonly opensOn: string | null;
  readonly dueOn: string;
  readonly today: string;
  /** Span to draw when the opening date is unknown. */
  readonly fallbackWindowDays?: number;
}

export interface RulerPosition {
  /** 0..1, how far through the window today is (clamped). */
  readonly fraction: number;
  /** Whole days until the due date; negative once it has passed. */
  readonly daysLeft: number;
  /** Day number of today inside the window (1-based, clamped to the window). */
  readonly dayOfWindow: number;
  readonly windowDays: number;
  readonly openedKnown: boolean;
}

export function rulerPosition(input: RulerInput): RulerPosition {
  const fallback = Math.max(1, input.fallbackWindowDays ?? 90);
  const openedKnown = input.opensOn !== null && daysBetween(input.opensOn, input.dueOn) > 0;
  const windowDays = openedKnown ? daysBetween(input.opensOn as string, input.dueOn) : fallback;
  const daysLeft = daysBetween(input.today, input.dueOn);
  const elapsed = windowDays - daysLeft;
  const fraction = Math.min(1, Math.max(0, elapsed / windowDays));
  const dayOfWindow = Math.min(windowDays, Math.max(1, elapsed));
  return { fraction, daysLeft, dayOfWindow, windowDays, openedKnown };
}

/** Tick marks for the ruler: `count` ticks with a major tick every `majorEvery`. */
export function rulerTicks(count = 33, majorEvery = 4): readonly boolean[] {
  const n = Math.max(2, Math.floor(count));
  const every = Math.max(1, Math.floor(majorEvery));
  return Array.from({ length: n }, (_, i) => i % every === 0);
}

/** Words for screen readers and captions: "24 days left", "Due today", "Closed 3 days ago". */
export function daysLeftLabel(daysLeft: number): string {
  if (daysLeft > 1) return `${daysLeft} days left`;
  if (daysLeft === 1) return "1 day left";
  if (daysLeft === 0) return "Due today";
  const ago = -daysLeft;
  return ago === 1 ? "Closed yesterday" : `Closed ${ago} days ago`;
}
