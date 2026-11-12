import { findDates, isFuture, type DateMatch, type ResumeNow } from "./dates";
import type { Entry } from "./entries";
import { locationRegex } from "./lexicon/places";
import { INSTITUTION_RE } from "./lexicon/roles";
import { matchMajor } from "./majors";
import { splitCells, splitList, trimPunctuation, wordCount } from "./text";
import type { DegreeLevel, EducationEntry, ResumeGpa } from "./types";

/**
 * Education entries: school (+4 for University, College, Institute, School or Academy),
 * degree, major, minor, GPA as written, dates with "Expected" handling, coursework and honors.
 */

interface DegreeRule {
  level: DegreeLevel;
  long: RegExp;
  short: RegExp | null;
}

/** Long forms match in any case; abbreviations match case-sensitively ("BS", not "bs"). */
const DEGREES: readonly DegreeRule[] = [
  {
    level: "doctorate",
    long: /\b(?:Ph\.?\s?D\.?|Doctor\s+of\s+(?:Philosophy|Medicine|Education|Pharmacy|Physical\s+Therapy|Jurisprudence|Nursing\s+Practice)|Doctorate)(?![\p{L}])/iu,
    short: /\b(?:M\.D\.|J\.D\.|Ed\.D\.|D\.Phil\.?|PharmD|DPT|MD|JD)(?![\p{L}])/u,
  },
  {
    level: "master",
    long: /\b(?:Master(?:'s)?\s+of\s+(?:Science|Arts|Engineering|Business\s+Administration|Public\s+Health|Public\s+Policy|Public\s+Administration|Fine\s+Arts|Education|Social\s+Work|Information\s+Systems|Computer\s+Science)|Master(?:'s)?(?:\s+Degree)?)(?![\p{L}])/iu,
    short: /(?:\bM\.S\.|\bM\.A\.|\bMBA\b|\bM\.B\.A\.|\bMEng\b|\bM\.Eng\.?|\bMPH\b|\bM\.P\.H\.|\bMSc\b|\bM\.Sc\.?|\bMFA\b|\bMPP\b|\bMPA\b|\bM\.Ed\.?|\bMEd\b|\bM[SA](?=\s+(?:in\s+)?\p{Lu}))/u,
  },
  {
    level: "bachelor",
    long: /\b(?:Bachelor(?:'s)?\s+of\s+(?:Arts|Science|Fine\s+Arts|Business\s+Administration|Engineering|Applied\s+Science|Music|Architecture|Social\s+Work|Nursing|Education|Computer\s+Science)(?:\s+in\s+Engineering)?|Bachelor(?:'s)?(?:\s+Degree)?|Undergraduate(?:\s+Degree)?|Candidate\s+for\s+(?:the\s+)?Bachelor\w*)(?![\p{L}])/iu,
    short: /(?:\bB\.S\.(?:E\.)?|\bB\.A\.|\bB\.Sc\.?|\bBSc\b|\bBSE\b|\bBSEE\b|\bBSME\b|\bBSCS\b|\bBEng\b|\bB\.Eng\.?|\bBFA\b|\bB\.F\.A\.|\bBBA\b|\bB\.B\.A\.|\bBSN\b|\bB\.S\.N\.|\bBArch\b|\bB\.Arch\.?|\bBS\b|\bBA\b|\bA\.B\.|\bS\.B\.)/u,
  },
  {
    level: "associate",
    long: /\b(?:Associate(?:'s)?\s+(?:of|in)\s+(?:Arts|Science|Applied\s+Science|Fine\s+Arts|General\s+Studies)|Associate(?:'s)?\s+Degree)(?![\p{L}])/iu,
    short: /(?:\bA\.A\.S\.?|\bA\.A\.|\bA\.S\.|\bAAS\b|\bAA\b|\bAS(?=\s+(?:in\s+)?\p{Lu}))/u,
  },
  { level: "certificate", long: /\b(?:Certificate\s+(?:in|of|program)|Certification\s+Program|Diploma\s+in)(?![\p{L}])/iu, short: null },
  {
    level: "high_school",
    long: /\b(?:High\s+School\s+Diploma|HS\s+Diploma|GED|IB\s+Diploma|International\s+Baccalaureate|A[- ]Levels?|High\s+School|Secondary\s+School|Preparatory\s+School|Prep\s+School)(?![\p{L}])/iu,
    short: null,
  },
];

export interface DegreeMatch {
  level: DegreeLevel;
  text: string;
  line: number;
  index: number;
}

/** The first degree statement in the lines, highest level first within a line. */
export function findDegree(lines: readonly string[]): DegreeMatch | null {
  for (let line = 0; line < lines.length; line++) {
    const text = lines[line] as string;
    for (const rule of DEGREES) {
      for (const re of [rule.long, rule.short]) {
        if (!re) continue;
        const m = re.exec(text);
        if (m) return { level: rule.level, text: m[0].trim(), line, index: m.index };
      }
    }
  }
  return null;
}

