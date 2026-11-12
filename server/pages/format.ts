import { addDays, MS_PER_DAY, parseIsoDate, parseIsoMonth, zonedParts, zoneAbbreviation } from "@shared/time";

/**
 * Display formatting for public pages. Published dates are calendar values, so they are formatted
 * from their parts and never through `new Date("YYYY-MM-DD")` (which parses as UTC midnight and
 * shows the day before in the Americas, the prototype's bug).
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTHS_LONG = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/** Day of week for a calendar date (Zeller-free: a UTC date of the same parts has the same weekday). */
function weekdayOf(year: number, month: number, day: number): string {
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
}

/** "Fri 15 Jan 2027" (or "15 Jan 2027" without the weekday). Returns the input when it is not a date. */
export function formatDate(isoDate: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const d = parseIsoDate(isoDate);
  if (!d) return isoDate;
  const parts = [`${d.day} ${MONTHS[d.month - 1]}`];
  if (opts.year !== false) parts.push(String(d.year));
  const body = parts.join(" ");
  return opts.weekday === false ? body : `${weekdayOf(d.year, d.month, d.day)} ${body}`;
}

/** "December 2026" for a `YYYY-MM` (or the month of a `YYYY-MM-DD`). */
export function formatMonth(isoMonthOrDate: string): string {
  const m = parseIsoMonth(isoMonthOrDate.slice(0, 7));
  return m ? `${MONTHS_LONG[m.month - 1]} ${m.year}` : isoMonthOrDate;
}

/** "Jan 2027" for a `YYYY-MM` (or the month of a `YYYY-MM-DD`). */
export function formatMonthShort(isoMonthOrDate: string): string {
  const m = parseIsoMonth(isoMonthOrDate.slice(0, 7));
  return m ? `${MONTHS[m.month - 1]} ${m.year}` : isoMonthOrDate;
}

/** "11:59 PM" for "23:59"; "12:00 PM" for noon. */
export function formatTime12(hhmm: string): string {
  const match = /^(\d{2}):(\d{2})/.exec(hhmm);
  if (!match) return hhmm;
  const hour = Number(match[1]);
  const suffix = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${match[2]} ${suffix}`;
}

/**
 * Short zone names students recognise. Intl gives "EST" or "GMT-5" depending on the runtime's
 * ICU data, so the common US zones are named here and everything else falls back to Intl.
 */
const ZONE_NAMES: Readonly<Record<string, string>> = {
  "America/New_York": "ET",
  "America/Detroit": "ET",
  "America/Chicago": "CT",
  "America/Denver": "MT",
  "America/Phoenix": "MST",
  "America/Los_Angeles": "PT",
  "America/Anchorage": "AKT",
  "Pacific/Honolulu": "HT",
  "America/Puerto_Rico": "AST",
  "Europe/London": "UK time",
};

export function zoneLabel(timeZone: string, atMs: number): string {
  const named = ZONE_NAMES[timeZone];
  if (named) return named;
  try {
    return zoneAbbreviation(atMs, timeZone);
  } catch {
    return timeZone;
  }
}

/** Calendar date (`YYYY-MM-DD`) of an instant in a zone. */
export function isoDateIn(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The day before a published date, for "Time not stated: plan to submit by …". */
export function dayBefore(isoDate: string): string {
  return addDays(isoDate, -1);
}

/**
 * Whole days left until an instant, counted up (a deadline 30 hours away is "2 days"), never
 * negative. Day counts are coarse on purpose: cached HTML may be up to five minutes old.
 */
export function daysUntil(targetMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((targetMs - nowMs) / MS_PER_DAY));
}

/** "$7,500" for whole dollars, "$18.50" otherwise. */
export function formatMoney(cents: number): string {
  const dollars = cents / 100;
  const whole = Number.isInteger(dollars);
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** "today", "yesterday", "5 days ago", "3 weeks ago", "4 months ago" between two calendar dates. */
export function relativeAge(isoDate: string, todayIso: string): string {
  const from = parseIsoDate(isoDate);
  const to = parseIsoDate(todayIso);
  if (!from || !to) return "";
  const days = Math.round((Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) / MS_PER_DAY);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/** Joins a list as "a, b and c". */
export function joinList(items: readonly string[], conjunction = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/** At most `max` words, with an ellipsis when cut (public excerpts are limited to 25 words). */
export function clampWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? text.trim() : `${words.slice(0, max).join(" ")}…`;
}

/** "1 program" / "3 programs". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
