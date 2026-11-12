/**
 * A one-event iCalendar file for the student's implementation intention ("I'll work on this on
 * [day] at [time] at [place]"). Built and downloaded on the device; nothing is sent.
 *
 * The time is written as floating local time (no TZID), so it rings at the hour the student
 * picked wherever their calendar is set, which is what an if-then plan means. RFC 5545 rules
 * applied: CRLF line ends, text escaping and folding at 75 octets.
 */

export interface IcsEventInput {
  uid: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24-hour */
  time: string;
  durationMinutes: number;
  summary: string;
  description?: string;
  location?: string;
  /** Minutes before the start for the alarm; omit for no alarm. */
  alarmMinutesBefore?: number;
  now: Date;
}

/** Escapes TEXT values (RFC 5545 3.3.11). */
export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** Folds a content line at 75 octets, continuing with CRLF + space (RFC 5545 3.1). */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    const limit = parts.length === 0 ? 75 : 74; // continuation lines start with a space
    if (curBytes + b > limit) {
      parts.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  parts.push(cur);
  return parts.join("\r\n ");
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function localStamp(date: string, time: string): string {
  return `${date.replace(/-/g, "")}T${time.replace(":", "")}00`;
}

function addMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
  const [h, m] = time.split(":").map(Number);
  const base = Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h, m);
  const end = new Date(base + minutes * 60_000);
  return { date: end.toISOString().slice(0, 10), time: end.toISOString().slice(11, 16) };
}

export function isValidLocalDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

export function isValidLocalTime(time: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
}

export function buildIcs(e: IcsEventInput): string {
  if (!isValidLocalDate(e.date) || !isValidLocalTime(e.time)) throw new Error("invalid_date_or_time");
  const end = addMinutes(e.date, e.time, Math.max(5, e.durationMinutes));
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Novus//Onboarding//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${stamp(e.now)}`,
    `DTSTART:${localStamp(e.date, e.time)}`,
    `DTEND:${localStamp(end.date, end.time)}`,
    `SUMMARY:${escapeText(e.summary)}`,
  ];
  if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
  if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
  if (e.alarmMinutesBefore !== undefined) {
    lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${escapeText(e.summary)}`, `TRIGGER:-PT${Math.max(0, Math.round(e.alarmMinutesBefore))}M`, "END:VALARM");
  }
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** Pre-fills the form with tomorrow at 17:00; the student picks their own slot. */
export function suggestSlot(now: Date): { date: string; time: string } {
  const t = new Date(now.getTime() + 86_400_000);
  return { date: t.toISOString().slice(0, 10), time: "17:00" };
}
