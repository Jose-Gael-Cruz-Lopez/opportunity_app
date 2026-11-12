import { z } from "zod";
import type { ProgramCard } from "../contracts/registry";
import {
  ClassYearSchema,
  ExperienceKindSchema,
  MajorFamilySchema,
  OpportunityCategorySchema,
  OpportunityTypeSlugSchema,
} from "../taxonomy";
import { isIsoDate } from "../time/iso";
import { isValidTimeZone } from "../time/zones";
import type { RequirementLike } from "./schedule";
import { SKILL_REF_PATTERN, type SkillLike } from "./skills";
import {
  GOAL_VALUES,
  INTEREST_TOPIC_IDS,
  LENGTH_VALUES,
  LOCATION_VALUES,
  PAY_VALUES,
  STYLE_VALUES,
  TIMING_VALUES,
  VALUE_VALUES,
} from "./vocab";

/**
 * Wire types for onboarding. Convention as in shared/contracts: `FooSchema` is the zod schema
 * and `Foo` its inferred type. Every object is `.strict()`, so a request that carries any
 * status or identity key, or any field this module does not define, is rejected.
 *
 * There is no numeric fit value anywhere: matches carry a tier, plain reasons and counts.
 */

const IsoDate = z.string().refine(isIsoDate, "date as YYYY-MM-DD");
const TimeZone = z.string().max(64).refine(isValidTimeZone, "IANA time zone");

export const SkillRefSchema = z.string().max(42).regex(SKILL_REF_PATTERN, "skill id or x:{label}");

// ---------------------------------------------------------------------------------------------
// Preferences (what the quiz learned)
// ---------------------------------------------------------------------------------------------

export const LeaningsSchema = z
  .object({
    style: z.enum(STYLE_VALUES).nullable(),
    length: z.enum(LENGTH_VALUES).nullable(),
    value: z.enum(VALUE_VALUES).nullable(),
  })
  .strict();
export type Leanings = z.infer<typeof LeaningsSchema>;

/**
 * Preferences that may reach a server route (POST /onboarding/quiz, /onboarding/matches).
 * No free text: the one short-text answer (`target`) is device-only and lives only on
 * StudentPreferences; `toServerPreferences` removes it.
 */
export const ServerPreferencesSchema = z
  .object({
    v: z.literal(1),
    /** Plain-language categories the student asked for; empty means "not sure, show me anything". */
    categories: z.array(OpportunityCategorySchema).max(8),
    /** The categories expanded to type slugs (empty when categories is empty). */
    opportunityTypes: z.array(OpportunityTypeSlugSchema).max(33),
    interests: z.array(z.enum(INTEREST_TOPIC_IDS)).max(5),
    skills: z.array(SkillRefSchema).max(30),
    /** True when the student reviewed the skill chips, so unchecked resume skills stay out. */
    skillsConfirmed: z.boolean(),
    classYear: ClassYearSchema.nullable(),
    majorFamily: MajorFamilySchema.nullable(),
    leanings: LeaningsSchema,
    /** Empty means any time. */
    timing: z.array(z.enum(TIMING_VALUES)).max(3),
    location: z.enum(LOCATION_VALUES).nullable(),
    pay: z.enum(PAY_VALUES),
    /** Hours a week for applications: a planning input, not a rating. */
    weeklyHours: z.number().int().min(1).max(20),
    experience: z.array(ExperienceKindSchema).max(9),
    goal: z.enum(GOAL_VALUES).nullable(),
    hasResume: z.boolean(),
    timeZone: TimeZone.nullable(),
  })
  .strict();
export type ServerPreferences = z.infer<typeof ServerPreferencesSchema>;

export const StudentPreferencesSchema = ServerPreferencesSchema.extend({
  /** "Is there a program you already have in mind?" Device-only free text, cleaned, at most 80 chars. */
  target: z.string().max(80).nullable(),
}).strict();
export type StudentPreferences = z.infer<typeof StudentPreferencesSchema>;

// ---------------------------------------------------------------------------------------------
// Resume signals (non-PII facts from shared/resume's toProfileSignals)
// ---------------------------------------------------------------------------------------------

/**
 * What matching reads from a resume, in a closed shape safe to send to a server: skill refs,
 * major families, short coursework keywords, experience kinds and a graduation year. No names,
 * contact details, organizations or sentences.
 */
