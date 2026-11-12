import { addDays, isIsoDate, LOCAL_TIME_PATTERN } from "@shared/time";

/**
 * A small, pure iCalendar (RFC 5545) writer for deadline feeds. It has no I/O and no clock, so
 * the same input always yields the same bytes: feeds get stable ETags, and the browser's
 * "Add alarms to my calendar" file can reuse it unchanged.
 *
 * Time handling (plan 6.7.5, frozen with the first feed):
 * - fixed timed deadlines are written in UTC (RFC 5545 §3.3.5 form 2), so no VTIMEZONE is needed;
 * - date-only deadlines are all-day events (`VALUE=DATE`);
 * - applicant-local deadlines ("11:59 pm, your time zone") use floating local time (form 1), which
 *   every calendar shows at that wall-clock time in the viewer's own zone.
 * The bytes never depend on the subscriber's zone.
 */

export const ICS_CONTENT_TYPE = "text/calendar; charset=utf-8";
export const ICS_PRODID = "-//Novus//Deadline Calendar 1.0//EN";

/** The start of an event, in one of the three forms the feed uses. */
export type IcsStart =
  | { readonly kind: "utc"; readonly instantMs: number }
  | { readonly kind: "date"; readonly date: string }
  | { readonly kind: "floating"; readonly date: string; readonly time: string };

export type IcsStatus = "CONFIRMED" | "TENTATIVE" | "CANCELLED";

export interface IcsAlarm {
  /** Whole days before the start (7 gives TRIGGER:-P7D). */
  readonly daysBefore: number;
  readonly description: string;
}

export interface IcsEvent {
  /** A UUID (see ./uid.ts); never contains a host, user or domain. */
  readonly uid: string;
  /** Raised whenever the event changes, so clients replace their copy. */
  readonly sequence: number;
  readonly start: IcsStart;
  readonly summary: string;
  readonly description?: string | null;
  readonly url?: string | null;
  readonly status: IcsStatus;
  /** DTSTAMP and LAST-MODIFIED: the record's last change, so bytes stay stable between changes. */
  readonly stampMs: number;
  readonly categories?: readonly string[];
  readonly alarms?: readonly IcsAlarm[];
}

export interface IcsCalendar {
  readonly name: string;
  readonly description?: string | null;
  /** REFRESH-INTERVAL hint (RFC 7986); material changes are also emailed, since clients may ignore it. */
  readonly refreshHours: number;
  readonly events: readonly IcsEvent[];
}

const CRLF = "\r\n";
/** RFC 5545 §3.1: lines SHOULD NOT be longer than 75 octets, excluding the line break. */
const MAX_LINE_OCTETS = 75;
const SAFE_URL = /^https?:\/\/[^\s\x00-\x1f\x7f"<>\\^`{|}]+$/;

/** Escapes a TEXT value (RFC 5545 §3.3.11): backslash, semicolon, comma and newlines. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();

function octets(text: string): number {
  return encoder.encode(text).length;
}

/**
 * Folds a content line at 75 octets (RFC 5545 §3.1). Continuation lines begin with one space,
 * which counts toward their 75 octets. Splits happen between code points, never inside a UTF-8
 * sequence, so multi-byte characters survive.
 */
export function foldLine(line: string): string {
  if (octets(line) <= MAX_LINE_OCTETS) return line;
  const parts: string[] = [];
  let current = "";
  let currentOctets = 0;
  let limit = MAX_LINE_OCTETS;
  for (const ch of line) {
    const size = octets(ch);
    if (currentOctets + size > limit) {
      parts.push(current);
      current = "";
      currentOctets = 0;
      limit = MAX_LINE_OCTETS - 1; // the leading space of a continuation line
    }
    current += ch;
    currentOctets += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** `20270129T230000Z` from epoch ms. */
export function formatUtc(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new RangeError("invalid instant");
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  );
}

/** `20270129` from `2027-01-29`. Never goes through Date, which would shift the day by zone. */
export function formatDate(isoDate: string): string {
  if (!isIsoDate(isoDate)) throw new RangeError("date must be YYYY-MM-DD");
  return isoDate.replace(/-/g, "");
}

/** `20270202T235900` (floating) from a date and `HH:MM` or `HH:MM:SS`. */
export function formatFloating(isoDate: string, time: string): string {
  const m = LOCAL_TIME_PATTERN.exec(time);
  if (!m) throw new RangeError("time must be HH:MM");
  return `${formatDate(isoDate)}T${m[1]}${m[2]}${m[3] ?? "00"}`;
}

function startLines(start: IcsStart): string[] {
  switch (start.kind) {
    case "utc":
      // A DATE-TIME start with no DTEND is a zero-length event that ends when it starts (§3.6.1).
      return [`DTSTART:${formatUtc(start.instantMs)}`];
    case "floating":
      return [`DTSTART:${formatFloating(start.date, start.time)}`];
    case "date":
      // All-day: DTEND is the next day (exclusive), which every major client reads the same way.
      return [`DTSTART;VALUE=DATE:${formatDate(start.date)}`, `DTEND;VALUE=DATE:${formatDate(addDays(start.date, 1))}`];
  }
}

function alarmLines(alarm: IcsAlarm): string[] {
  const days = Math.max(0, Math.floor(alarm.daysBefore));
  return ["BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(alarm.description)}`, `TRIGGER:-P${days}D`, "END:VALARM"];
}

function eventLines(event: IcsEvent): string[] {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${formatUtc(event.stampMs)}`,
    `LAST-MODIFIED:${formatUtc(event.stampMs)}`,
    `SEQUENCE:${Math.max(0, Math.floor(event.sequence))}`,
    ...startLines(event.start),
    `SUMMARY:${escapeText(event.summary)}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
  // URI values are not TEXT and are written as-is (RFC 5545 §3.3.13), so anything that is not a
  // plain http(s) URL (whitespace or control characters could inject properties) is dropped.
  if (event.url && SAFE_URL.test(event.url)) lines.push(`URL:${event.url}`);
  if (event.categories?.length) lines.push(`CATEGORIES:${event.categories.map(escapeText).join(",")}`);
  lines.push(`STATUS:${event.status}`);
  // A deadline does not make the student busy; it should not block free/busy time.
  lines.push("TRANSP:TRANSPARENT");
  if (event.status !== "CANCELLED") for (const alarm of event.alarms ?? []) lines.push(...alarmLines(alarm));
  lines.push("END:VEVENT");
  return lines;
}

/** Renders a whole VCALENDAR with CRLF line endings and folded lines. */
export function renderCalendar(calendar: IcsCalendar): string {
  const refresh = `PT${Math.max(1, Math.floor(calendar.refreshHours))}H`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${ICS_PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `NAME:${escapeText(calendar.name)}`,
    `X-WR-CALNAME:${escapeText(calendar.name)}`,
  ];
  if (calendar.description) {
    lines.push(`DESCRIPTION:${escapeText(calendar.description)}`, `X-WR-CALDESC:${escapeText(calendar.description)}`);
  }
  lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${refresh}`, `X-PUBLISHED-TTL:${refresh}`);
  for (const event of calendar.events) lines.push(...eventLines(event));
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join(CRLF) + CRLF;
}
