import { CLASS_YEARS, EXPERIENCE_KINDS, MAJOR_FAMILIES, MAJOR_FAMILY_LABELS, type ClassYear, type ExperienceKind, type MajorFamily } from "../taxonomy";
import { academicYearStart } from "../time/terms";
import { detectSkills, normalizeSkillRefs, type SkillLike } from "./skills";
import { cleanShortText } from "./text";
import type { MatchSignals, SignalsInput } from "./types";

/**
 * Converts whatever shared/resume's toProfileSignals returns into MatchSignals, the closed,
 * PII-free shape matching reads (and the only resume-derived shape a server route accepts).
 * Unknown fields are ignored; malformed values are dropped rather than guessed.
 */

export const EMPTY_SIGNALS: MatchSignals = { skills: [], fields: [], coursework: [], experience: [], graduationYear: null };

const FAMILY_SET: ReadonlySet<string> = new Set(MAJOR_FAMILIES);
const FAMILY_BY_LABEL: ReadonlyMap<string, MajorFamily> = new Map(
  MAJOR_FAMILIES.map((f) => [MAJOR_FAMILY_LABELS[f].toLowerCase(), f]),
);
const EXPERIENCE_SET: ReadonlySet<string> = new Set(EXPERIENCE_KINDS);

/** Plain words a resume parser may use for experience, mapped to the taxonomy's kinds. */
const EXPERIENCE_SYNONYMS: Readonly<Record<string, ExperienceKind>> = {
  job: "paid_work",
  work: "paid_work",
  employment: "paid_work",
  part_time: "paid_work",
  part_time_job: "paid_work",
  internship: "internship",
  research: "research",
  project: "independent_project",
  projects: "independent_project",
  class_project: "independent_project",
  personal_project: "independent_project",
  volunteer: "community_service",
  volunteering: "community_service",
  service: "community_service",
  club: "leadership",
  leadership: "leadership",
  activity: "leadership",
  hackathon: "competition",
  competition: "competition",
  tutoring: "teaching_or_tutoring",
  teaching: "teaching_or_tutoring",
  insight: "insight_program",
};

export function toExperienceKinds(values: readonly unknown[]): ExperienceKind[] {
  const out = new Set<ExperienceKind>();
  for (const v of values) {
    if (typeof v !== "string") continue;
    const key = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (EXPERIENCE_SET.has(key)) out.add(key as ExperienceKind);
    else if (EXPERIENCE_SYNONYMS[key]) out.add(EXPERIENCE_SYNONYMS[key] as ExperienceKind);
  }
  return EXPERIENCE_KINDS.filter((k) => out.has(k));
}

function toFamily(v: unknown): MajorFamily | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (FAMILY_SET.has(t)) return t as MajorFamily;
  return FAMILY_BY_LABEL.get(t.toLowerCase()) ?? null;
}

function toYear(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 2000 && v <= 2100) return v;
  if (typeof v === "string" && /^\d{4}$/.test(v.trim())) return toYear(Number(v.trim()));
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    for (const key of ["graduation", "graduationYear", "expectedGraduation", "expectedGraduationYear", "end"]) {
      const y = toYear(o[key]);
      if (y !== null) return y;
    }
  }
  return null;
}

const COURSEWORK_SAFE = /^[A-Za-z0-9][A-Za-z0-9 &+#./-]*$/;

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Accepts shared/resume's ProfileSignals (coursework, experienceTypes, graduationYear), this
 * module's MatchSignals (experience) and the server's stored onboarding signals
 * (courseworkKeywords, experienceKinds, gradYear), so whichever shape integration passes, no
 * field is silently ignored.
 */
export function toMatchSignals(input: SignalsInput | MatchSignals | null | undefined): MatchSignals {
  if (!input) return EMPTY_SIGNALS;
  const source = input as SignalsInput;
  const fields: MajorFamily[] = [];
  for (const f of list(source.fields)) {
    const fam = toFamily(f);
    if (fam && fam !== "undeclared" && !fields.includes(fam)) fields.push(fam);
  }
  const coursework: string[] = [];
  for (const c of list(source.coursework ?? source.courseworkKeywords)) {
    if (typeof c !== "string") continue;
    const cleaned = cleanShortText(c, 40);
    if (cleaned && COURSEWORK_SAFE.test(cleaned) && !coursework.includes(cleaned)) coursework.push(cleaned);
  }
  const experienceRaw = list(source.experienceTypes ?? source.experience ?? source.experienceKinds);
  return {
    skills: normalizeSkillRefs(list(source.skills) as readonly SkillLike[], 40),
    fields: fields.slice(0, 4),
    coursework: coursework.slice(0, 20),
    experience: toExperienceKinds(experienceRaw),
    graduationYear: toYear(source.graduationYear ?? source.years ?? source.gradYear ?? null),
  };
}

/** Skills implied by coursework names ("Statistics", "Intro to Python"). */
export function courseworkSkills(signals: MatchSignals): string[] {
  const out = new Set<string>();
  for (const c of signals.coursework) for (const id of detectSkills(c)) out.add(id);
  return [...out];
}

/**
 * Class year implied by an expected (spring) graduation year, for the "Is this right?" chip.
 * The student confirms it; a wrong guess costs one tap.
 */
export function classYearFromGraduation(graduationYear: number, today: string): ClassYear | null {
  const yearsLeft = graduationYear - (academicYearStart(today) + 1);
  if (yearsLeft < 0) return "recent_graduate";
  const byYearsLeft: readonly ClassYear[] = ["fourth_year", "third_year", "second_year", "first_year", "incoming_first_year"];
  const cy = byYearsLeft[yearsLeft];
  return cy && (CLASS_YEARS as readonly string[]).includes(cy) ? cy : null;
}
