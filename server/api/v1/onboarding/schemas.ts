import { z } from "zod";
import {
  EXPERIENCE_KINDS,
  IdSchema,
  IsoDateSchema,
  LocalTimeSchema,
  TimeZoneSchema,
  type ExperienceKind,
} from "@shared/contracts";
import { MatchSignalsSchema, ServerPreferencesSchema, type MatchSignals, type ServerPreferences } from "@shared/onboarding/types";

/**
 * Request and response schemas for /api/v1/onboarding/*. Every body is `.strict()`, so a key
 * such as `name`, `email` or `citizenship` is rejected rather than dropped.
 *
 * One vocabulary: the quiz answers are @shared/onboarding's ServerPreferencesSchema and the
 * confirmed resume signals are its MatchSignalsSchema, the exact shapes the browser builds with
 * toServerPreferences and toMatchSignals and the engine reads. There is no server-only stored
 * vocabulary to translate to or from. Neither shape holds free text except unlisted skills
 * (`x:{label}`) and coursework keywords, which the routes re-check with guard.ts.
 */

/** Quiz answers (no status or identity question, no device-only answer). */
export const OnboardingPreferencesSchema = ServerPreferencesSchema;
export type OnboardingPreferences = ServerPreferences;

/** Non-PII signals the student confirmed after the on-device parse (toMatchSignals output). */
export const OnboardingSignalsSchema = MatchSignalsSchema;
export type OnboardingSignals = MatchSignals;

/**
 * Resume-derived experience kinds use JSON Resume-style words (part-time, club, volunteer,
 * teaching); the profile stores the taxonomy's ExperienceKind. Both are accepted and mapped.
 */
const RESUME_EXPERIENCE_KINDS = ["part-time", "part_time", "club", "volunteer", "teaching"] as const;

const RESUME_KIND_MAP: Record<(typeof RESUME_EXPERIENCE_KINDS)[number], ExperienceKind> = {
  "part-time": "paid_work",
  part_time: "paid_work",
  club: "leadership",
  volunteer: "community_service",
  teaching: "teaching_or_tutoring",
};

/** Maps signal kinds to the profile's ExperienceKind, deduplicated, in first-seen order. */
export function toExperienceKinds(kinds: readonly string[]): ExperienceKind[] {
  const out: ExperienceKind[] = [];
  for (const k of kinds) {
    const mapped = (EXPERIENCE_KINDS as readonly string[]).includes(k)
      ? (k as ExperienceKind)
      : RESUME_KIND_MAP[k as keyof typeof RESUME_KIND_MAP];
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}

export const STEP_PATTERN = /^[a-z0-9_-]{1,40}$/;

export const QuizSubmitSchema = z
  .object({
    preferences: OnboardingPreferencesSchema,
    signals: OnboardingSignalsSchema.nullable().default(null),
    step: z.string().regex(STEP_PATTERN).nullable().default(null),
    completed: z.boolean().default(false),
  })
  .strict();
export type QuizSubmit = z.infer<typeof QuizSubmitSchema>;

/** About 12k characters is the client's allowlisted-section budget. */
export const MAX_REDACTED_CHARS = 12_000;

export const ResumeExtractRequestSchema = z
  .object({
    redactedText: z.string().min(1).max(MAX_REDACTED_CHARS),
    /** The student pressed "Send this text" on the preview; anything else is refused. */
    consent: z.literal(true),
  })
  .strict();
export type ResumeExtractRequest = z.infer<typeof ResumeExtractRequestSchema>;

export const MatchesRequestSchema = z
  .object({
    preferences: OnboardingPreferencesSchema,
    signals: OnboardingSignalsSchema.nullable().default(null),
    k: z.number().int().min(1).max(20).default(10),
  })
  .strict();
export type MatchesRequest = z.infer<typeof MatchesRequestSchema>;

export const FirstDoorRequestSchema = z
  .object({
    programId: IdSchema,
    programCycleId: IdSchema,
    /** Plan step ids the student finished during onboarding (saved, practice rep, intention). */
    completedStepIds: z.array(z.string().regex(STEP_PATTERN)).max(10).default([]),
    /** If-then plan: "I'll work on {stepId} on {on} at {at}". */
    intention: z
      .object({ stepId: z.string().regex(STEP_PATTERN), on: IsoDateSchema, at: LocalTimeSchema })
      .strict()
      .nullable()
      .default(null),
    nameInMessages: z.boolean().optional(),
    timeZone: TimeZoneSchema.nullable().default(null),
  })
  .strict();
export type FirstDoorRequest = z.infer<typeof FirstDoorRequestSchema>;

/**
 * What the model may return. Unknown keys are stripped (not an error) because model output is
 * untrusted and may add fields; every kept string is re-checked by guard.ts before it leaves.
 */
export const AiResumeProfileSchema = z.object({
  skills: z.array(z.string().max(60)).max(60).default([]),
  fields: z.array(z.string().max(60)).max(10).default([]),
  courseworkKeywords: z.array(z.string().max(60)).max(40).default([]),
  experienceKinds: z.array(z.string().max(30)).max(12).default([]),
});
export type AiResumeProfile = {
  skills: string[];
  fields: string[];
  courseworkKeywords: string[];
  experienceKinds: ExperienceKind[];
};
