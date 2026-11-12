import {
  CLASS_YEARS,
  CLASS_YEAR_LABELS,
  EXPERIENCE_KINDS,
  GPA_BANDS,
  INSTITUTION_LEVELS,
  MAJOR_FAMILIES,
  MAJOR_FAMILY_LABELS,
  OPPORTUNITY_CATEGORIES,
  OPPORTUNITY_CATEGORY_KEYS,
  PRIMARY_CLASS_YEARS,
  StudentProfileUpdateSchema,
  TRANSFER_INTENTS,
  findSensitiveKeys,
  type ClassYear,
  type ExperienceKind,
  type GpaBand,
  type InstitutionLevel,
  type MajorFamily,
  type OpportunityCategory,
  type OpportunityTypeSlug,
  type StudentProfileUpdate,
  type TransferIntent,
} from "@shared/contracts";
import { formatTermKey, parseIsoDate } from "@shared/time";

/**
 * Onboarding: a short flow that fills the non-sensitive StudentProfile. Status and identity
 * questions are not asked here at all; when a program depends on them, its page asks on the
 * device. The draft is a plain object so the flow can be tested without React.
 */

export const ONBOARDING_DRAFT_KEY = "novus-onboarding-draft-v1";

export const STEPS = ["age", "year", "study", "interests", "review"] as const;
export type Step = (typeof STEPS)[number];

export const STEP_TITLES: Record<Step, string> = {
  age: "Your age",
  year: "Your year",
  study: "What you study",
  interests: "What you are looking for",
  review: "Check and save",
};

export interface Draft {
  readonly birthMonth: number | null;
  readonly birthYear: number | null;
  readonly classYear: ClassYear | null;
  readonly graduationTerm: string | null;
  readonly institutionLevel: InstitutionLevel | null;
  readonly transferIntent: TransferIntent | null;
  readonly majorFamily: MajorFamily | null;
  readonly gpaBand: GpaBand | null;
  readonly categories: readonly OpportunityCategory[];
  readonly interestTags: readonly string[];
  readonly priorExperience: readonly ExperienceKind[];
  readonly weeklyPrepHours: number | null;
}

export const EMPTY_DRAFT: Draft = {
  birthMonth: null,
  birthYear: null,
  classYear: null,
  graduationTerm: null,
  institutionLevel: null,
  transferIntent: null,
  majorFamily: null,
  gpaBand: null,
  categories: [],
  interestTags: [],
  priorExperience: [],
  weeklyPrepHours: null,
};

// ---------------------------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------------------------

export type AgeBand = "under_16" | "minor" | "adult";

/**
 * Age band from month and year only. In the birth month itself the birthday may not have come
 * yet, so the lower age is used: the gate never lets an under-16 student through by rounding.
 */
export function ageBand(birthYear: number, birthMonth: number, today: string): AgeBand {
  const d = parseIsoDate(today);
  if (!d) throw new RangeError(`invalid date: ${today}`);
  const months = d.year * 12 + d.month - (birthYear * 12 + birthMonth);
  const age = Math.floor(months / 12) - (months % 12 === 0 ? 1 : 0);
  if (age < 16) return "under_16";
  if (age < 18) return "minor";
  return "adult";
}

/** Birth years to offer: a wide range with no hint of where any cutoff sits. */
export function birthYearOptions(today: string): number[] {
  const year = Number(today.slice(0, 4));
  const out: number[] = [];
  for (let y = year - 12; y >= year - 70; y--) out.push(y);
  return out;
}

