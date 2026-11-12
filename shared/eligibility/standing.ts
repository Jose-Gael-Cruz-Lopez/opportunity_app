import { CLASS_YEARS, CLASS_YEAR_INDEX, type ClassYear, type InstitutionCalendar } from "../taxonomy";
import { parseIsoDate, parseIsoMonth } from "../time/iso";
import { academicYearStart, enumerateTerms, parseTermKey, termOrdinal } from "../time/terms";

/**
 * Class standing at a rule's date. Everything here works on ISO date strings and plain integers
 * (no Date, no Intl, no time zones), so the browser, the Worker and Python agree exactly, and no
 * clock is read: the caller always passes the date. Standing is recomputed at every evaluation
 * from the expected graduation term, so there is no yearly rollover job and no stale class year.
 */

/** Calendars whose terms Novus can count; the rest leave standing rules unknown. */
export type CountableCalendar = "semester" | "four_one_four" | "quarter" | "trimester";

export function isCountableCalendar(calendar: InstitutionCalendar): calendar is CountableCalendar {
  return calendar === "semester" || calendar === "four_one_four" || calendar === "quarter" || calendar === "trimester";
}

/** Full-time terms per academic year: 4-1-4 counts as semesters (the January term is not counted). */
export function termsPerYear(calendar: CountableCalendar): 2 | 3 {
  return calendar === "quarter" || calendar === "trimester" ? 3 : 2;
}

/**
 * Last day of a term as `MM-DD`. These are conventions, not institution data: standing rules are
 * anchored on dates such as 1 September or a winter deadline, which fall well clear of them.
 */
const TERM_END: Record<"semester" | "quarter", Record<"winter" | "spring" | "summer" | "fall", string>> = {
  semester: { winter: "01-31", spring: "05-31", summer: "08-31", fall: "12-31" },
  quarter: { winter: "03-31", spring: "06-15", summer: "08-31", fall: "12-31" },
};

function endTable(calendar: CountableCalendar): Record<"winter" | "spring" | "summer" | "fall", string> {
  return termsPerYear(calendar) === 3 ? TERM_END.quarter : TERM_END.semester;
}

/** ISO date of the last day of a term key (`spring-2029`) on a calendar. */
export function termEndDate(termKey: string, calendar: CountableCalendar = "semester"): string {
  const t = parseTermKey(termKey);
  if (!t) throw new RangeError(`invalid term key: ${termKey}`);
  return `${String(t.year).padStart(4, "0")}-${endTable(calendar)[t.term]}`;
}

function countsAsFullTimeTerm(term: "winter" | "spring" | "summer" | "fall", calendar: CountableCalendar): boolean {
  if (term === "summer") return false;
  if (term === "winter") return termsPerYear(calendar) === 3;
  return true;
}

/**
 * Native full-time terms left at `anchor`: terms that end after the anchor, up to and including
 * the graduation term, excluding summer (and the winter J-term on semester and 4-1-4 calendars).
 */
export function remainingNativeTerms(gradTerm: string, anchor: string, calendar: CountableCalendar): number {
  const grad = parseTermKey(gradTerm);
  const at = parseIsoDate(anchor);
  if (!grad || !at) throw new RangeError("invalid graduation term or anchor date");
  const startKey = `winter-${at.year}`;
  const startOrd = termOrdinal({ term: "winter", year: at.year });
  if (termOrdinal(grad) < startOrd) return 0;
  let count = 0;
  for (const key of enumerateTerms(startKey, gradTerm, { includeWinter: true })) {
    const t = parseTermKey(key);
    if (!t || !countsAsFullTimeTerm(t.term, calendar)) continue;
    if (termEndDate(key, calendar) > anchor) count += 1;
  }
  return count;
}

export interface SemesterEquivalents {
  /** Exact on semester and 4-1-4 calendars. */
  readonly exact: boolean;
  /** Converted value range; lo === hi when exact. */
  readonly lo: number;
  readonly hi: number;
  readonly nativeTerms: number;
}

