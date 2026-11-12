import type { ClassYear, ExperienceKind, MajorFamily } from "../taxonomy";

/**
 * Types for the on-device resume module.
 *
 * Privacy contract: everything typed here stays in the browser unless its comment says
 * otherwise. Two things may leave the device, and only with the student's say-so:
 * `redactForAi(...).text` (after explicit consent) and `ProfileSignals` (closed vocabularies,
 * never free text). `ParsedResume`, `RedactionItem`, `SensitiveHit` and `PiiHit` hold the
 * student's own words and must never be sent, stored on a server, logged or put in analytics.
 */

// -------------------------------------------------------------------------------------------
// Input
// -------------------------------------------------------------------------------------------

/**
 * A line, or a fragment of a line, as a reader produced it. Positions are PDF user-space
 * points with the origin at the bottom-left of the page (larger `y` is higher on the page),
 * which is what pdf.js reports. DOCX and pasted text leave the positions out.
 */
export interface ResumeLine {
  text: string;
  x?: number;
  y?: number;
  fontSize?: number;
  bold?: boolean;
  page?: number;
  /**
   * Extension to the agreed shape: the fragment's width in the same units as `x`, when the
   * reader knows it (pdf.js does). With it, glyph fragments merge exactly and two-column
   * layouts split reliably; without it widths are estimated from the font size.
   */
  width?: number;
}

/** "Now" for year bounds, 'YY expansion and class-year inference; tests pass a fixed date. */
export type NowInput = Date | number | string;

/**
 * Device-only hints that help find, and later redact, the student's name. None of these is
 * ever sent anywhere; they only seed the on-device name redactor.
 */
export interface ResumeHints {
  /** PDF metadata Author. Often the student's name, sometimes "Microsoft Office User". */
  author?: string | null;
  /** The file name, e.g. Jane_Doe_Resume.pdf. */
  fileName?: string | null;
  /** The display name on the student's account, if any. */
  accountName?: string | null;
  /**
   * Link targets from the file itself (PDF link annotations, DOCX hyperlinks): a "LinkedIn"
   * label often hides linkedin.com/in/jane-doe. Kept with the device-only links and used as
   * name seeds.
   */
  links?: readonly string[] | null;
}

export interface ParseResumeInput {
  text: string;
  lines?: ResumeLine[];
  now?: NowInput;
  hints?: ResumeHints;
}

// -------------------------------------------------------------------------------------------
// ParsedResume (JSON Resume 1.7.1 shape, renamed and extended; device only)
// -------------------------------------------------------------------------------------------

export const SECTION_KEYS = [
  "profile",
  "summary",
  "education",
  "experience",
  "research",
  "projects",
  "skills",
  "coursework",
  "activities",
  "volunteer",
  "awards",
  "certifications",
  "publications",
  "interests",
  "languages",
  "references",
  "other",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

/** A block of the resume for the review UI. `lineEnd` is exclusive, like `Array.slice`. */
export interface ResumeSection {
  key: SectionKey;
  heading: string | null;
  lineStart: number;
  lineEnd: number;
  lines: string[];
}

/**
 * What kind of entry an experience line is. `club` covers membership without a leadership
 * title; `work` is any other job. Activities and volunteering are merged into `experience`
 * (JSON Resume keeps them apart), with this field telling them apart.
 */
export const RESUME_ENTRY_KINDS = [
  "internship",
  "research",
  "work",
  "part_time",
  "leadership",
  "club",
  "volunteer",
  "teaching",
  "insight",
  "competition",
] as const;
export type ResumeEntryKind = (typeof RESUME_ENTRY_KINDS)[number];

/** Contact details. DEVICE ONLY: never serialized to a server, a log or a prompt. */
export interface ResumeContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  /** "City, ST" as written in the header. */
  location: string | null;
  /**
   * Other strings that identify the student (PDF author, account name, the name in the email
   * address or a profile handle). Used only to redact them from anything that leaves.
   */
  aliases: string[];
}

export const RESUME_LINK_KINDS = ["linkedin", "github", "portfolio", "other"] as const;
export type ResumeLinkKind = (typeof RESUME_LINK_KINDS)[number];

/** A URL found in the resume. DEVICE ONLY. */
export interface ResumeLink {
  url: string;
  kind: ResumeLinkKind;
}

export const DEGREE_LEVELS = ["high_school", "certificate", "associate", "bachelor", "master", "doctorate"] as const;
export type DegreeLevel = (typeof DEGREE_LEVELS)[number];

/** A GPA as written. `scale` is null when the resume does not state one. */
export interface ResumeGpa {
  value: number;
  scale: number | null;
}

/** Dates are JSON Resume iso8601 strings: YYYY, YYYY-MM or YYYY-MM-DD. */
export interface EducationEntry {
  institution: string | null;
  /** The major, as written ("Computer Science"). */
  area: string | null;
  minor: string | null;
  /** The degree as written ("Bachelor of Science", "A.S."). */
  studyType: string | null;
  degreeLevel: DegreeLevel | null;
  startDate: string | null;
  endDate: string | null;
  /** True for "Expected May 2029" and for graduation dates still in the future. */
  endDateExpected: boolean;
  /** The GPA text as written ("3.85/4.00"); never normalized into a ranking number. */
  score: string | null;
  gpa: ResumeGpa | null;
  courses: string[];
  /** Honors lines inside the entry ("Dean's List"). */
  highlights: string[];
}

export interface ExperienceEntry {
  kind: ResumeEntryKind;
  /** Job or role title (JSON Resume `work.position`). */
  position: string | null;
  /** Employer, lab, club or organization (JSON Resume `work.name`). */
  organization: string | null;
  location: string | null;
  startDate: string | null;
  endDate: string | null;
  /** True when the entry runs to "Present". */
  current: boolean;
  highlights: string[];
  /** The section the entry came from. */
  section: SectionKey;
}