export function birthYearMonth(draft: Draft): string | null {
  if (draft.birthYear === null || draft.birthMonth === null) return null;
  return `${draft.birthYear}-${String(draft.birthMonth).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

/** Class years with the primary audience first. */
export const CLASS_YEAR_OPTIONS = [
  ...PRIMARY_CLASS_YEARS,
  ...CLASS_YEARS.filter((c) => !(PRIMARY_CLASS_YEARS as readonly string[]).includes(c)),
].map((value) => ({ value, label: CLASS_YEAR_LABELS[value] }));

export const MAJOR_FAMILY_OPTIONS = MAJOR_FAMILIES.map((value) => ({ value, label: MAJOR_FAMILY_LABELS[value] }));

export const INSTITUTION_LEVEL_OPTIONS: { value: InstitutionLevel; label: string }[] = INSTITUTION_LEVELS.map((value) => ({
  value,
  label: value === "two_year" ? "Community or two-year college" : value === "four_year" ? "Four-year college or university" : "Something else",
}));

export const TRANSFER_INTENT_OPTIONS: { value: TransferIntent; label: string }[] = TRANSFER_INTENTS.map((value) => ({
  value,
  label: { planning_to_transfer: "Planning to transfer", transferred_in: "I transferred in", not_planning: "Not planning to", not_sure: "Not sure" }[value],
}));

const GPA_LABELS: Record<GpaBand, string> = {
  none_yet: "No GPA yet",
  under_2_0: "Under 2.0",
  "2_0_to_2_49": "2.0 to 2.49",
  "2_5_to_2_74": "2.5 to 2.74",
  "2_75_to_2_99": "2.75 to 2.99",
  "3_0_to_3_24": "3.0 to 3.24",
  "3_25_to_3_49": "3.25 to 3.49",
  "3_5_to_3_74": "3.5 to 3.74",
  "3_75_plus": "3.75 or higher",
  prefer_not: "Prefer not to say",
};
export const GPA_OPTIONS = GPA_BANDS.map((value) => ({ value, label: GPA_LABELS[value] }));

export const CATEGORY_LABELS: Record<OpportunityCategory, string> = {
  internships: "Internships",
  fellowships: "Fellowships",
  research: "Research",
  apprenticeships: "Apprenticeships",
  scholarships: "Scholarships",
  insight_weeks: "Insight weeks",
  sprints: "Sprints",
  conferences: "Conferences and competitions",
};
export const CATEGORY_OPTIONS = OPPORTUNITY_CATEGORY_KEYS.map((value) => ({ value, label: CATEGORY_LABELS[value] }));

const EXPERIENCE_LABELS: Record<ExperienceKind, string> = {
  research: "Research",
  internship: "An internship",
  insight_program: "An insight program",
  leadership: "Leading a club or team",
  community_service: "Community service",
  independent_project: "A project of my own",
  paid_work: "A paid job",
  competition: "A competition or hackathon",
  teaching_or_tutoring: "Teaching or tutoring",
};
export const EXPERIENCE_OPTIONS = EXPERIENCE_KINDS.map((value) => ({ value, label: EXPERIENCE_LABELS[value] }));

export const PREP_HOURS_OPTIONS = [
  { value: "2", label: "About 1 to 2 hours a week" },
  { value: "4", label: "About 3 to 5 hours a week" },
  { value: "8", label: "About 6 to 10 hours a week" },
  { value: "12", label: "More than 10 hours a week" },
] as const;

/** Interest ideas shown as chips; students may add their own. */
export const INTEREST_SUGGESTIONS = [
  "climate",
  "software",
  "public health",
  "finance",
  "policy",
  "design",
  "data science",
  "education",
  "biotech",
  "journalism",
  "entrepreneurship",
  "law",
] as const;

/** Graduation terms from the current term out about six years. */
export function graduationTermOptions(today: string): { value: string; label: string }[] {
  const d = parseIsoDate(today);
  if (!d) return [];
  const out: { value: string; label: string }[] = [];
  const seasons = ["spring", "summer", "fall", "winter"] as const;
  for (let y = d.year; y <= d.year + 6; y++) {
    for (const s of seasons) {
      if (y === d.year && ((s === "spring" && d.month > 5) || (s === "summer" && d.month > 8) || s === "winter")) continue;
      out.push({ value: formatTermKey(s, y), label: `${s[0]?.toUpperCase()}${s.slice(1)} ${y}` });
    }
  }
  return out;
}

export type TagCheck = { readonly ok: true; readonly tag: string } | { readonly ok: false; readonly reason: "length" | "characters" | "sensitive" };

/**
 * A free-text interest tag: trimmed, lower-case, letters, digits, spaces and a few marks. Tags
 * that look like a status or identity detail ("first gen", "veteran") are refused, because the
 * profile is stored on the server and such answers stay on the device.
 */
export function checkTag(raw: string): TagCheck {
  const tag = raw.trim().replace(/\s+/g, " ").toLowerCase();
  if (tag.length < 2 || tag.length > 40) return { ok: false, reason: "length" };
  if (!/^[\p{L}\p{N} &+.'/-]+$/u.test(tag)) return { ok: false, reason: "characters" };
  const asKey = tag.replace(/[^a-z0-9]+/g, "_");
  if (findSensitiveKeys({ [asKey]: true, [asKey.replace(/_/g, "")]: true }).length > 0) return { ok: false, reason: "sensitive" };
  return { ok: true, tag };
}

export function normalizeTag(raw: string): string | null {
  const r = checkTag(raw);
  return r.ok ? r.tag : null;
}

// ---------------------------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------------------------

export function stepIndex(step: Step): number {
  return STEPS.indexOf(step);
}

export function nextStep(step: Step): Step {
  return STEPS[Math.min(stepIndex(step) + 1, STEPS.length - 1)] as Step;
}

export function previousStep(step: Step): Step {
  return STEPS[Math.max(stepIndex(step) - 1, 0)] as Step;
}

/** What is missing before the student can continue; empty when the step is complete. */
export function missingFor(step: Step, draft: Draft): string[] {
  switch (step) {
    case "age":
      return draft.birthMonth === null || draft.birthYear === null ? ["birth month and year"] : [];
    case "year":
      return draft.classYear === null ? ["class year"] : [];
    case "study":
      return draft.majorFamily === null ? ["field of study"] : [];
    case "interests":
      return draft.categories.length === 0 ? ["at least one kind of opportunity"] : [];
    case "review":
      return STEPS.filter((s) => s !== "review").flatMap((s) => missingFor(s, draft));
  }
}

export function preferredTypes(categories: readonly OpportunityCategory[]): OpportunityTypeSlug[] {
  const out = new Set<OpportunityTypeSlug>();
  for (const c of categories) for (const slug of OPPORTUNITY_CATEGORIES[c]) out.add(slug);
  return [...out];
}

/** Picks the categories a saved profile's preferred types cover (for editing an existing profile). */
export function categoriesFromTypes(types: readonly string[]): OpportunityCategory[] {
  const set = new Set(types);
  return OPPORTUNITY_CATEGORY_KEYS.filter((c) => OPPORTUNITY_CATEGORIES[c].some((slug) => set.has(slug)));
}

/**
 * The PATCH body. Validated with the strict contract schema, and checked once more for any key
 * that looks like a status or identity answer, so a future field cannot leak one by accident.
 */
export function buildProfileUpdate(draft: Draft): StudentProfileUpdate {
  const body = {
    birthYearMonth: birthYearMonth(draft),
    classYear: draft.classYear,
    expectedGraduationTerm: draft.graduationTerm,
    institutionLevel: draft.institutionLevel,
    transferIntent: draft.institutionLevel === "two_year" ? draft.transferIntent : null,
    majorFamily: draft.majorFamily,
    gpaBand: draft.gpaBand,
    preferredOpportunityTypes: preferredTypes(draft.categories),
    interestTags: [...draft.interestTags],
    priorExperience: [...draft.priorExperience],
    weeklyPrepHours: draft.weeklyPrepHours,
  };
  const leaked = findSensitiveKeys(body);
  if (leaked.length > 0) throw new Error(`profile update carries sensitive keys: ${leaked.join(", ")}`);
  return StudentProfileUpdateSchema.parse(body);
}

// ---------------------------------------------------------------------------------------------
// Draft storage (non-sensitive; a per-device convenience)
// ---------------------------------------------------------------------------------------------

const DRAFT_FIELDS = Object.keys(EMPTY_DRAFT) as (keyof Draft)[];

/** Restores a stored draft, keeping only known fields with the right shape. */
export function parseDraft(raw: string | null): Draft {
  if (!raw) return EMPTY_DRAFT;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return EMPTY_DRAFT;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return EMPTY_DRAFT;
  const src = data as Record<string, unknown>;
  const pick = <K extends keyof Draft>(key: K, ok: (v: unknown) => boolean): Draft[K] => (ok(src[key]) ? (src[key] as Draft[K]) : EMPTY_DRAFT[key]);
  const isInt = (v: unknown) => typeof v === "number" && Number.isInteger(v);
  const inList = (list: readonly string[]) => (v: unknown) => typeof v === "string" && list.includes(v);
  const listOf = (list: readonly string[]) => (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string" && list.includes(x));
  const draft: Draft = {
    birthMonth: pick("birthMonth", (v) => isInt(v) && (v as number) >= 1 && (v as number) <= 12),
    birthYear: pick("birthYear", (v) => isInt(v) && (v as number) > 1900 && (v as number) < 2100),
    classYear: pick("classYear", inList(CLASS_YEARS)),
    graduationTerm: pick("graduationTerm", (v) => typeof v === "string" && /^(winter|spring|summer|fall)-\d{4}$/.test(v)),
    institutionLevel: pick("institutionLevel", inList(INSTITUTION_LEVELS)),
    transferIntent: pick("transferIntent", inList(TRANSFER_INTENTS)),
    majorFamily: pick("majorFamily", inList(MAJOR_FAMILIES)),
    gpaBand: pick("gpaBand", inList(GPA_BANDS)),
    categories: pick("categories", listOf(OPPORTUNITY_CATEGORY_KEYS)),
    interestTags: pick("interestTags", (v) => Array.isArray(v) && v.length <= 30 && v.every((t) => typeof t === "string" && normalizeTag(t) === t)),
    priorExperience: pick("priorExperience", listOf(EXPERIENCE_KINDS)),
    weeklyPrepHours: pick("weeklyPrepHours", (v) => v === null || (isInt(v) && (v as number) >= 0 && (v as number) <= 60)),
  };
  // Fields never seen in a stored draft fall back to empty; unknown keys are dropped.
  return Object.fromEntries(DRAFT_FIELDS.map((k) => [k, draft[k]])) as unknown as Draft;
}

/** Starts a draft from a saved profile, so returning students edit rather than retype. */
export function draftFromProfile(profile: {
  readonly birthYearMonth: string | null;
  readonly classYear: ClassYear | null;
  readonly expectedGraduationTerm: string | null;
  readonly institutionLevel: InstitutionLevel | null;
  readonly transferIntent: TransferIntent | null;
  readonly majorFamily: MajorFamily | null;
  readonly gpaBand: GpaBand | null;
  readonly preferredOpportunityTypes: readonly string[];
  readonly interestTags: readonly string[];
  readonly priorExperience: readonly ExperienceKind[];
  readonly weeklyPrepHours: number | null;
}): Draft {
  const ym = profile.birthYearMonth ? /^(\d{4})-(\d{2})$/.exec(profile.birthYearMonth) : null;
  return {
    birthYear: ym ? Number(ym[1]) : null,
    birthMonth: ym ? Number(ym[2]) : null,
    classYear: profile.classYear,
    graduationTerm: profile.expectedGraduationTerm,
    institutionLevel: profile.institutionLevel,
    transferIntent: profile.transferIntent,
    majorFamily: profile.majorFamily,
    gpaBand: profile.gpaBand,
    categories: categoriesFromTypes(profile.preferredOpportunityTypes),
    interestTags: profile.interestTags.filter((t) => normalizeTag(t) === t),
    priorExperience: [...profile.priorExperience],
    weeklyPrepHours: profile.weeklyPrepHours,
  };
}

export function isDraftEmpty(draft: Draft): boolean {
  return JSON.stringify(draft) === JSON.stringify(EMPTY_DRAFT);
}