const AREA_STOP = /\s*(?:[,;|(\t]|\s[-–]\s|\b(?:Minors?|GPA|Expected|Anticipated|Class\s+of|Concentration|Specialization|Track|with|Honou?rs|cum\s+laude|magna|summa|Dean's|Graduat\w*)\b|$)/i;

function cutArea(text: string): string | null {
  const stop = AREA_STOP.exec(text);
  const raw = trimPunctuation(stop ? text.slice(0, stop.index) : text);
  if (!raw || wordCount(raw) > 7 || !/\p{L}/u.test(raw) || INSTITUTION_RE.test(raw)) return null;
  return raw;
}

const LABELLED_MAJOR = /\b(?:(?:Intended|Prospective|Declared|Primary)\s+)?(?:Majors?|Majoring|Field\s+of\s+Study|Concentration|Program)\s*(?:in|:|-)\s*(.+)$/i;
const LABELLED_MINOR = /\bMinors?\s*(?:in|:|-)\s*(.+)$/i;

function areaFrom(lines: readonly string[], degree: DegreeMatch | null): string | null {
  for (const line of lines) {
    const m = LABELLED_MAJOR.exec(line);
    if (m && m[1]) {
      const area = cutArea(m[1].replace(/\b(?:double|dual)\s+major\b/i, ""));
      if (area) return area;
    }
  }
  // A high school "degree" has no major after it, and its text is often part of the school's
  // name ("Westlake High School, Atlanta, GA"), so nothing after it is a field of study.
  if (degree && degree.level !== "high_school") {
    const line = lines[degree.line] as string;
    const after = line.slice(degree.index + degree.text.length).replace(/^\s*(?:[,:-]\s*)?(?:(?:in|of)\s+)?/i, "");
    const place = locationRegex().exec(after);
    const area = place && place.index === 0 ? null : cutArea(after);
    if (area && !/^(?:Arts|Science|Sciences)$/i.test(area)) return area;
  }
  const known = matchMajor(lines.join(" \n "));
  return known ? known.matchedText : null;
}

function minorFrom(lines: readonly string[]): string | null {
  for (const line of lines) {
    const m = LABELLED_MINOR.exec(line);
    if (m && m[1]) {
      const minor = cutArea(m[1]);
      if (minor) return minor;
    }
  }
  return null;
}

const GPA_RE = /\b(?:(?:cumulative|overall|major|weighted|unweighted|term|semester|current)\s+)?GPA\s*(?:of\s*)?[:-]?\s*([0-4](?:\.\d{1,3})?)\s*(?:\/\s*(\d{1,3}(?:\.\d{1,2})?))?|\b([0-4]\.\d{1,3})\s*(?:\/\s*(\d{1,3}(?:\.\d{1,2})?))?\s*(?:cumulative\s+|overall\s+)?GPA\b/i;

/** The GPA as written. A scale counts only when stated ("3.8/4.0", "4.3/5.0"). */
export function findGpa(lines: readonly string[]): { score: string; gpa: ResumeGpa } | null {
  for (const line of lines) {
    const m = GPA_RE.exec(line);
    if (!m) continue;
    const valueText = m[1] ?? m[3];
    const scaleText = m[2] ?? m[4];
    if (!valueText) continue;
    const value = Number(valueText);
    const scale = scaleText ? Number(scaleText) : null;
    if (!Number.isFinite(value) || (scale !== null && (!Number.isFinite(scale) || scale <= 0 || value > scale))) continue;
    return { score: scaleText ? `${valueText}/${scaleText}` : valueText, gpa: { value, scale } };
  }
  return null;
}

const COURSE_LABEL = /^\s*(?:relevant\s+|related\s+|selected\s+|key\s+)?(?:course\s?work|courses|classes)\s*[:-]\s*(.+)$/i;
const HONORS_LINE = /\b(?:honou?rs?|dean'?s\s+list|awards?|scholarships?|cum\s+laude|magna|summa|valedictorian|salutatorian|national\s+merit|ap\s+scholar|president'?s\s+list|distinction)\b/i;

export function coursesFromText(text: string): string[] {
  return splitList(text).map(cleanCourse).filter((c): c is string => c !== null);
}

/** Strips codes and grades: "CS 2110: OOP & Data Structures (A)" -> "OOP & Data Structures". */
export function cleanCourse(raw: string): string | null {
  let t = raw.replace(/^\s*(?:and|&)\s+/i, "").trim();
  t = t.replace(/^[A-Z]{2,5}\s?-?\d{3,4}[A-Z]?\s*[:\-–]?\s*(?=\S)/, "");
  t = t.replace(/\((?:[A-F][+-]?|in\s+progress|ip|current|expected|honou?rs|ap|ib|fall|spring|summer|winter)[^)]*\)/gi, "");
  t = t.replace(/\*+/g, "");
  t = trimPunctuation(t.replace(/\s+/g, " "));
  if (!t || t.length > 80 || !/\p{L}/u.test(t)) return null;
  return t;
}

function honorsFrom(line: string): string[] {
  const m = /^\s*(?:honou?rs|awards?|scholarships?|achievements?|distinctions?|honou?rs\s*(?:and|&)\s*awards?|awards?\s*(?:and|&)\s*honou?rs)\s*[:-]\s*(.+)$/i.exec(line);
  return m && m[1] ? splitList(m[1]).map(trimPunctuation).filter(Boolean) : [trimPunctuation(line)];
}

function institutionFrom(entry: Entry, degree: DegreeMatch | null, now: ResumeNow): string | null {
  const cells = entry.header.flatMap((l) => splitCells(l.text.replace(locationRegex(), "\t")));
  const named = cells.find((c) => INSTITUTION_RE.test(c) && !/^(?:high\s+school)$/i.test(c.trim()));
  if (named) return cleanInstitution(named, degree);
  const first = entry.header[0];
  if (first && first.bold && cells[0] && !findDates(cells[0], now).length && !findDegree([cells[0]])) return cleanInstitution(cells[0], degree);
  return null;
}

/**
 * The school name from a cell that may carry more after commas: "University of Michigan, College
 * of Engineering" keeps the university, "Arizona State University, Political Science, 2026-2030"
 * drops the major and dates, while "University of California, Berkeley" keeps its campus.
 */
function cleanInstitution(cell: string, degree: DegreeMatch | null): string | null {
  let t = cell;
  if (degree && t.includes(degree.text) && !/^(?:High\s+School|Secondary\s+School|Prep\w*\s+School)$/i.test(degree.text)) t = t.replace(degree.text, " ");
  const parts = t.split(/\s*,\s*/).map((p) => trimPunctuation(p.replace(/\s+/g, " "))).filter(Boolean);
  const first = parts.findIndex((p) => INSTITUTION_RE.test(p));
  if (first < 0) {
    const whole = trimPunctuation(t.replace(/\s+/g, " "));
    return whole && /\p{L}/u.test(whole) ? whole : null;
  }
  const kept = [parts[first] as string];
  const next = parts[first + 1];
  if (next && isCampusName(next, parts[first + 2])) kept.push(next);
  const out = kept.join(", ").replace(/^(?:in|at)\s+/i, "");
  return out && /\p{L}/u.test(out) ? out : null;
}

/** "Berkeley" after "University of California": short, capitalized and nothing else. */
function isCampusName(part: string, following: string | undefined): boolean {
  if (!/^\p{Lu}[\p{L}.'-]*(?: \p{Lu}[\p{L}.'-]*){0,2}$/u.test(part)) return false;
  if (INSTITUTION_RE.test(part) || findDegree([part]) || matchMajor(part) || findDates(part).length > 0) return false;
  // "Ithaca" followed by "NY" is the town, not a campus.
  if (following && /^(?:[A-Z]{2}|[A-Z][a-z]+(?: [A-Z][a-z]+)?)$/.test(following) && locationRegex().test(`${part}, ${following}`)) return false;
  return true;
}

function datesFrom(lines: readonly string[], now: ResumeNow): DateMatch[] {
  return lines.filter((l) => !COURSE_LABEL.test(l) && !HONORS_LINE.test(l)).flatMap((l) => findDates(l, now));
}

export function parseEducationEntry(entry: Entry, now: ResumeNow): EducationEntry | null {
  const headerTexts = entry.header.map((l) => l.text);
  const all = [...headerTexts, ...entry.bullets, ...entry.notes];
  const degree = findDegree(all);
  const institution = institutionFrom(entry, degree, now);
  const area = areaFrom(all.filter((l) => !COURSE_LABEL.test(l)), degree);
  const gpa = findGpa(all);
  const courses: string[] = [];
  const highlights: string[] = [];
  for (const line of all) {
    const c = COURSE_LABEL.exec(line);
    if (c && c[1]) courses.push(...coursesFromText(c[1]));
    else if (HONORS_LINE.test(line)) highlights.push(...honorsFrom(trimPunctuation(line.replace(GPA_RE, " "))));
  }
  const dates = datesFrom(all, now);
  const grad = dates.find((d) => d.graduation) ?? null;
  const range = dates.find((d) => !d.single) ?? null;
  let startDate: string | null = null;
  let endDate: string | null = null;
  let expected = false;
  if (grad) {
    endDate = grad.end ?? grad.start;
    startDate = grad.single ? null : grad.start;
    expected = grad.expected || (endDate !== null && isFuture(endDate, now));
  } else if (range) {
    startDate = range.start;
    endDate = range.end;
    expected = range.expected || (endDate !== null && isFuture(endDate, now));
  } else if (dates[0]) {
    endDate = dates[0].end ?? dates[0].start;
    expected = endDate !== null && isFuture(endDate, now);
  }
  if (!institution && !degree && !area && !endDate) return null;
  return {
    institution,
    area,
    minor: minorFrom(all),
    studyType: degree && !/^(?:High\s+School|Secondary\s+School|Prep\w*\s+School)$/i.test(degree.text) ? degree.text : null,
    degreeLevel: degree?.level ?? null,
    startDate,
    endDate,
    endDateExpected: expected,
    score: gpa?.score ?? null,
    gpa: gpa?.gpa ?? null,
    courses,
    highlights: highlights.filter(Boolean),
  };
}
