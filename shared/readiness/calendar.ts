import { DEFAULT_BLACKOUT_RULES } from "./config";
import { formatIsoDate, fromEpochDay, parseIsoDate, toEpochDay, daysInMonth, isLeapYear } from "../time/iso";

/**
 * Plain-date helpers for planning: epoch-day conversion, nth-weekday rules, US Thanksgiving,
 * study blackouts and lead times counted in available days. Dates are `YYYY-MM-DD` strings and
 * never pass through `new Date("YYYY-MM-DD")`.
 */

export type IsoDate = string;

export function epochDayOf(date: IsoDate): number {
  const d = parseIsoDate(date);
  if (!d) throw new RangeError(`invalid ISO date: ${date}`);
  return toEpochDay(d);
}

export function isoFromEpochDay(day: number): IsoDate {
  return formatIsoDate(fromEpochDay(day));
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

/** ISO weekday of an epoch day: Monday = 1 ... Sunday = 7 (1970-01-01 was a Thursday). */
export function weekdayOfEpochDay(day: number): number {
  return (((day + 3) % 7) + 7) % 7 + 1;
}

/**
 * The nth `weekday` (1 = Monday ... 7 = Sunday) of a month; nth = -1 is the last one.
 * Returns null when the month has no such day (a fifth Monday, for example).
 */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): IsoDate | null {
  if (nth === -1) {
    const last = toEpochDay({ year, month, day: daysInMonth(year, month) });
    const back = (weekdayOfEpochDay(last) - weekday + 7) % 7;
    return isoFromEpochDay(last - back);
  }
  if (nth < 1 || nth > 5) return null;
  const first = toEpochDay({ year, month, day: 1 });
  const forward = (weekday - weekdayOfEpochDay(first) + 7) % 7;
  const day = 1 + forward + (nth - 1) * 7;
  return day <= daysInMonth(year, month) ? formatIsoDate({ year, month, day }) : null;
}

/** US Thanksgiving: the fourth Thursday of November. */
export function usThanksgiving(year: number): IsoDate {
  return nthWeekdayOfMonth(year, 11, 4, 4)!;
}

/** The same month and day in another year; 29 February becomes 28 February in common years. */
export function sameMonthDayInYear(date: IsoDate, year: number): IsoDate {
  const d = parseIsoDate(date);
  if (!d) throw new RangeError(`invalid ISO date: ${date}`);
  const day = d.month === 2 && d.day === 29 && !isLeapYear(year) ? 28 : d.day;
  return formatIsoDate({ year, month: d.month, day });
}

/** The date in `year` with the same weekday as `date`, nearest to its month and day. */
export function sameWeekdayNear(date: IsoDate, year: number): IsoDate {
  const target = epochDayOf(sameMonthDayInYear(date, year));
  const wanted = weekdayOfEpochDay(epochDayOf(date));
  let shift = wanted - weekdayOfEpochDay(target);
  if (shift > 3) shift -= 7;
  if (shift < -3) shift += 7;
  return isoFromEpochDay(target + shift);
}

export interface BlackoutPeriod {
  /** Inclusive dates. */
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly label: string;
}

/** Default US study blackouts (Thanksgiving Wed-Sun, 22 Dec-2 Jan) for the academic years touching [fromYear, toYear]. */
export function defaultBlackouts(fromYear: number, toYear: number): BlackoutPeriod[] {
  const out: BlackoutPeriod[] = [];
  const { thanksgiving, winter } = DEFAULT_BLACKOUT_RULES;
  for (let year = fromYear - 1; year <= toYear; year++) {
    const tg = epochDayOf(usThanksgiving(year));
    out.push({
      start: isoFromEpochDay(tg + thanksgiving.fromOffsetDays),
      end: isoFromEpochDay(tg + thanksgiving.toOffsetDays),
      label: "Thanksgiving break",
    });
    out.push({
      start: formatIsoDate({ year, month: winter.from.month, day: winter.from.day }),
      end: formatIsoDate({ year: year + 1, month: winter.to.month, day: winter.to.day }),
      label: "Winter break",
    });
  }
  return out;
}

/** Epoch days covered by blackout periods, for O(1) lookups in day-by-day walks. */
export function blackoutDaySet(periods: readonly BlackoutPeriod[]): Set<number> {
  const days = new Set<number>();
  for (const p of periods) {
    const from = epochDayOf(p.start);
    const to = epochDayOf(p.end);
    for (let d = from; d <= to; d++) days.add(d);
  }
  return days;
}

/**
 * Counts `days` available days back from `date` (exclusive), skipping blackout days: a 21-day
 * recommender lead before 8 Jan 2027 lands on 6 Dec 2026 instead of 18 Dec, because faculty are
 * away over the winter break.
 */
export function subtractAvailableDays(date: IsoDate, days: number, blackout: ReadonlySet<number>): IsoDate {
  let day = epochDayOf(date);
  let counted = 0;
  let guard = 0;
  while (counted < days && guard < 3 * 366) {
    day -= 1;
    guard += 1;
    if (!blackout.has(day)) counted += 1;
  }
  return isoFromEpochDay(day);
}
