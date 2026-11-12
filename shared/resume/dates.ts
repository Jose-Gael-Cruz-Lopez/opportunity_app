import type { NowInput } from "./types";

/**
 * Resume date grammar. Resume dates are a closed set ("May 2025", "05/2025", "Summer 2025",
 * "'25", "2023 - Present", "Expected May 2029", "Class of 2030", "2024-25"), so a small
 * grammar is smaller and more exact than a general natural-language date parser. Output fits
 * JSON Resume's iso8601 pattern: YYYY, YYYY-MM or YYYY-MM-DD.
 */

export interface ResumeNow {
  year: number;
  month: number;
  day: number;
}

/** Reads "now" as calendar numbers. "YYYY-MM-DD" strings are read as dates, never instants. */
export function resolveNow(now?: NowInput): ResumeNow {
  if (typeof now === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(now);
    if (m) return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  }
  let d = new Date();
  if (now instanceof Date) d = now;
  else if (typeof now === "number" || typeof now === "string") d = new Date(now);
  if (Number.isNaN(d.getTime())) d = new Date();
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export interface DateMatch {
  /** iso8601 start, or null for a lone graduation date. */
  start: string | null;
  /** iso8601 end; null when the range is open ("Present"). */
  end: string | null;
  /** The range runs to Present, Current or Now. */
  open: boolean;
  /** One date or one term ("Summer 2025"), not a range. */
  single: boolean;
  /** Marked Expected, Anticipated or Projected. */
  expected: boolean;
  /** Marked as a graduation date ("Class of", "Graduation", "Expected"). */
  graduation: boolean;
  /** Offset and length of the matched text in the input. */
  index: number;
  length: number;
  text: string;
}

type Season = "spring" | "summer" | "fall" | "winter";

const MONTH_NUMBER: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const SEASON_START: Record<Season, number> = { spring: 1, summer: 6, fall: 9, winter: 12 };
const SEASON_END: Record<Season, number> = { spring: 5, summer: 8, fall: 12, winter: 2 };

const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const SEASON = "(?:spring|summer|fall|autumn|winter)";
const Y4 = "(?:19|20)\\d{2}";
const Y2 = "'\\d{2}";

/**
 * One alternative per date form, longest forms first because the engine takes the first
 * alternative that matches at a position. The `yy` form refuses a year right after three
 * digits and a separator, so the "2024" in a phone number "555 010-2024" is not a year.
 */
const ATOM = new RegExp(
  "(?<![\\p{L}\\p{N}'#$])(?:" +
    [
      `(?<mdy>(?<mdyMon>${MONTH})\\.?\\s+(?<mdyDay>\\d{1,2})(?:st|nd|rd|th)?,?\\s+(?<mdyYear>${Y4})(?!\\d))`,
      `(?<dmy>(?<dmyDay>\\d{1,2})(?:st|nd|rd|th)?\\s+(?<dmyMon>${MONTH})\\.?,?\\s+(?<dmyYear>${Y4})(?!\\d))`,
      `(?<my>(?<myMon>${MONTH})\\.?,?\\s*(?<myYear>${Y4}|${Y2})(?!\\d))`,
      `(?<sy>(?<sySeason>${SEASON})(?:\\s+(?:semester|term|quarter|session|break))?,?\\s*(?<syYear>${Y4}|${Y2})(?!\\d))`,
      `(?<iso>(?<isoY>${Y4})-(?<isoM>0[1-9]|1[0-2])-(?<isoD>0[1-9]|[12]\\d|3[01])(?!\\d))`,
      `(?<ym>(?<ymY>${Y4})[-/.](?<ymM>0[1-9]|1[0-2])(?!\\d|[-/.]\\d))`,
      `(?<nmy>(?<nmyM>0?[1-9]|1[0-2])\\s?[-/.]\\s?(?<nmyY>${Y4})(?!\\d))`,
      `(?<ns>(?<nsM>0?[1-9]|1[0-2])/(?<nsY>\\d{2})(?![\\d/]))`,
      `(?<yy>(?<!(?<!\\d)\\d{3}[-.\\s])(?<yyY>${Y4})(?:\\s?[-/]\\s?(?<yyY2>\\d{2})(?!\\d))?(?![\\d%+]|\\.\\d|k\\b))`,
      `(?<ap>'(?<apY>\\d{2})(?!\\d))`,
      "(?<open>present|current(?:ly)?|now|ongoing|today|to\\s+date)",
      `(?<mon>${MONTH})\\.?`,
    ].join("|") +
    ")(?![\\p{L}])",
  "giu",
);

/** Hyphen, en and em dashes and the rest of the dash family, so callers need not normalize first. */
const RANGE_SEPARATOR = /^\s*(?:[-\u2010-\u2015\u2212]{1,2}|~|to|through|thru|until|till|'til)\s*$/i;
/** A number after these words is a room, unit or count, not a year ("Room 1980", "No. 2024"). */
const NUMBER_PREFIX = /(?:\b(?:room|rm|suite|ste|apt|unit|building|bldg|no|number|over|than|about|around|nearly|approximately|top)\.?|#)\s*$/i;
/** A number before a counted noun is a count ("2000 teams", "2024 students"). */
const COUNT_NOUN = /^\s+(?:[a-z]+\s+)?(?:students|people|teams|members|users|participants|attendees|applicants|meals|items|books|customers|patients|hours|rows|lines|images|downloads|views|followers|dollars|volunteers|households|families|calls|tickets|pieces|words|pages|signatures|votes|subscribers|visitors|miles|km|lbs|samples|cells|surveys|responses)\b/i;
const EXPECTED_PREFIX = /(?:expected|anticipated|projected|estimated|exp\.?|est\.)(?:\s+(?:graduation|grad\.?|completion|date|in))*\s*[:-]?\s*(?:in\s+|on\s+|by\s+)?$/i;
const GRADUATION_PREFIX = /(?:class\s+of|graduat(?:ion|ing|es|ed|e)|grad\.?|completion|degree\s+(?:date|conferred|expected))(?:\s+date)?\s*[:-]?\s*(?:in\s+|on\s+|by\s+)?$/i;
const EXPECTED_SUFFIX = /^\s*[(\[]?\s*(?:expected|anticipated|projected|exp\.?)(?![\p{L}])/iu;
const SINCE_PREFIX = /\bsince\s*$/i;
/** A capitalized course prefix right before a number ("CS 2110", "BIO 2020") means it is no year. */
const COURSE_PREFIX = /(?:^|[^\p{L}])(\p{Lu}{2,5})\s?$/u;
const NOT_COURSE = new Set(["TO", "AND", "OF", "IN", "ON", "BY", "SINCE", "FROM", "CLASS", "THE", "FALL", "SPRING", "SUMMER", "WINTER", "AUTUMN", "MAY", "JUNE", "JUNE", "JULY", "AUG", "SEPT", "SEP", "OCT", "NOV", "DEC", "JAN", "FEB", "MAR", "APR", "JUN", "JUL", "EST", "EXP"]);

interface DateAtom {
  kind: "date";
  start: number;
  end: number;
  year: number;
  month: number | null;
  day: number | null;
  season: Season | null;
  /** MM/YY: only trusted inside a range or after a graduation marker. */
  weak: boolean;
  /** "2024-25": the second year of an academic-year form. */
  academicEnd: number | null;
}
interface OpenAtom {
  kind: "open";
  start: number;
  end: number;
}
interface MonthAtom {
  kind: "month";
  start: number;
  end: number;
  month: number;
}
type Atom = DateAtom | OpenAtom | MonthAtom;

function monthNumber(word: string): number {
  return MONTH_NUMBER[word.slice(0, 3).toLowerCase()] ?? 0;
}

function seasonOf(word: string): Season {
  const w = word.toLowerCase();
  return w === "autumn" ? "fall" : (w as Season);
}

/** 'YY becomes 20YY when YY is at most six years ahead of this year, else 19YY. */
export function expandTwoDigitYear(yy: number, now: ResumeNow): number {
  return yy <= (now.year % 100) + 6 ? 2000 + yy : 1900 + yy;
}

function yearOf(raw: string, now: ResumeNow): number {
  return raw.startsWith("'") ? expandTwoDigitYear(Number(raw.slice(1)), now) : Number(raw);
}

/** Years outside 1950..now+8 are zip codes, course numbers or counts, not dates. */
function plausibleYear(year: number, now: ResumeNow): boolean {
  return year >= 1950 && year <= now.year + 8;
}

export function formatIso(year: number, month?: number | null, day?: number | null): string {
  const y = String(year).padStart(4, "0");
  if (!month) return y;
  const m = String(month).padStart(2, "0");
  return day ? `${y}-${m}-${String(day).padStart(2, "0")}` : `${y}-${m}`;
}

function toAtom(m: RegExpMatchArray, text: string, now: ResumeNow): Atom | null {
  const g = m.groups ?? {};
  const start = m.index ?? 0;
  const end = start + m[0].length;
  const date = (year: number, month: number | null, day: number | null, season: Season | null, weak = false, academicEnd: number | null = null): DateAtom | null =>
    plausibleYear(year, now) ? { kind: "date", start, end, year, month, day, season, weak, academicEnd } : null;

  if (g.mdy) return date(Number(g.mdyYear), monthNumber(g.mdyMon ?? ""), Number(g.mdyDay), null);
  if (g.dmy) return date(Number(g.dmyYear), monthNumber(g.dmyMon ?? ""), Number(g.dmyDay), null);
  if (g.my) return date(yearOf(g.myYear ?? "", now), monthNumber(g.myMon ?? ""), null, null);
  if (g.sy) return date(yearOf(g.syYear ?? "", now), null, null, seasonOf(g.sySeason ?? ""));
  if (g.iso) return date(Number(g.isoY), Number(g.isoM), Number(g.isoD), null);
  if (g.ym) {
    const year = Number(g.ymY);
    const second = Number(g.ymM);
    // "2011-12" is far more often an academic year than December 2011 on a resume.
    if ((year + 1) % 100 === second) return date(year, null, null, null, false, year + 1);
    return date(year, second, null, null);
  }
  if (g.nmy) return date(Number(g.nmyY), Number(g.nmyM), null, null);
  if (g.ns) return date(expandTwoDigitYear(Number(g.nsY), now), Number(g.nsM), null, null, true);
  if (g.yy) {
    const year = Number(g.yyY);
    const before = COURSE_PREFIX.exec(text.slice(Math.max(0, start - 8), start));
    if (before && before[1] && !NOT_COURSE.has(before[1])) return null;
    if (NUMBER_PREFIX.test(text.slice(Math.max(0, start - 16), start)) || COUNT_NOUN.test(text.slice(end, end + 30))) return null;
    let academicEnd: number | null = null;
    if (g.yyY2) {
      let second = year - (year % 100) + Number(g.yyY2);
      if (second <= year) second += 100;
      academicEnd = second - year <= 8 ? second : null;
    }
    return date(year, null, null, null, false, academicEnd);
  }
  if (g.ap) return date(expandTwoDigitYear(Number(g.apY), now), null, null, null);
  if (g.open) return { kind: "open", start, end };
  if (g.mon) return { kind: "month", start, end, month: monthNumber(g.mon) };
  return null;
}

function atomsOf(text: string, now: ResumeNow): Atom[] {
  const atoms: Atom[] = [];
  for (const m of text.matchAll(ATOM)) {
    const atom = toAtom(m, text, now);
    if (atom) atoms.push(atom);
  }
  return atoms;
}

function startIso(a: DateAtom, next?: DateAtom): string {
  if (a.season) {
    // "Winter 2025 - Spring 2025" is January; "Winter 2024 - Spring 2025" is December.
    const month = a.season === "winter" && next && next.year === a.year ? 1 : SEASON_START[a.season];
    return formatIso(a.year, month);
  }
  return formatIso(a.year, a.month, a.day);
}

function endIso(a: DateAtom): string {
  if (a.season) return formatIso(a.year, SEASON_END[a.season]);
  return formatIso(a.year, a.month, a.day);
}

/**
 * Finds every date and date range in a string, in order and without overlaps. Lone months,
 * lone "Present" and lone MM/YY are ignored: they only mean a date inside a range.
 */
export function findDates(text: string, nowInput?: NowInput | ResumeNow): DateMatch[] {
  const now = isResumeNow(nowInput) ? nowInput : resolveNow(nowInput);
  const atoms = atomsOf(text, now);
  const out: DateMatch[] = [];
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i] as Atom;
    const b = atoms[i + 1];
    const before = text.slice(Math.max(0, a.start - 40), a.start);
    const expectedBefore = EXPECTED_PREFIX.test(before);
    const graduationBefore = expectedBefore || GRADUATION_PREFIX.test(before);

    if (a.kind !== "open" && b && b.kind !== "month" && RANGE_SEPARATOR.test(text.slice(a.end, b.start))) {
      const range = buildRange(a, b);
      if (range) {
        const after = text.slice(b.end, b.end + 20);
        const expected = expectedBefore || EXPECTED_SUFFIX.test(after);
        out.push({ ...range, expected, graduation: graduationBefore || expected, index: a.start, length: b.end - a.start, text: text.slice(a.start, b.end) });
        i++;
        continue;
      }
    }
    if (a.kind !== "date") continue;
    const after = text.slice(a.end, a.end + 20);
    const expected = expectedBefore || EXPECTED_SUFFIX.test(after);
    const graduation = graduationBefore || expected;
    if (a.weak && !graduation) continue;
    const base = { index: a.start, length: a.end - a.start, text: text.slice(a.start, a.end), expected, graduation };
    if (a.academicEnd !== null) {
      out.push({ ...base, start: formatIso(a.year), end: formatIso(a.academicEnd), open: false, single: false });
    } else if (SINCE_PREFIX.test(before)) {
      out.push({ ...base, start: startIso(a), end: null, open: true, single: false });
    } else if (graduation) {
      out.push({ ...base, start: null, end: endIso(a), open: false, single: true });
    } else {
      out.push({ ...base, start: startIso(a), end: endIso(a), open: false, single: true });
    }
  }
  return out;
}

function buildRange(a: DateAtom | MonthAtom, b: DateAtom | OpenAtom): Pick<DateMatch, "start" | "end" | "open" | "single"> | null {
  if (a.kind === "month") {
    // "Jun - Aug 2025": the start takes the end's year (or the year before, "Nov - Feb 2025").
    if (b.kind !== "date") return null;
    const endMonth = b.month ?? (b.season ? SEASON_START[b.season] : 12);
    const year = a.month > endMonth ? b.year - 1 : b.year;
    return { start: formatIso(year, a.month), end: endIso(b), open: false, single: false };
  }
  if (b.kind === "open") return { start: startIso(a), end: null, open: true, single: false };
  return { start: startIso(a, b), end: endIso(b), open: false, single: false };
}

function isResumeNow(v: unknown): v is ResumeNow {
  return !!v && typeof v === "object" && !(v instanceof Date) && "year" in v && "month" in v && "day" in v;
}

/** The first date or range in a string, or null. */
export function parseDateRange(text: string, now?: NowInput | ResumeNow): DateMatch | null {
  return findDates(text, now)[0] ?? null;
}

/** Year and month of an iso8601 string; a year alone counts as June, a typical graduation. */
export function isoParts(iso: string): { year: number; month: number } | null {
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(iso);
  if (!m) return null;
  return { year: Number(m[1]), month: m[2] ? Number(m[2]) : 6 };
}

/** True when the iso date is after the current month. */
export function isFuture(iso: string, now: ResumeNow): boolean {
  const p = isoParts(iso);
  return !!p && p.year * 12 + p.month > now.year * 12 + now.month;
}

/** Whole months from start to end inclusive (Jun-Aug is 3), or 0 when either is missing. */
export function monthsSpanned(startIso: string, endIso: string): number {
  const a = isoParts(startIso);
  const b = isoParts(endIso);
  if (!a || !b) return 0;
  return Math.max(0, b.year * 12 + b.month - (a.year * 12 + a.month) + 1);
}