export const MatchSignalsSchema = z
  .object({
    skills: z.array(SkillRefSchema).max(40),
    fields: z.array(MajorFamilySchema).max(4),
    coursework: z.array(z.string().max(40).regex(/^[A-Za-z0-9][A-Za-z0-9 &+#./-]*$/)).max(20),
    experience: z.array(ExperienceKindSchema).max(9),
    graduationYear: z.number().int().min(2000).max(2100).nullable(),
  })
  .strict();
export type MatchSignals = z.infer<typeof MatchSignalsSchema>;

/**
 * Anything shaped like shared/resume's ProfileSignals. Every property is optional and read
 * defensively, so the resume module can grow fields without breaking matching.
 */
export interface SignalsInput {
  readonly skills?: readonly SkillLike[];
  readonly fields?: readonly unknown[];
  readonly coursework?: readonly unknown[];
  /** The server's stored name for coursework. */
  readonly courseworkKeywords?: readonly unknown[];
  readonly experienceTypes?: readonly unknown[];
  readonly experience?: readonly unknown[];
  /** The server's stored name for experience kinds. */
  readonly experienceKinds?: readonly unknown[];
  readonly years?: unknown;
  readonly graduationYear?: unknown;
  /** The server's stored name for the graduation year. */
  readonly gradYear?: unknown;
  /** shared/resume infers this from the graduation year; the student still confirms it. */
  readonly classYear?: unknown;
}

// ---------------------------------------------------------------------------------------------
// Programs as onboarding reads them
// ---------------------------------------------------------------------------------------------

export const PROGRAM_FORMATS = ["remote", "in_person", "hybrid"] as const;
export type ProgramFormat = (typeof PROGRAM_FORMATS)[number];

/**
 * Optional facts the release card does not carry yet. Absent means unknown, and unknown never
 * excludes a program; it only means a preference cannot count as met.
 */
export interface ProgramExtras {
  readonly format?: readonly ProgramFormat[];
  /** Compact Requirements (kind, count, overrides). Absent: "Requirements not yet checked". */
  readonly requirements?: readonly RequirementLike[];
  /** Skills the program lists, as onboarding skill ids or plain labels. */
  readonly skills?: readonly string[];
}

/** A client-core card, optionally with onboarding extras. */
export type OnboardingProgram = ProgramCard & { readonly extras?: ProgramExtras };

// ---------------------------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------------------------

export const TIERS = ["strong", "good", "stretch"] as const;
export const TierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof TierSchema>;

export const TIER_LABELS: Record<Tier, string> = {
  strong: "Strong fit",
  good: "Good fit",
  stretch: "Stretch: worth a try",
};

export const DEADLINE_BASES = ["official", "estimated", "campus_estimate", "rolling", "not_announced"] as const;

export const FeasibilitySchema = z
  .object({
    /** Latest day to start preparing (the deadline itself when preparation time is unknown). */
    startBy: IsoDate,
    /** Whole days from today to the deadline; for rolling or unannounced deadlines, to the suggested apply-by date. */
    daysLeft: z.number().int(),
    enoughTime: z.boolean(),
    /** The effective deadline (YYYY-MM-DD), or null when rolling or not announced. */
    deadline: IsoDate.nullable(),
    basis: z.enum(DEADLINE_BASES),
    /** Days of preparation from the guidance table; null when requirements are not checked. */
    prepDays: z.number().int().nonnegative().nullable(),
    /** Hours of the student's own work, when requirements are known. */
    prepHours: z.number().nonnegative().nullable(),
    tight: z.boolean(),
    /** One line for the card: "Start by Dec 2 · about 3 h of prep". */
    label: z.string().max(160),
  })
  .strict();
export type Feasibility = z.infer<typeof FeasibilitySchema>;

export const EligibilityCheckSchema = z
  .object({
    /** The official rule as an "Eligible if ..." line; program facts only, never an answer. */
    text: z.string().max(400),
    /** True when only the student can check it privately on the device (status or identity rules). */
    sensitive: z.boolean(),
    resolver: z.enum(["student", "novus"]),
  })
  .strict();
export type EligibilityCheck = z.infer<typeof EligibilityCheckSchema>;

export const MatchItemSchema = z
  .object({
    programId: z.string().max(64),
    programCycleId: z.string().max(64),
    slug: z.string().max(120),
    name: z.string().max(200),
    organizationName: z.string().max(200),
    categories: z.array(OpportunityCategorySchema),
    tier: TierSchema,
    /** Two or three plain reasons tied to evidence. */
    reasons: z.array(z.string().max(160)).min(1).max(3),
    /** Why-shown codes (plan 06 catalogue plus onboarding codes), for copy and analytics. */
    reasonCodes: z.array(z.string().max(60)).max(16),
    /** The full "Why this?" list. */
    evidence: z.array(z.string().max(200)).max(12),
    feasibility: FeasibilitySchema,
    /** "You meet 3 of 5 listed requirements": counts only. */
    requirementsMet: z.object({ met: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict(),
    /** "What's missing": requirement and skill labels the student does not show yet. */
    missing: z.array(z.string().max(120)).max(12),
    skills: z.object({ matched: z.array(z.string().max(60)).max(20), missing: z.array(z.string().max(60)).max(20) }).strict(),
    eligibility: z
      .object({
        status: z.enum(["eligible", "conditional", "unknown"]),
        checks: z.array(EligibilityCheckSchema).max(20),
      })
      .strict(),
    prep: z
      .object({
        checked: z.boolean(),
        letters: z.number().int().nonnegative().nullable(),
        essays: z.number().int().nonnegative().nullable(),
        hours: z.number().nonnegative().nullable(),
      })
      .strict(),
    audience: z.object({ identity: z.boolean(), nominationRequired: z.boolean() }).strict(),
    isSample: z.boolean(),
  })
  .strict();
export type MatchItem = z.infer<typeof MatchItemSchema>;

export const MatchSetSchema = z
  .object({
    v: z.literal(1),
    algoVersion: z.string().max(40),
    asOf: IsoDate,
    timeZone: z.string().max(64),
    /** Ordered strong, then good, then stretch; within a tier by fused rank with diversity. */
    items: z.array(MatchItemSchema).max(30),
    counts: z
      .object({
        strong: z.number().int().nonnegative(),
        good: z.number().int().nonnegative(),
        stretch: z.number().int().nonnegative(),
        considered: z.number().int().nonnegative(),
        shown: z.number().int().nonnegative(),
      })
      .strict(),
    /**
     * True when the list was widened beyond the student's answers: other types (too few of the
     * asked-for ones matched) or picks to explore (too little to match on), all shown as stretches.
     */
    relaxed: z.boolean(),
    containsSample: z.boolean(),
  })
  .strict();
export type MatchSet = z.infer<typeof MatchSetSchema>;

// ---------------------------------------------------------------------------------------------
// First door
// ---------------------------------------------------------------------------------------------

export const FIRST_DOOR_ROLES = ["named", "quickest", "best_match", "stretch"] as const;

export const FirstDoorOptionSchema = z
  .object({
    programId: z.string().max(64),
    programCycleId: z.string().max(64),
    slug: z.string().max(120),
    name: z.string().max(200),
    tier: TierSchema,
    role: z.enum(FIRST_DOOR_ROLES),
    /** One line: "Quickest to start", "Best match for your interests", ... */
    rationale: z.string().max(160),
    firstStep: z.object({ title: z.string().max(120), minutes: z.number().int().min(1).max(30) }).strict(),
    feasibility: FeasibilitySchema,
  })
  .strict();
export type FirstDoorOption = z.infer<typeof FirstDoorOptionSchema>;

export const FirstDoorChoiceSchema = z
  .object({
    /** Up to three options. The student picks one; nothing is pre-selected. */
    options: z.array(FirstDoorOptionSchema).max(3),
    prompt: z.string().max(200),
    /** True when fewer than three programs had enough time, so the list is short or includes stretches. */
    fallback: z.boolean(),
  })
  .strict();
export type FirstDoorChoice = z.infer<typeof FirstDoorChoiceSchema>;

export const PLAN_STEP_KINDS = [
  "save",
  "eligibility",
  "nomination",
  "recommenders",
  "draft",
  "reminder",
  "open_application",
  "letters",
  "resume",
  "essay",
  "transcript",
  "test",
  "portfolio",
  "interview",
  "fee",
  "other",
  "submit",
] as const;
export type PlanStepKind = (typeof PLAN_STEP_KINDS)[number];

export const PlanStepSchema = z
  .object({
    id: z.string().max(40),
    title: z.string().max(120),
    kind: z.enum(PLAN_STEP_KINDS),
    minutes: z.number().int().min(1).max(600),
    /** Latest day to do this step (never before today). */
    due: IsoDate.optional(),
    /** True for micro-steps the student can finish before onboarding ends. */
    doneDuringOnboarding: z.boolean().optional(),
    detail: z.string().max(400).optional(),
    url: z.string().max(2048).optional(),
    /** True when the guidance date had already passed, so the step is due today. */
    late: z.boolean().optional(),
  })
  .strict();
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const FirstApplicationPlanSchema = z
  .object({
    v: z.literal(1),
    asOf: IsoDate,
    programId: z.string().max(64),
    programCycleId: z.string().max(64).nullable(),
    slug: z.string().max(120),
    name: z.string().max(200),
    cycleKey: z.string().max(20).nullable(),
    officialUrl: z.string().max(2048),
    applicationUrl: z.string().max(2048).nullable(),
    deadline: IsoDate.nullable(),
    deadlineBasis: z.enum(DEADLINE_BASES),
    startBy: IsoDate,
    daysLeft: z.number().int(),
    steps: z.array(PlanStepSchema).min(1).max(20),
    /** How many steps can be finished during onboarding (endowed progress: "2 of 7 done"). */
    doableNow: z.number().int().nonnegative(),
    draft: z
      .object({
        /** Two sentences with blanks, built from the student's own non-PII signals. */
        template: z.string().max(600),
        ai: z.enum(["on", "off"]),
        note: z.string().max(200),
      })
      .strict(),
    privacy: z.object({ deviceOnly: z.boolean(), note: z.string().max(300) }).strict(),
    missingKeywords: z.array(z.string().max(60)).max(12),
    isSample: z.boolean(),
  })
  .strict();
export type FirstApplicationPlan = z.infer<typeof FirstApplicationPlanSchema>;
