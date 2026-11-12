import { epochDayOf, isoFromEpochDay, weekdayOfEpochDay } from "../calendar";
import { OUTCOMES_CONFIG } from "./config";

/**
 * The one date check for Outcome reports (plan 7.8), called by the validators, the quality job
 * and the decision prompt. It reads only curated cycle facts: never an Outcome-derived event or a
 * prediction built on one, so reports cannot widen the window that validates them.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date `YYYY-MM-DD` (not just the shape). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  try {
    return isoFromEpochDay(epochDayOf(value)) === value;
  } catch {
    return false;
  }
}

export function addDaysIso(date: string, days: number): string {
  return isoFromEpochDay(epochDayOf(date) + days);
}

export function daysBetweenIso(a: string, b: string): number {
  return epochDayOf(b) - epochDayOf(a);
}

/** Monday of the ISO week holding `date`: reports are stored to the day and shown by week. */
export function weekStartOf(date: string): string {
  const day = epochDayOf(date);
  return isoFromEpochDay(day - (weekdayOfEpochDay(day) - 1));
}

/** Curated cycle facts the window reads (program_cycles columns; no Outcome-derived field). */
export interface DecisionWindowCycle {
  readonly decisionWindowStart: string | null;
  readonly decisionWindowEnd: string | null;
  /**
   * An official announcement date, only from an official source a Curator verified. Never the
   * `decisions_released` event, which can fire on a released Outcome total.
   */
  readonly officialAnnouncementOn?: string | null;
}

export type WindowBasis = "curated" | "round_deadline" | "unbounded";

export interface WindowCheck {
  readonly ok: boolean;
  readonly basis: WindowBasis;
  /** The accepted range, inclusive; `from` null when unbounded below. */
  readonly from: string | null;
  readonly to: string;
  readonly reason: "ok" | "future" | "before_window" | "after_window" | "before_round_deadline" | "invalid_date";
}

/** The curated range [start − 7, end + 21], or null when the cycle has no curated dates. */
export function curatedWindow(cycle: DecisionWindowCycle): { from: string; to: string } | null {
  const start = cycle.decisionWindowStart ?? cycle.officialAnnouncementOn ?? cycle.decisionWindowEnd ?? null;
  const end = cycle.decisionWindowEnd ?? cycle.officialAnnouncementOn ?? cycle.decisionWindowStart ?? null;
  if (!start || !end || !isCalendarDate(start) || !isCalendarDate(end)) return null;
  const lo = start <= end ? start : end;
  const hi = start <= end ? end : start;
  return { from: addDaysIso(lo, -OUTCOMES_CONFIG.window.daysBefore), to: addDaysIso(hi, OUTCOMES_CONFIG.window.daysAfter) };
}

/**
 * inDecisionWindow(cycle, date): accepts dates from 7 days before a curated decision window (or
 * an official announcement) to 21 days after its end, never in the future. Without either, it
 * accepts dates from the student's round deadline to today.
 */
export function inDecisionWindow(cycle: DecisionWindowCycle, date: string, today: string, roundDeadline: string | null = null): WindowCheck {
  if (!isCalendarDate(date) || !isCalendarDate(today)) return { ok: false, basis: "unbounded", from: null, to: today, reason: "invalid_date" };
  const curated = curatedWindow(cycle);
  if (curated) {
    const to = curated.to < today ? curated.to : today;
    if (date > today) return { ok: false, basis: "curated", from: curated.from, to, reason: "future" };
    if (date < curated.from) return { ok: false, basis: "curated", from: curated.from, to, reason: "before_window" };
    if (date > curated.to) return { ok: false, basis: "curated", from: curated.from, to, reason: "after_window" };
    return { ok: true, basis: "curated", from: curated.from, to, reason: "ok" };
  }
  if (date > today) return { ok: false, basis: roundDeadline ? "round_deadline" : "unbounded", from: roundDeadline, to: today, reason: "future" };
  if (roundDeadline && isCalendarDate(roundDeadline)) {
    if (date < roundDeadline) return { ok: false, basis: "round_deadline", from: roundDeadline, to: today, reason: "before_round_deadline" };
    return { ok: true, basis: "round_deadline", from: roundDeadline, to: today, reason: "ok" };
  }
  return { ok: true, basis: "unbounded", from: null, to: today, reason: "ok" };
}

/** The expected decision date: the curated window's end, else its start, else an official announcement. */
export function expectedDecisionDate(cycle: DecisionWindowCycle): string | null {
  const d = cycle.decisionWindowEnd ?? cycle.decisionWindowStart ?? cycle.officialAnnouncementOn ?? null;
  return d && isCalendarDate(d) ? d : null;
}

/**
 * True once the curated window has fully passed (its end + 21 days), which is when a
 * `no_response` reads as "not selected". Unknown windows never close, so no_response stays out.
 */
export function decisionWindowClosed(cycle: DecisionWindowCycle, today: string): boolean {
  const curated = curatedWindow(cycle);
  return curated !== null && isCalendarDate(today) && today > curated.to;
}

/** The day the one "Did you hear back?" prompt becomes due: 3 days after the expected decision. */
export function outcomePromptDueOn(cycle: DecisionWindowCycle): string | null {
  const expected = expectedDecisionDate(cycle);
  return expected ? addDaysIso(expected, OUTCOMES_CONFIG.promptAfterDays) : null;
}

/** Whether a report may still be edited: until 60 days after its decision (always while undecided). */
export function outcomeEditable(decidedOn: string | null, today: string): boolean {
  if (!decidedOn || !isCalendarDate(decidedOn) || !isCalendarDate(today)) return true;
  return daysBetweenIso(decidedOn, today) <= OUTCOMES_CONFIG.editWindowDays;
}
