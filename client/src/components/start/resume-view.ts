import { MAJOR_FAMILY_LABELS, type MajorFamily } from "@shared/contracts";

/**
 * View helpers for the resume step: what the student sees and corrects after the on-device
 * parse, the "no resume" mini builder, and signal shaping. ParsedResume comes from
 * @shared/resume (built in parallel); these readers take `unknown` and use the agreed JSON
 * Resume-style field names, so they are testable without that module.
 */

/** Experience kinds as @shared/resume names them (RESUME_ENTRY_KINDS). */
export type ExperienceKindLabel = "internship" | "research" | "work" | "part_time" | "leadership" | "club" | "volunteer" | "teaching" | "insight" | "competition";

export const EXPERIENCE_KIND_OPTIONS: Array<{ value: ExperienceKindLabel; label: string }> = [
  { value: "internship", label: "Internship" },
  { value: "research", label: "Research" },
  { value: "work", label: "Job" },
  { value: "part_time", label: "Part-time job" },
  { value: "leadership", label: "Leadership" },
  { value: "club", label: "Club or team" },
  { value: "volunteer", label: "Volunteering" },
  { value: "teaching", label: "Tutoring or teaching" },
  { value: "insight", label: "Insight program" },
  { value: "competition", label: "Competition" },
];

export interface ReviewEducation {
  institution: string | null;
  area: string | null;
  studyType: string | null;
  endDate: string | null;
}

export interface ReviewExperience {
  index: number;
  title: string | null;
  organization: string | null;
  kind: ExperienceKindLabel;
  dates: string | null;
  highlights: string[];
}

