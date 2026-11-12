import { PRODUCT } from "../config/product";
import { daysBetween, parseIsoDate, parseIsoInstant } from "../time/iso";
import { isValidTimeZone, localDateIn } from "../time/zones";

/**
 * Time inputs for onboarding. Callers pass `now` as a Date, epoch milliseconds or an ISO
 * instant; the student's calendar day comes from their zone (the browser's, else the product
 * fallback), because "days left" must match what the student sees on their own clock.
 */

export type NowInput = Date | number | string;

export function toEpochMs(now: NowInput): number {
  if (typeof now === "number") return now;
  if (now instanceof Date) return now.getTime();
  const ms = parseIsoInstant(now);
  if (ms === null) throw new RangeError("now must be an ISO 8601 instant with a zone");
  return ms;
}

export function resolveZone(timeZone: string | null | undefined): string {
  return timeZone && isValidTimeZone(timeZone) ? timeZone : PRODUCT.fallbackTimeZone;
}

/** The student's calendar date at `now`. */
export function todayIn(nowMs: number, timeZone: string | null | undefined): string {
  return localDateIn(nowMs, resolveZone(timeZone));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Dec 2", or "Dec 2, 2027" when the year differs from today's. No Intl, so output is identical everywhere. */
export function formatShortDate(isoDate: string, today: string): string {
  const d = parseIsoDate(isoDate);
  if (!d) return isoDate;
  const base = `${MONTHS[d.month - 1]} ${d.day}`;
  return isoDate.slice(0, 4) === today.slice(0, 4) ? base : `${base}, ${d.year}`;
}

/** Whole days from today to a date (negative when the date has passed). */
export function daysFrom(today: string, isoDate: string): number {
  return daysBetween(today, isoDate);
}

/** Max/min of ISO dates (lexical order equals calendar order). */
export function laterDate(a: string, b: string): string {
  return a >= b ? a : b;
}
export function earlierDate(a: string, b: string): string {
  return a <= b ? a : b;
}