export interface ProjectEntry {
  name: string | null;
  description: string | null;
  highlights: string[];
  /** Tools and technologies named for the project. */
  keywords: string[];
  startDate: string | null;
  endDate: string | null;
  /** DEVICE ONLY. */
  url: string | null;
}

export const RESUME_WARNING_CODES = [
  "empty-input",
  "input-truncated",
  "no-headings-found",
  "two-column-guess",
  "name-not-found",
  "no-education-found",
  "no-experience-found",
  "no-skills-found",
  "references-dropped",
] as const;
export type ResumeWarningCode = (typeof RESUME_WARNING_CODES)[number];

/** A parse note for the review screen. Never contains resume text. */
export interface ResumeWarning {
  code: ResumeWarningCode;
  text: string;
}

export interface ParsedResume {
  /** DEVICE ONLY. */
  contact: ResumeContact;
  education: EducationEntry[];
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
  skills: string[];
  coursework: string[];
  awards: string[];
  /** DEVICE ONLY. */
  links: ResumeLink[];
  sections: ResumeSection[];
  warnings: ResumeWarning[];
}

// -------------------------------------------------------------------------------------------
// Redaction
// -------------------------------------------------------------------------------------------

export const PII_KINDS = ["email", "phone", "link", "address", "id", "birthdate", "name"] as const;
export type PiiKind = (typeof PII_KINDS)[number];

/** A contact detail, identifier or name found in text. DEVICE ONLY (it carries the match). */
export interface PiiHit {
  kind: PiiKind;
  start: number;
  end: number;
  match: string;
}

export const REDACTION_KINDS = [...PII_KINDS, "sensitive", "withheld", "limit"] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

/**
 * One thing left out of the AI text, for the preview. DEVICE ONLY: `original` is the
 * student's own text. Sensitive items never say which category triggered them; the reason
 * is the same neutral sentence for all of them.
 */
export interface RedactionItem {
  kind: RedactionKind;
  reason: string;
  original: string;
  /** The token left in the text ("[email]", "[removed]"), or "" when nothing was left. */
  placeholder: string;
}

export interface RedactionResult {
  /** Exactly what would be sent, if the student consents. */
  text: string;
  removed: RedactionItem[];
}

export interface RedactOptions {
  /** Extra name seeds (the account name, for example) to redact wherever they appear. */
  names?: string[];
  /** Upper bound on the outgoing text; the server accepts about 12k characters. */
  maxChars?: number;
}

// -------------------------------------------------------------------------------------------
// Sensitive categories
// -------------------------------------------------------------------------------------------

/**
 * The SensitiveAnswers categories (plan 09) the detector looks for. The first eleven are the
 * product's list; the last three come from shared/taxonomy's identity categories.
 */
export const SENSITIVE_CATEGORIES = [
  "citizenship_immigration",
  "income",
  "disability",
  "race_ethnicity",
  "gender",
  "sexual_orientation",
  "religion",
  "first_generation",
  "veteran",
  "foster_care",
  "health",
  "tribal_affiliation",
  "parenting",
  "crime_victim",
] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

/**
 * A statement that may reveal a sensitive category. DEVICE ONLY: the category label must
 * never reach a server, a log or a prompt. `contextual` hits are weaker (a research topic, an
 * ambiguous acronym) but are removed all the same.
 */
export interface SensitiveHit {
  category: SensitiveCategory;
  strength: "definite" | "contextual";
  start: number;
  end: number;
  match: string;
  ruleId: string;
}

// -------------------------------------------------------------------------------------------
// Skills and signals
// -------------------------------------------------------------------------------------------

export const SKILL_CATEGORIES = [
  "programming",
  "web",
  "mobile",
  "data",
  "ml_ai",
  "cloud_devops",
  "database",
  "tools",
  "design",
  "office",
  "business",
  "finance",
  "lab",
  "engineering",
  "health",
  "communication",
  "language",
  "research",
  "teaching",
  "media",
  "other",
] as const;
export type SkillCategory = (typeof SKILL_CATEGORIES)[number];

export interface NormalizedSkill {
  /** Stable slug ("javascript"); for unknown skills, a slug of the cleaned text. */
  id: string;
  /** Canonical display name ("JavaScript"), or the cleaned text when unknown. */
  name: string;
  category: SkillCategory;
  /** True when the skill is in the curated list. Only known skills become ProfileSignals. */
  known: boolean;
  /** What the resume said. DEVICE ONLY. */
  raw: string;
}

/**
 * Non-PII facts for matching. Every string comes from a closed vocabulary in this module
 * (skills list, majors list, coursework keywords) or shared/taxonomy, so nothing the student
 * typed passes through. Field names follow what shared/onboarding and the start page read.
 */
export interface ProfileSignals {
  /** Canonical names from the curated skills list. */
  skills: string[];
  skillCategories: SkillCategory[];
  /** Major families (shared/taxonomy). */
  fields: MajorFamily[];
  /** Canonical major names from the curated majors list. */
  majors: string[];
  /** Coursework keywords from the curated list ("Data Structures", "Organic Chemistry"). */
  coursework: string[];
  experienceTypes: ExperienceKind[];
  degreeLevel: DegreeLevel | null;
  graduationYear: number | null;
  /** Inferred from the graduation year; the UI must say so and let the student correct it. */
  classYear: ClassYear | null;
  classYearInferred: boolean;
  /** Months covered by dated experience entries, overlaps counted once. */
  experienceMonths: number;
}
