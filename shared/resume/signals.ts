import { z } from "zod";
import { CLASS_YEARS, EXPERIENCE_KINDS, MAJOR_FAMILIES, type ClassYear, type ExperienceKind } from "../taxonomy";
import { isoParts, resolveNow, type ResumeNow } from "./dates";
import { COURSE_KEYWORDS } from "./lexicon/coursework";
import { MAJORS } from "./lexicon/majors";
import { SKILLS } from "./lexicon/skills";
import { COMPETITION_RE } from "./lexicon/roles";
import { matchMajors } from "./majors";
import { normalizeSkills } from "./skills";
import { uniqueBy } from "./text";
import { DEGREE_LEVELS, SKILL_CATEGORIES } from "./types";
import type { DegreeLevel, EducationEntry, NowInput, ParsedResume, ProfileSignals, ResumeEntryKind } from "./types";

/**
 * toProfileSignals: the non-PII facts matching may use, taken from a ParsedResume on the device.
 *
 * Every string in the result comes from a closed list (the curated skills, majors and
 * coursework keywords, or shared/taxonomy), so nothing the student typed can pass through: an
 * unknown skill, an organization or a sentence has no way into these fields. The zod schema
 * below enforces the same closed lists for a server that receives signals.
 */

/** Caps that match what shared/onboarding's MatchSignals accepts. */
export const SIGNAL_LIMITS = { skills: 40, fields: 4, majors: 6, coursework: 20 } as const;

const ENTRY_TO_EXPERIENCE: Record<ResumeEntryKind, ExperienceKind | null> = {
  internship: "internship",
  research: "research",
  work: "paid_work",
  part_time: "paid_work",
  leadership: "leadership",
  // Membership is not leadership, and the taxonomy has no "club" kind, so it adds nothing
  // rather than overstating what the student did.
  club: null,
  volunteer: "community_service",
  teaching: "teaching_or_tutoring",
  insight: "insight_program",
  competition: "competition",
};

/** Higher means further along; used to pick the program the student is in now. */
const LEVEL_RANK: Record<DegreeLevel, number> = { high_school: 0, certificate: 1, associate: 2, bachelor: 3, master: 4, doctorate: 5 };

/** Academic years run from August (shared/config's academicYearStartMonth). */
const ACADEMIC_YEAR_START_MONTH = 8;

function academicYearEnd(year: number, month: number): number {
  return month >= ACADEMIC_YEAR_START_MONTH ? year + 1 : year;
}

/**
 * The education entry the student is in now: an expected graduation first, then the highest
 * level, then the latest end date. High school counts only when nothing else is listed.
 */
export function primaryEducation(education: readonly EducationEntry[]): EducationEntry | null {
  if (education.length === 0) return null;
  const college = education.filter((e) => e.degreeLevel !== "high_school");
  const pool = college.length > 0 ? college : education;
  const score = (e: EducationEntry): number => {
    const end = e.endDate ? isoParts(e.endDate) : null;
    return (e.endDateExpected ? 1_000_000 : 0) + (e.degreeLevel ? LEVEL_RANK[e.degreeLevel] * 10_000 : 0) + (end ? end.year * 12 + end.month - 20_000 : 0);
  };
  return [...pool].sort((a, b) => score(b) - score(a))[0] ?? null;
}

const STATED_YEAR: ReadonlyArray<readonly [RegExp, ClassYear]> = [
  [/\b(?:freshman|first[- ]year\s+student|1st[- ]year\s+student)\b/i, "first_year"],
  [/\b(?:sophomore|second[- ]year\s+student|2nd[- ]year\s+student)\b/i, "second_year"],
  [/\b(?:junior|third[- ]year\s+student|3rd[- ]year\s+student)\b/i, "third_year"],
  [/\b(?:senior|fourth[- ]year\s+student|4th[- ]year\s+student)\b/i, "fourth_year"],
];
/** "Senior Thesis", "Junior Seminar" and the like name a course, not a year. */
const NOT_A_YEAR = /\b(?:freshman|sophomore|junior|senior)\s+(?:thesis|seminar|project|capstone|design|year\s+project|honors|paper|writing|composition)\b/i;