export interface ReviewView {
  /** Device-only contact items, shown so the student knows they were found and kept here. */
  contactFound: string[];
  education: ReviewEducation[];
  experience: ReviewExperience[];
  projects: Array<{ name: string | null; highlights: string[] }>;
  skills: string[];
  coursework: string[];
  warnings: string[];
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strings = (v: unknown): string[] =>
  list(v)
    .map((x) => (typeof x === "string" ? x : s(rec(x).label) ?? s(rec(x).name) ?? s(rec(x).text) ?? s(rec(x).code)))
    .filter((x): x is string => !!x && !!x.trim());

const KIND_VALUES = new Set(EXPERIENCE_KIND_OPTIONS.map((o) => o.value));

/** Unknown kinds read as "work" so a corrected entry always holds a kind the parser knows. */
function readKind(v: unknown): ExperienceKindLabel {
  if (typeof v !== "string") return "work";
  const k = v === "part-time" ? "part_time" : v;
  return KIND_VALUES.has(k as ExperienceKindLabel) ? (k as ExperienceKindLabel) : "work";
}

function dateRange(e: Rec): string | null {
  const a = s(e.startDate);
  const b = s(e.endDate) ?? (e.current === true || e.open === true ? "Present" : null);
  if (a && b) return `${a} to ${b}`;
  return a ?? b;
}

/** Builds the review model from a ParsedResume. Contact values are listed by label only. */
export function reviewFromParsed(parsed: unknown): ReviewView {
  const p = rec(parsed);
  const contact = rec(p.contact);
  const contactFound: string[] = [];
  if (s(contact.name)) contactFound.push("Name");
  if (s(contact.email)) contactFound.push("Email");
  if (s(contact.phone)) contactFound.push("Phone");
  if (s(contact.location) || s(rec(contact.location).city)) contactFound.push("Location");
  const linkCount = list(p.links).length + list(contact.profiles).length;
  if (linkCount) contactFound.push(linkCount === 1 ? "1 link" : `${linkCount} links`);

  return {
    contactFound,
    education: list(p.education).map((x) => {
      const e = rec(x);
      return { institution: s(e.institution), area: s(e.area), studyType: s(e.studyType), endDate: s(e.endDate) };
    }),
    experience: list(p.experience).map((x, index) => {
      const e = rec(x);
      return {
        index,
        title: s(e.position) ?? s(e.title) ?? s(e.role),
        organization: s(e.name) ?? s(e.organization) ?? s(e.company),
        kind: readKind(e.kind),
        dates: dateRange(e),
        highlights: strings(e.highlights).slice(0, 4),
      };
    }),
    projects: list(p.projects).map((x) => {
      const e = rec(x);
      return { name: s(e.name), highlights: strings(e.highlights).concat(s(e.description) ? [s(e.description)!] : []).slice(0, 3) };
    }),
    skills: strings(p.skills),
    coursework: strings(p.coursework),
    warnings: strings(p.warnings),
  };
}

export interface ReviewEdits {
  skills: string[];
  coursework: string[];
  major: string | null;
  gradDate: string | null;
  /** Experience entries the student removed (by index). */
  removedExperience: number[];
  /** Kind corrections by experience index. */
  kinds: Record<number, ExperienceKindLabel>;
}

export function editsFromReview(v: ReviewView): ReviewEdits {
  return {
    skills: [...v.skills],
    coursework: [...v.coursework],
    major: v.education[0]?.area ?? null,
    gradDate: v.education[0]?.endDate ?? null,
    removedExperience: [],
    kinds: {},
  };
}

/**
 * Applies the student's corrections to a ParsedResume, keeping every field we do not edit
 * (contact stays as parsed, on the device). Returns a new object; the input is not mutated.
 */
export function applyReviewEdits<T>(parsed: T, edits: ReviewEdits): T {
  const p = rec(parsed);
  const education = list(p.education).map((x, i) => (i === 0 ? { ...rec(x), area: edits.major ?? undefined, endDate: edits.gradDate ?? undefined } : x));
  if (!education.length && (edits.major || edits.gradDate)) {
    education.push({ area: edits.major ?? undefined, endDate: edits.gradDate ?? undefined });
  }
  const experience = list(p.experience)
    .map((x, i) => ({ x: rec(x), i }))
    .filter(({ i }) => !edits.removedExperience.includes(i))
    .map(({ x, i }) => (edits.kinds[i] ? { ...x, kind: edits.kinds[i] } : x));
  return {
    ...p,
    education,
    experience,
    skills: dedupe(edits.skills),
    coursework: dedupe(edits.coursework),
  } as T;
}

export function dedupe(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const t = raw.replace(/\s+/g, " ").trim();
    const k = t.toLowerCase();
    if (!t || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** Splits a typed chip entry ("Python, SQL; Excel") into terms. */
export function splitTerms(input: string): string[] {
  return dedupe(input.split(/[,;|•\n]/).map((x) => x.slice(0, 60)));
}

/* ---------- no-resume mini builder ---------- */

export interface BuilderAnswers {
  project: string;
  activity: string;
  skills: string;
}

/**
 * Three quick answers to a small plain-text resume, so the same parser, redaction and signal
 * code runs whether or not the student has a resume. Headings use the parser's lexicon.
 */
export function builderToText(a: BuilderAnswers): string {
  const parts: string[] = [];
  if (a.project.trim()) parts.push("PROJECTS", `- ${a.project.trim()}`);
  if (a.activity.trim()) parts.push("ACTIVITIES", `- ${a.activity.trim()}`);
  const skills = splitTerms(a.skills);
  if (skills.length) parts.push("SKILLS", skills.join(", "));
  return parts.join("\n");
}

export function builderIsEmpty(a: BuilderAnswers): boolean {
  return !a.project.trim() && !a.activity.trim() && !a.skills.trim();
}

/* ---------- signals ---------- */

/** ProfileSignals in the server's vocabulary (server/api/v1/onboarding/schemas.ts). */
export interface SignalsView {
  skills: string[];
  fields: string[];
  courseworkKeywords: string[];
  experienceKinds: string[];
  gradYear: number | null;
}

export const EMPTY_SIGNALS: SignalsView = { skills: [], fields: [], courseworkKeywords: [], experienceKinds: [], gradYear: null };

const TERM = /^[^\n\r<>]{1,60}$/;

/** Reads toProfileSignals output tolerantly and keeps only short single-line terms. */
export function normalizeSignals(input: unknown): SignalsView {
  const r = rec(input);
  // Check the raw value first: dedupe collapses whitespace, which would hide a line break.
  const terms = (v: unknown, max: number) => dedupe(strings(v).filter((t) => TERM.test(t))).slice(0, max);
  const year = typeof r.gradYear === "number" ? r.gradYear : typeof r.graduationYear === "number" ? r.graduationYear : null;
  return {
    skills: terms(r.skills, 60),
    fields: terms(r.fields ?? r.fieldsOfStudy, 10),
    courseworkKeywords: terms(r.courseworkKeywords ?? r.coursework, 40),
    experienceKinds: terms(r.experienceKinds ?? r.experienceTypes, 12),
    gradYear: year !== null && year >= 2000 && year <= 2040 ? Math.trunc(year) : null,
  };
}

/** Merges AI-suggested terms the student accepted into the deterministic signals. */
export function mergeSignals(base: SignalsView, extra: Partial<SignalsView>): SignalsView {
  return {
    skills: dedupe([...base.skills, ...(extra.skills ?? [])]).slice(0, 60),
    fields: dedupe([...base.fields, ...(extra.fields ?? [])]).slice(0, 10),
    courseworkKeywords: dedupe([...base.courseworkKeywords, ...(extra.courseworkKeywords ?? [])]).slice(0, 40),
    experienceKinds: dedupe([...base.experienceKinds, ...(extra.experienceKinds ?? [])]).slice(0, 12),
    gradYear: base.gradYear ?? extra.gradYear ?? null,
  };
}

/**
 * Year in school inferred from a graduation year (study notes): academicYearEnd is next year
 * from August on; 4 - (gradYear - academicYearEnd), clamped to 1..5. On 2026-11-11, class of
 * 2030 is first-year and class of 2029 is second-year. The UI says it was inferred.
 */
export function yearInSchool(gradYear: number, now: Date): number {
  const academicYearEnd = now.getUTCMonth() + 1 >= 8 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();
  return Math.min(5, Math.max(1, 4 - (gradYear - academicYearEnd)));
}

const PII_KINDS = new Set(["email", "phone", "link", "address", "id", "birthdate", "name"]);

/**
 * Coarse counts for the redaction summary; categories are never named (plan 09). "withheld"
 * (sections left out by the allowlist, like school and award names) and "limit" (length cap)
 * are counted apart from contact details.
 */
export function removalSummary(removed: readonly unknown[]): { contact: number; sensitive: number; withheld: number } {
  let contact = 0;
  let sensitive = 0;
  let withheld = 0;
  for (const r of removed) {
    const kind = String(rec(r).kind ?? rec(r).type ?? "");
    if (kind === "sensitive" || kind === "removed") sensitive += 1;
    else if (PII_KINDS.has(kind)) contact += 1;
    else withheld += 1;
  }
  return { contact, sensitive, withheld };
}

export interface RemovedView {
  placeholder: string;
  original: string;
  reason: string;
}

/**
 * What redaction took out, for the student's eyes only (the originals never leave the
 * device). Sensitive items share one neutral reason, as the resume module writes them.
 */
export function removedForReview(removed: readonly unknown[], max = 40): RemovedView[] {
  return removed
    .map((r) => {
      const x = rec(r);
      return { placeholder: s(x.placeholder) ?? "", original: s(x.original) ?? "", reason: s(x.reason) ?? "" };
    })
    .filter((x) => x.original)
    .slice(0, max);
}

/* ---------- preview highlighting ---------- */

const PLACEHOLDER = /\[(email|phone|link|address|id|name|removed)\]/g;

/** Splits outgoing text so placeholders can be highlighted; the joined text is unchanged. */
export function splitPlaceholders(text: string): Array<{ text: string; placeholder: boolean }> {
  const out: Array<{ text: string; placeholder: boolean }> = [];
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i), placeholder: false });
    out.push({ text: m[0], placeholder: true });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), placeholder: false });
  return out;
}

