import { PRODUCT } from "../config/product";
import { CYCLE_KEY_PATTERN, TERM_KEY_PATTERN, type AcademicTerm, type Term } from "../taxonomy";
import { parseIsoDate } from "./iso";

/** Cycle keys (`summer-2027`, `ay-2027-28`) and academic terms (`spring-2029`). */

export interface ParsedCycleKey {
  readonly term: Term;
  readonly year: number;
  /** Second year of an academic-year key (`ay-2027-28` -> 2028). */
  readonly endYear: number | null;
}

export function parseCycleKey(key: string): ParsedCycleKey | null {
  const m = CYCLE_KEY_PATTERN.exec(key);
  if (!m) return null;
  if (m[1] && m[2]) return { term: m[1] as Term, year: Number(m[2]), endYear: null };
  const start = Number(m[3]);
  if ((start + 1) % 100 !== Number(m[4])) return null;
  return { term: "ay", year: start, endYear: start + 1 };
}

export function formatCycleKey(term: Term, year: number): string {
  if (term === "ay") return `ay-${year}-${String((year + 1) % 100).padStart(2, "0")}`;
  return `${term}-${year}`;
}

/**
 * Maps a page's cycle wording to a cycle key: "Summer 2027" -> summer-2027,
 * "2027-28" or "2027-2028 academic year" -> ay-2027-28, "Fall 2026" -> fall-2026.
 * Returns null when the label names no recognisable term and year.
 */
export function cycleKeyFromLabel(label: string): string | null {
  const text = label.toLowerCase();
  const ay = /(20\d{2})\s*[-–/]\s*(?:20)?(\d{2})\b/.exec(text);
  if (ay && (Number(ay[1]) + 1) % 100 === Number(ay[2])) return formatCycleKey("ay", Number(ay[1]));
  const termYear = /\b(spring|summer|fall|autumn|winter)\b\D{0,12}(20\d{2})/.exec(text);
  if (termYear && termYear[1] && termYear[2]) {
    const term = termYear[1] === "autumn" ? "fall" : (termYear[1] as Term);
    return formatCycleKey(term, Number(termYear[2]));
  }
  const rolling = /\brolling\b\D{0,12}(20\d{2})/.exec(text);
  if (rolling && rolling[1]) return formatCycleKey("rolling", Number(rolling[1]));
  const yearOnly = /\b(20\d{2})\b/.exec(text);
  return yearOnly && yearOnly[1] ? formatCycleKey("year", Number(yearOnly[1])) : null;
}

const TERM_ORDER: Record<AcademicTerm, number> = { winter: 0, spring: 1, summer: 2, fall: 3 };

export interface ParsedTermKey {
  readonly term: AcademicTerm;
  readonly year: number;
}

export function parseTermKey(key: string): ParsedTermKey | null {
  const m = TERM_KEY_PATTERN.exec(key);
  return m && m[1] && m[2] ? { term: m[1] as AcademicTerm, year: Number(m[2]) } : null;
}

export function formatTermKey(term: AcademicTerm, year: number): string {
  return `${term}-${year}`;
}

/** Sort key for term keys in calendar order (winter < spring < summer < fall within a year). */
export function termOrdinal(key: ParsedTermKey): number {
  return key.year * 4 + TERM_ORDER[key.term];
}

export function compareTermKeys(a: string, b: string): number {
  const pa = parseTermKey(a);
  const pb = parseTermKey(b);
  if (!pa || !pb) throw new RangeError(`invalid term key: ${!pa ? a : b}`);
  return termOrdinal(pa) - termOrdinal(pb);
}

/** The term a calendar date falls in: Jan-May spring, Jun-Aug summer, Sep-Dec fall. */
export function termKeyForDate(isoDate: string): string {
  const d = parseIsoDate(isoDate);
  if (!d) throw new RangeError(`invalid ISO date: ${isoDate}`);
  const term: AcademicTerm = d.month <= 5 ? "spring" : d.month <= 8 ? "summer" : "fall";
  return formatTermKey(term, d.year);
}

/**
 * Terms from `from` to `to` inclusive, in order. Winter terms are skipped unless asked for,
 * since most US calendars have none.
 */
export function enumerateTerms(from: string, to: string, opts: { includeWinter?: boolean } = {}): string[] {
  const a = parseTermKey(from);
  const b = parseTermKey(to);
  if (!a || !b) throw new RangeError("invalid term key");
  const out: string[] = [];
  const terms: AcademicTerm[] = ["winter", "spring", "summer", "fall"];
  for (let ord = termOrdinal(a); ord <= termOrdinal(b); ord++) {
    const term = terms[ord % 4] as AcademicTerm;
    if (term === "winter" && !opts.includeWinter) continue;
    out.push(formatTermKey(term, Math.floor(ord / 4)));
  }
  return out;
}

/** First calendar year of the academic year containing `isoDate` (Aug 2026 -> 2026, Mar 2027 -> 2026). */
export function academicYearStart(isoDate: string, startMonth: number = PRODUCT.academicYearStartMonth): number {
  const d = parseIsoDate(isoDate);
  if (!d) throw new RangeError(`invalid ISO date: ${isoDate}`);
  return d.month >= startMonth ? d.year : d.year - 1;
}
