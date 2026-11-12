import { isIsoDate, isIsoMonth, parseIsoInstant } from "@shared/time";

/**
 * Display formatting. Dates on the wire are calendar dates (`YYYY-MM-DD`) that already mean the
 * right day for the viewer, so they are formatted at noon UTC with timeZone UTC: that can never
 * slip a day whatever zone the browser is in.
 */

const LOCALE = "en-US";

function noonUtc(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00Z`);
}

/** "Fri, Dec 4" */
export function formatDay(isoDate: string): string {
  if (!isIsoDate(isoDate)) return isoDate;
  return new Intl.DateTimeFormat(LOCALE, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(noonUtc(isoDate));
}

/** "Tuesday, November 10, 2026" */
export function formatLongDate(isoDate: string): string {
  if (!isIsoDate(isoDate)) return isoDate;
  return new Intl.DateTimeFormat(LOCALE, { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(noonUtc(isoDate));
}

/** "Dec 4" for dates, "December 2026" for month-only values. */
export function formatShortDate(value: string): string {
  if (isIsoDate(value)) {
    return new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric", timeZone: "UTC" }).format(noonUtc(value));
  }
  if (isIsoMonth(value)) {
    return new Intl.DateTimeFormat(LOCALE, { month: "long", year: "numeric", timeZone: "UTC" }).format(noonUtc(`${value}-15`));
  }
  return value;
}

/** "17:00" -> "5:00 PM" */
export function formatLocalTime(hhmm: string): string {
  const m = /^(\d{2}):(\d{2})/.exec(hhmm);
  if (!m) return hhmm;
  const hour = Number(m[1]);
  const suffix = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${m[2]} ${suffix}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "just now", "3h ago", "2d ago", "1w ago", or a short date for anything older than 8 weeks. */
export function formatAgo(isoInstant: string, now: number): string {
  const at = parseIsoInstant(isoInstant);
  if (at === null) return "";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 60) return minutes < 2 ? "just now" : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks <= 8) return `${weeks}w ago`;
  return formatShortDate(new Date(at).toISOString().slice(0, 10));
}

const PERIOD_LABEL: Record<string, string> = {
  hour: "/hr",
  week: "/wk",
  month: "/mo",
  term: "/term",
  year: "/yr",
  one_time: "",
  total: "",
};

/** "$32/hr", "$7,500" */
export function formatMoney(cents: number, period: string | null): string {
  const dollars = cents / 100;
  const text = new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Number.isInteger(dollars) ? 0 : 2,
  }).format(dollars);
  return `${text}${period ? PERIOD_LABEL[period] ?? "" : ""}`;
}

/** "fall-2026" -> "Fall 2026" */
export function formatTermLabel(termKey: string): string {
  const m = /^(winter|spring|summer|fall)-(\d{4})$/.exec(termKey);
  if (!m) return termKey;
  const term = m[1] as string;
  return `${term.charAt(0).toUpperCase()}${term.slice(1)} ${m[2]}`;
}

/** The first name to greet with, or null when the profile has none. */
export function firstName(displayName: string | null | undefined): string | null {
  const name = displayName?.trim().split(/\s+/)[0];
  return name ? name : null;
}