/** A class year the education section states outright ("Sophomore", "second-year student"). */
function statedClassYear(parsed: ParsedResume): ClassYear | null {
  const lines = (parsed.sections ?? []).filter((s) => s.key === "education").flatMap((s) => s.lines ?? []);
  for (const line of lines) {
    if (NOT_A_YEAR.test(line)) continue;
    for (const [re, year] of STATED_YEAR) if (re.test(line)) return year;
  }
  return null;
}

/**
 * Class year from the expected graduation date: years left = the graduation's academic year
 * minus this academic year. On 2026-11-11 a class of 2030 is first-year and a class of 2029
 * second-year. Two-year degrees count down from second year; a high school entry still in
 * progress means an incoming first-year.
 */
export function inferClassYear(endIso: string | null, level: DegreeLevel | null, nowInput?: NowInput | ResumeNow): ClassYear | null {
  const end = endIso ? isoParts(endIso) : null;
  if (!end) return null;
  const now = isResumeNow(nowInput) ? nowInput : resolveNow(nowInput);
  const yearsLeft = academicYearEnd(end.year, end.month) - academicYearEnd(now.year, now.month);
  if (level === "master" || level === "doctorate") return yearsLeft >= 0 ? "graduate" : null;
  if (level === "high_school") return yearsLeft >= 0 && yearsLeft <= 1 ? "incoming_first_year" : null;
  if (yearsLeft < 0) return "recent_graduate";
  const ladder: readonly ClassYear[] =
    level === "associate" || level === "certificate"
      ? ["second_year", "first_year", "incoming_first_year"]
      : ["fourth_year", "third_year", "second_year", "first_year", "incoming_first_year"];
  return ladder[yearsLeft] ?? null;
}

function isResumeNow(v: unknown): v is ResumeNow {
  return !!v && typeof v === "object" && !(v instanceof Date) && "year" in v && "month" in v && "day" in v;
}

/** Months covered by dated entries, overlaps counted once; open ranges run to this month. */
export function experienceMonths(parsed: ParsedResume, now: ResumeNow): number {
  const months = new Set<number>();
  const nowIndex = now.year * 12 + now.month;
  for (const e of parsed.experience ?? []) {
    const start = e.startDate ? isoParts(e.startDate) : null;
    if (!start) continue;
    const end = e.endDate ? isoParts(e.endDate) : e.current ? { year: now.year, month: now.month } : start;
    if (!end) continue;
    // A bare year ("2025") reads as June; keep a single-year entry to one month, not a year.
    const from = start.year * 12 + start.month;
    const to = Math.min(end.year * 12 + end.month, nowIndex);
    for (let m = from; m <= to && months.size < 600; m++) months.add(m);
  }
  return months.size;
}

function courseworkKeywords(courses: readonly string[]): string[] {
  const out: string[] = [];
  for (const course of courses) {
    for (const k of COURSE_KEYWORDS) {
      if (out.length >= SIGNAL_LIMITS.coursework) return out;
      if (!out.includes(k.keyword) && k.pattern.test(course)) out.push(k.keyword);
    }
  }
  return out;
}

export interface ProfileSignalsOptions {
  /** "Now" for class-year inference and open date ranges. Defaults to the current date. */
  now?: NowInput;
}

