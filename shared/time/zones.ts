import { formatIsoDate, parseIsoDate, parseLocalTime, type CalendarDate, type LocalTime } from "./iso";

/**
 * IANA time-zone math on top of Intl, so the browser, the Worker and Node agree without a
 * time-zone library. All instants are UTC epoch milliseconds.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();
const HALF_DAY_MS = 43_200_000;

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export interface ZonedParts extends CalendarDate, LocalTime {
  readonly millisecond: number;
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
    millisecond: ((ms % 1000) + 1000) % 1000,
  };
}

/** Offset of a zone from UTC at an instant, in milliseconds (America/Chicago in January: -6 h). */
export function zoneOffsetMs(ms: number, timeZone: string): number {
  const p = zonedParts(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, p.millisecond);
  return asUtc - ms;
}

/**
 * The instant at which a wall-clock time occurs in a zone. In a spring-forward gap the result
 * moves forward by the gap; in a fall-back overlap it takes the earlier instant.
 */
export function zonedLocalToInstant(
  date: CalendarDate,
  time: LocalTime & { millisecond?: number },
  timeZone: string,
): number {
  const wallAsUtc = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, time.second, time.millisecond ?? 0);
  // Offsets half a day either side bracket any single transition (zones change at most once a day).
  const offsetBefore = zoneOffsetMs(wallAsUtc - HALF_DAY_MS, timeZone);
  const offsetAfter = zoneOffsetMs(wallAsUtc + HALF_DAY_MS, timeZone);
  const candidates = [wallAsUtc - offsetBefore, wallAsUtc - offsetAfter];
  const valid = candidates.filter((c) => zoneOffsetMs(c, timeZone) === wallAsUtc - c);
  if (valid.length > 0) return Math.min(...valid); // overlap: earlier instant
  return wallAsUtc - offsetBefore; // gap: shift forward by the gap, like Temporal's "compatible"
}

/** Convenience form taking `YYYY-MM-DD` and `HH:MM[:SS]` strings. */
export function localDateTimeToInstant(localDate: string, localTime: string, timeZone: string): number {
  const d = parseIsoDate(localDate);
  const t = parseLocalTime(localTime);
  if (!d || !t) throw new RangeError(`invalid local date or time: ${localDate} ${localTime}`);
  return zonedLocalToInstant(d, t, timeZone);
}

/** The last millisecond of a calendar day in a zone (23:59:59.999 local). */
export function endOfLocalDay(localDate: string, timeZone: string): number {
  const d = parseIsoDate(localDate);
  if (!d) throw new RangeError(`invalid ISO date: ${localDate}`);
  return zonedLocalToInstant(d, { hour: 23, minute: 59, second: 59, millisecond: 999 }, timeZone);
}

/** Today's calendar date in a zone. */
export function localDateIn(ms: number, timeZone: string): string {
  return formatIsoDate(zonedParts(ms, timeZone));
}

/** `HH:MM` wall-clock time of an instant in a zone. */
export function localTimeIn(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** Short zone name such as "CST" or "GMT-6" for display beside a time. */
export function zoneAbbreviation(ms: number, timeZone: string, locale = "en-US"): string {
  const parts = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "short" }).formatToParts(new Date(ms));
  return parts.find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}