/**
 * Semester-equivalents left. On quarter and trimester calendars the conversion is Novus's, not the
 * program's, so the value carries half a native term of slack either way (plan 6.4.4): a rule
 * then says "no" only when the whole interval is outside its bounds, and never "yes".
 */
export function semesterEquivalentsRemaining(gradTerm: string, anchor: string, calendar: CountableCalendar): SemesterEquivalents {
  const n = remainingNativeTerms(gradTerm, anchor, calendar);
  if (termsPerYear(calendar) === 2) return { exact: true, lo: n, hi: n, nativeTerms: n };
  const factor = 2 / 3;
  return { exact: false, lo: Math.max(0, (n - 0.5) * factor), hi: (n + 0.5) * factor, nativeTerms: n };
}

/**
 * Possible ages at `anchor` for someone born in `birthYearMonth` (YYYY-MM). Born on the first of
 * the month gives the oldest age, on the last day the youngest; both are returned (one value when
 * they agree). A birthday counts on the day itself; a 29 February birthday counts on 1 March in
 * non-leap years.
 */
export function possibleAges(birthYearMonth: string, anchor: string): readonly number[] {
  const birth = parseIsoMonth(birthYearMonth);
  const at = parseIsoDate(anchor);
  if (!birth || !at) throw new RangeError("invalid birth month or anchor date");
  const ageIfBornOn = (day: number): number => {
    const hadBirthday = at.month > birth.month || (at.month === birth.month && at.day >= day);
    return at.year - birth.year - (hadBirthday ? 0 : 1);
  };
  const oldest = ageIfBornOn(1);
  const youngest = ageIfBornOn(lastDay(birth.year, birth.month));
  return oldest === youngest ? [oldest] : [youngest, oldest];
}

function lastDay(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 31;
}

const CLASS_YEAR_BY_INDEX: readonly ClassYear[] = CLASS_YEARS.filter((c) => CLASS_YEAR_INDEX[c] !== null).sort(
  (a, b) => (CLASS_YEAR_INDEX[a] as number) - (CLASS_YEAR_INDEX[b] as number),
);
const MAX_INDEX = CLASS_YEAR_BY_INDEX.length - 1;

/**
 * Class year at `anchor`, projected from the class year reported as of `today`. A rule judged at
 * a later date (a program start next September) must not read last year's standing.
 *
 * `years` lists the possible class years: one when determined; two when the student would pass
 * their fourth year and gave no graduation term (a fifth year or a recent graduate). `conflict`
 * is true when the graduation term says the student has graduated by the anchor while normal
 * progression says they are still enrolled; both readings are then possible, so a rule on them
 * stays unknown instead of guessing (and adding the term can never flip a yes into a no).
 */
export interface ProjectedClassYear {
  readonly years: readonly ClassYear[];
  readonly conflict: boolean;
}

export function projectClassYear(input: {
  readonly reported: ClassYear;
  readonly today: string;
  readonly anchor: string;
  readonly gradTerm: string | null;
  readonly calendar: CountableCalendar;
  readonly academicYearStartMonth: number;
}): ProjectedClassYear {
  const index = CLASS_YEAR_INDEX[input.reported];
  const yearsAhead = academicYearStart(input.anchor, input.academicYearStartMonth) - academicYearStart(input.today, input.academicYearStartMonth);
  if (yearsAhead === 0 || index === null) return { years: [input.reported], conflict: false };
  const nominal = index + yearsAhead;
  const next = CLASS_YEAR_BY_INDEX[Math.max(0, Math.min(MAX_INDEX, nominal))] as ClassYear;
  if (input.gradTerm === null) {
    return { years: nominal > 4 ? ["fifth_year_plus", "recent_graduate"] : [next], conflict: false };
  }
  const graduated = termEndDate(input.gradTerm, input.calendar) <= input.anchor;
  if (!graduated) return { years: [next], conflict: false };
  if (nominal > 4) return { years: ["recent_graduate"], conflict: false };
  return { years: [next, "recent_graduate"], conflict: true };
}