export function toProfileSignals(parsed: ParsedResume, options: ProfileSignalsOptions = {}): ProfileSignals {
  const now = resolveNow(options.now);
  const education = parsed?.education ?? [];

  const known = uniqueBy(
    normalizeSkills(parsed?.skills ?? []).filter((s) => s.known),
    (s) => s.id,
  ).slice(0, SIGNAL_LIMITS.skills);
  const skillCategories = SKILL_CATEGORIES.filter((c) => known.some((s) => s.category === c));

  // Order matters: the quiz prefills "What do you study?" from fields[0], so the primary
  // entry's major comes first, then its minor, then other entries' majors and minors. Sorting by
  // taxonomy order would let a minor ("Minor in Business") outrank the major ("Nursing").
  const primaryEntry = primaryEducation(education);
  const ordered = primaryEntry ? [primaryEntry, ...education.filter((e) => e !== primaryEntry)] : education;
  const majorMatches = ordered.flatMap((e) => [...(e.area ? matchMajors(e.area) : []), ...(e.minor ? matchMajors(e.minor) : [])]);
  const majors = [...new Set(majorMatches.map((m) => m.name))].slice(0, SIGNAL_LIMITS.majors);
  // Real families first, in that order; "undeclared" only when nothing else is known.
  const fields = [...new Set(majorMatches.map((m) => m.family))]
    .filter((f): f is (typeof MAJOR_FAMILIES)[number] => f !== "undeclared" && (MAJOR_FAMILIES as readonly string[]).includes(f))
    .slice(0, SIGNAL_LIMITS.fields);
  if (fields.length === 0 && majorMatches.some((m) => m.family === "undeclared")) fields.push("undeclared");

  const courses = [...(parsed?.coursework ?? []), ...education.flatMap((e) => e.courses ?? [])];
  const coursework = courseworkKeywords(courses);

  const kinds = new Set<ExperienceKind>();
  for (const e of parsed?.experience ?? []) {
    const kind = ENTRY_TO_EXPERIENCE[e.kind];
    if (kind) kinds.add(kind);
  }
  if ((parsed?.projects ?? []).length > 0) kinds.add("independent_project");
  if ((parsed?.awards ?? []).some((a) => COMPETITION_RE.test(a))) kinds.add("competition");
  const experienceTypes = EXPERIENCE_KINDS.filter((k) => kinds.has(k));

  const primary = primaryEntry;
  const graduationYear = primary?.endDate ? (isoParts(primary.endDate)?.year ?? null) : null;
  const stated = statedClassYear(parsed);
  const inferred = primary ? inferClassYear(primary.endDate, primary.degreeLevel, now) : null;

  return {
    skills: known.map((s) => s.name),
    skillCategories,
    fields,
    majors,
    coursework,
    experienceTypes,
    degreeLevel: primary?.degreeLevel ?? null,
    graduationYear: graduationYear !== null && graduationYear >= 1950 && graduationYear <= now.year + 8 ? graduationYear : null,
    classYear: stated ?? inferred,
    classYearInferred: stated === null && inferred !== null,
    experienceMonths: experienceMonths(parsed, now),
  };
}

// -------------------------------------------------------------------------------------------
// Schema: the closed vocabularies, enforced for anything that receives signals
// -------------------------------------------------------------------------------------------

const asEnum = (values: readonly string[]): z.ZodEnum<[string, ...string[]]> => z.enum([...new Set(values)] as [string, ...string[]]);

export const ProfileSignalsSchema = z
  .object({
    skills: z.array(asEnum(SKILLS.map((s) => s.name))).max(SIGNAL_LIMITS.skills),
    skillCategories: z.array(z.enum(SKILL_CATEGORIES)).max(SKILL_CATEGORIES.length),
    fields: z.array(z.enum(MAJOR_FAMILIES)).max(SIGNAL_LIMITS.fields),
    majors: z.array(asEnum(MAJORS.map((m) => m.name))).max(SIGNAL_LIMITS.majors),
    coursework: z.array(asEnum(COURSE_KEYWORDS.map((k) => k.keyword))).max(SIGNAL_LIMITS.coursework),
    experienceTypes: z.array(z.enum(EXPERIENCE_KINDS)).max(EXPERIENCE_KINDS.length),
    degreeLevel: z.enum(DEGREE_LEVELS).nullable(),
    graduationYear: z.number().int().min(1950).max(2100).nullable(),
    classYear: z.enum(CLASS_YEARS).nullable(),
    classYearInferred: z.boolean(),
    experienceMonths: z.number().int().min(0).max(600),
  })
  .strict();

// Compile-time check that the schema and the interface agree.
type SchemaShape = z.infer<typeof ProfileSignalsSchema>;
const _shapeCheck: (s: ProfileSignals) => SchemaShape = (s) => s;
void _shapeCheck;