/** A grad year from a parsed end date such as "2030", "2030-05" or "May 2030". */
export function gradYearOf(date: string | null): number | null {
  const m = date?.match(/\b(19|20)\d{2}\b/);
  return m ? Number(m[0]) : null;
}

/**
 * SignalsView in the field names @shared/onboarding's toMatchSignals reads (coursework,
 * experienceTypes, graduationYear). The server's schema uses the SignalsView names.
 */
export function toEngineSignals(v: SignalsView): { skills: string[]; fields: string[]; coursework: string[]; experienceTypes: string[]; graduationYear: number | null } {
  return { skills: [...v.skills], fields: [...v.fields], coursework: [...v.courseworkKeywords], experienceTypes: [...v.experienceKinds], graduationYear: v.gradYear };
}

const EXPERIENCE_SIGNAL_LABELS: Record<string, string> = {
  research: "Research",
  internship: "Internship",
  insight_program: "Insight program",
  leadership: "Leadership",
  community_service: "Volunteering",
  independent_project: "Projects",
  paid_work: "Work",
  competition: "Competitions",
  teaching_or_tutoring: "Tutoring",
};

/** Display labels for the signal chips: skills as written, fields and experience as words. */
export function signalChips(v: SignalsView, max = 24): string[] {
  const fields = v.fields.map((f) => MAJOR_FAMILY_LABELS[f as MajorFamily] ?? f);
  const kinds = v.experienceKinds.map((k) => EXPERIENCE_SIGNAL_LABELS[k] ?? k.replace(/[_-]/g, " "));
  return dedupe([...v.skills, ...fields, ...kinds]).slice(0, max);
}
