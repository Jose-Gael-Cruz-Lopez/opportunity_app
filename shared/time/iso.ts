/**
 * Calendar-date helpers that never parse a published date as an instant. `new Date("2027-01-29")`
 * is midnight UTC, which shows as the previous day in every US zone; everything here works on
 * plain year/month/day numbers instead.
 */

export const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
export const ISO_MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
export const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

export interface CalendarDate {
  readonly year: number;
  readonly month: number; // 1-12
  readonly day: number; // 1-31
}

export interface LocalTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/** Parses `YYYY-MM-DD` into numbers, or returns null for a malformed or impossible date. */
export function parseIsoDate(value: string): CalendarDate | null {
  const m = ISO_DATE_PATTERN.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

export function isIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}

/** Parses `YYYY-MM` (month-only published dates). */
export function parseIsoMonth(value: string): { year: number; month: number } | null {
  const m = ISO_MONTH_PATTERN.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? { year, month } : null;
}

export function isIsoMonth(value: string): boolean {
  return parseIsoMonth(value) !== null;
}

export function parseLocalTime(value: string): LocalTime | null {
  const m = LOCAL_TIME_PATTERN.exec(value);
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]), second: m[3] ? Number(m[3]) : 0 };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

export function formatIsoDate(d: CalendarDate): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

/** Day number since 1970-01-01 for a calendar date (UTC arithmetic on dates only, no zones). */
export function toEpochDay(d: CalendarDate): number {
  return Math.floor(Date.UTC(d.year, d.month - 1, d.day) / MS_PER_DAY);
}

export function fromEpochDay(epochDay: number): CalendarDate {
  const dt = new Date(epochDay * MS_PER_DAY);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

function requireDate(value: string): CalendarDate {
  const d = parseIsoDate(value);
  if (!d) throw new RangeError(`invalid ISO date: ${value}`);
  return d;
}

export function addDays(isoDate: string, days: number): string {
  return formatIsoDate(fromEpochDay(toEpochDay(requireDate(isoDate)) + days));
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  return toEpochDay(requireDate(b)) - toEpochDay(requireDate(a));
}

export function compareIsoDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0; // lexical order equals calendar order for YYYY-MM-DD
}

export function minIsoDate(...dates: readonly string[]): string | null {
  return dates.length === 0 ? null : dates.reduce((m, d) => (d < m ? d : m));
}

export function lastDayOfMonth(year: number, month: number): string {
  return formatIsoDate({ year, month, day: daysInMonth(year, month) });
}

/** ISO weekday, Monday = 1 ... Sunday = 7. */
export function isoWeekday(isoDate: string): number {
  const day = new Date(toEpochDay(requireDate(isoDate)) * MS_PER_DAY).getUTCDay();
  return day === 0 ? 7 : day;
}

/** `2027-01-29T23:00:00.000Z` for an epoch-millisecond instant. */
export function toIsoInstant(ms: number): string {
  return new Date(ms).toISOString();
}

/** Parses an ISO 8601 instant that carries a zone designator (Z or ±hh:mm). */
export function parseIsoInstant(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}
