import { PRODUCT } from "@shared/config/product";
import { addDays, isoWeekday, parseIsoDate, toEpochDay } from "@shared/time/iso";
import { isValidTimeZone, localDateIn, localDateTimeToInstant, localTimeIn } from "@shared/time/zones";
import { isQuietTime } from "@server/services/email/policy";

/**
 * Timing rules for scheduled mail (plan 6.7.2, s01 7.2). Pure functions: the clock and the
 * recipient's settings are inputs, so the properties that matter ("never later than planned",
 * "never inside quiet hours", "one weekly email per ISO week") are testable without a database.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * With no known zone, scheduled mail goes at 22:30 UTC: between 08:00 and 22:00 in every US zone
 * (17:30 Eastern standard time, 14:30 Pacific, 12:30 Hawaii, 08:30 next day in Guam).
 */
export const NO_ZONE_SEND_UTC = "22:30";

/** Reminder alerts are written up to this long before they are due; dispatch sends on time. */
export const LOOKAHEAD_MS = HOUR;

/** A non-final reminder more than this late is dropped (plan 6.7.2). */
export const MAX_LATENESS_MS = 24 * HOUR;

/** The recipient's zone for sending: profile, then Institution; null means "none known". */
export function sendZone(...candidates: readonly (string | null | undefined)[]): string | null {
  for (const zone of candidates) if (zone && isValidTimeZone(zone)) return zone;
  return null;
}

/** The zone that turns deadlines into calendar dates when the recipient has none (plan 6.4.5). */
export function planningZone(zone: string | null): string {
  return zone ?? PRODUCT.fallbackTimeZone;
}

/** Today's date for a recipient: their zone, else UTC (the 22:30 UTC rule counts UTC days). */
export function recipientToday(now: number, zone: string | null): string {
  return zone ? localDateIn(now, zone) : new Date(now).toISOString().slice(0, 10);
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

function hhmmOf(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * Moves a planned local send time out of quiet hours. Scheduled sends move earlier, never later
 * (plan 6.7.2): a time inside the window becomes 30 minutes before the window starts, on the same
 * day when the window starts that day, else the evening before (`dayShift: -1`).
 */
export function avoidQuietHours(localTime: string, quiet: readonly [string, string]): { time: string; dayShift: 0 | -1 } {
  const [start, end] = quiet;
  if (!isQuietTime(localTime, start, end)) return { time: localTime, dayShift: 0 };
  const before = minutesOf(start) - 30;
  // A window that wraps midnight and has already begun "yesterday" (e.g. 01:00 in 22:00-08:00).
  const startedYesterday = start > end && localTime < end;
  if (startedYesterday || before < 0) return { time: hhmmOf(before), dayShift: -1 };
  return { time: hhmmOf(before), dayShift: 0 };
}

/**
 * The instant a reminder planned for `localDate` at `localTime` goes out. With a zone, quiet
 * hours apply in that zone; with none, the fixed 22:30 UTC rule applies instead of the hour.
 */
export function scheduledInstant(localDate: string, localTime: string, zone: string | null, quiet: readonly [string, string]): number {
  if (!zone) {
    const d = parseIsoDate(localDate);
    if (!d) throw new RangeError("invalid ISO date");
    return toEpochDay(d) * 86_400_000 + minutesOf(NO_ZONE_SEND_UTC) * MINUTE;
  }
  const moved = avoidQuietHours(localTime, quiet);
  return localDateTimeToInstant(moved.dayShift === 0 ? localDate : addDays(localDate, -1), moved.time, zone);
}

/**
 * The spread weekday for the weekly email: `hash(id) mod 7`, as ISO weekday 1-7 (s02 2.3.11).
 * FNV-1a over the id, so it is stable across runtimes and needs no crypto.
 */
export function spreadWeekday(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % 7) + 1;
}

/** The weekday the student picked, else the spread day. */
export function weeklyWeekday(id: string, picked: number | null | undefined): number {
  return picked && picked >= 1 && picked <= 7 ? picked : spreadWeekday(id);
}

/** ISO week key of a calendar date, e.g. `2026-W46` (the weekly email's idempotency unit). */
export function isoWeekKey(isoDate: string): string {
  const d = parseIsoDate(isoDate);
  if (!d) throw new RangeError("invalid ISO date");
  const weekday = isoWeekday(isoDate);
  // The Thursday of this week decides the ISO year.
  const thursday = addDays(isoDate, 4 - weekday);
  const year = Number(thursday.slice(0, 4));
  const jan1 = `${year}-01-01`;
  const dayOfYear = toEpochDay(parseIsoDate(thursday)!) - toEpochDay(parseIsoDate(jan1)!);
  const week = Math.floor(dayOfYear / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Whether the exam pause is on today (it holds the weekly email, never T−2 reminders). */
export function examPaused(examPauseUntil: string | null | undefined, today: string): boolean {
  return !!examPauseUntil && today <= examPauseUntil;
}

export interface WeeklySettings {
  /** `u:{userId}` or `c:{contactId}`. */
  readonly recipientKey: string;
  readonly zone: string | null;
  readonly weeklyEmail: boolean;
  readonly weeklyDay: number | null;
  readonly quiet: readonly [string, string];
  readonly examPauseUntil: string | null;
}

/** The local date of this week's weekly email for a recipient whose today is `today`. */
export function weeklyDateFor(settings: WeeklySettings, today: string): string {
  const target = weeklyWeekday(settings.recipientKey.slice(2), settings.weeklyDay);
  return addDays(today, target - isoWeekday(today));
}

/** True when the weekly email can carry a T−2 reminder due on `t2Date` (plan 6.7.2's merge rule). */
export function mergesIntoWeekly(settings: WeeklySettings, t2Date: string): boolean {
  if (!settings.weeklyEmail || examPaused(settings.examPauseUntil, t2Date)) return false;
  return weeklyDateFor(settings, t2Date) === t2Date;
}

/**
 * Whether the weekly email may go now: on the recipient's weekly day, at or after its send time
 * (09:00 when it carries a T−2 reminder, else 18:00, moved out of quiet hours) and before quiet
 * hours begin. With no zone, the 22:30 UTC rule applies. Never on another day, so a held weekly
 * email is dropped rather than sent late (the 48-hour rule is stricter than needed here).
 */
export function weeklyWindowOpen(settings: WeeklySettings, now: number, carriesT2: boolean): boolean {
  const today = recipientToday(now, settings.zone);
  if (weeklyDateFor(settings, today) !== today) return false;
  const hour = carriesT2 ? PRODUCT.t2.localHour : PRODUCT.weekly.localHour;
  const planned = `${String(hour).padStart(2, "0")}:00`;
  const at = scheduledInstant(today, planned, settings.zone, settings.quiet);
  if (now < at) return false;
  if (!settings.zone) return true;
  return !isQuietTime(localTimeIn(now, settings.zone), settings.quiet[0], settings.quiet[1]);
}

/** A reminder is written once its send time is within the lookahead and it is not stale. */
export function reminderDue(scheduledFor: number, now: number, opts: { finalBeforeDeadline: boolean; deadlineAt: number | null }): boolean {
  if (scheduledFor > now + LOOKAHEAD_MS) return false;
  if (opts.deadlineAt !== null && now >= opts.deadlineAt) return false;
  if (!opts.finalBeforeDeadline && now - scheduledFor > MAX_LATENESS_MS) return false;
  return true;
}
