import { z } from "zod";
import { PRODUCT } from "../config/product";
import { IdSchema, IsoDateSchema, IsoDateTimeSchema, SlugSchema, UrlSchema } from "./common";

/**
 * AI request and response shapes for the readiness assistant (Google Gemini via server/ai).
 *
 * Division of labour: deterministic code decides eligibility, requirements, bands and dates; the
 * model only explains them, gives writing feedback and answers questions from supplied sources.
 * Every claim cites a source id the server supplied, the server checks each quote against that
 * source, and every endpoint returns a useful deterministic fallback when no key is configured.
 * No SensitiveAnswers field exists in any of these schemas.
 */

const { ai } = PRODUCT;

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

export const AI_SOURCE_KINDS = ["program_page", "novus_record", "readiness_report", "methodology", "student_text"] as const;
export const AiSourceKindSchema = z.enum(AI_SOURCE_KINDS);

export const AiSourceIdSchema = z.string().regex(/^s\d{1,3}$/, "source id like s1");

/** A source the server places in the prompt; the model may cite only these ids. */
export const AiSourceSchema = z
  .object({
    id: AiSourceIdSchema,
    kind: AiSourceKindSchema,
    title: z.string().max(200),
    url: UrlSchema.nullable(),
    programSlug: SlugSchema.nullable(),
    text: z.string().max(8000),
    retrievedOn: IsoDateSchema.nullable(),
  })
  .strict();
export type AiSource = z.infer<typeof AiSourceSchema>;

/** A citation as returned to the client: which source, and a short verbatim excerpt from it. */
export const AiCitationSchema = z
  .object({
    sourceId: AiSourceIdSchema,
    kind: AiSourceKindSchema,
    title: z.string().max(200),
    url: UrlSchema.nullable(),
    /** Verbatim from the source, at most 25 words; null when only the record is cited. */
    quote: z.string().max(300).nullable(),
  })
  .strict();
export type AiCitation = z.infer<typeof AiCitationSchema>;

export const AI_STATUSES = ["ok", "degraded", "unavailable"] as const;
export const AI_DEGRADED_REASONS = [
  "no_api_key",
  "disabled",
  "provider_error",
  "timeout",
  "rate_limited",
  "budget_exceeded",
  "validation_failed",
  "citation_check_failed",
  "safety_blocked",
] as const;

export const AiMetaSchema = z
  .object({
    provider: z.enum(["gemini", "none"]),
    model: z.string().max(80).nullable(),
    promptVersion: z.string().max(40),
    status: z.enum(AI_STATUSES),
    degradedReason: z.enum(AI_DEGRADED_REASONS).nullable(),
    generatedAt: IsoDateTimeSchema,
    /** True when the text came from deterministic templates rather than the model. */
    fallback: z.boolean(),
  })
  .strict()
  .refine((m) => (m.status === "ok") === (m.degradedReason === null), "degradedReason is set exactly when status is not ok");
export type AiMeta = z.infer<typeof AiMetaSchema>;

const sourceIds = z.array(AiSourceIdSchema).max(10);

function checkCitedIds(
  ids: readonly string[],
  citations: readonly { sourceId: string }[],
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  const known = new Set(citations.map((c) => c.sourceId));
  for (const id of ids) {
    if (!known.has(id)) ctx.addIssue({ code: "custom", path, message: `cites ${id}, which is not in citations` });
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Readiness explanation
// ---------------------------------------------------------------------------------------------

export const READINESS_PART_KEYS = ["eligibility", "requirements", "competitiveness", "next_actions"] as const;
export const ReadinessPartKeySchema = z.enum(READINESS_PART_KEYS);

export const ReadinessExplainRequestSchema = z
  .object({
    focus: z.enum(["overview", ...READINESS_PART_KEYS]).default("overview"),
    /** Optional follow-up question; server redacts status and identity terms before any prompt. */
    question: z.string().max(500).nullable().default(null),
  })
  .strict();
export type ReadinessExplainRequest = z.infer<typeof ReadinessExplainRequestSchema>;

/** What the model must return (flat; every field required, so it fits structured-output limits). */
export const ReadinessExplainModelOutputSchema = z
  .object({
    summary: z.string(),
    points: z.array(z.object({ part: ReadinessPartKeySchema, text: z.string(), sourceIds: z.array(z.string()) }).strict()),
    suggestions: z.array(z.object({ text: z.string(), nextActionId: z.string(), sourceIds: z.array(z.string()) }).strict()),
    caveats: z.array(z.string()),
  })
  .strict();
export type ReadinessExplainModelOutput = z.infer<typeof ReadinessExplainModelOutputSchema>;

export const ReadinessExplainResponseSchema = z
  .object({
    programCycleId: IdSchema,
    meta: AiMetaSchema,
    summary: z.string().max(1200),
    points: z
      .array(z.object({ part: ReadinessPartKeySchema, text: z.string().max(800), sourceIds }).strict())
      .max(12),
    suggestions: z
      .array(z.object({ text: z.string().max(400), nextActionId: z.string().max(80).nullable(), sourceIds }).strict())
      .max(6),
    caveats: z.array(z.string().max(300)).max(5),
    citations: z.array(AiCitationSchema).max(20),
  })
  .strict()
  .superRefine((r, ctx) => {
    r.points.forEach((p, i) => checkCitedIds(p.sourceIds, r.citations, ctx, ["points", i, "sourceIds"]));
    r.suggestions.forEach((s, i) => checkCitedIds(s.sourceIds, r.citations, ctx, ["suggestions", i, "sourceIds"]));
  });
export type ReadinessExplainResponse = z.infer<typeof ReadinessExplainResponseSchema>;

// ---------------------------------------------------------------------------------------------
// 2. Statement feedback (essays and personal statements). Feedback, never a grade.
// ---------------------------------------------------------------------------------------------

export const FEEDBACK_ASPECTS = [
  "fit_to_prompt",
  "specificity",
  "structure",
  "clarity",
  "evidence_of_impact",
  "voice",
  "mechanics",
  "length",
] as const;
export const FeedbackAspectSchema = z.enum(FEEDBACK_ASPECTS);
export type FeedbackAspect = z.infer<typeof FeedbackAspectSchema>;

export const StatementFeedbackRequestSchema = z
  .object({
    programCycleId: IdSchema.nullable().default(null),
    /** The essay prompt as the program states it, if the student has it. */
    essayPrompt: z.string().max(ai.maxPromptChars).nullable().default(null),
    statement: z.string().min(ai.minStatementChars).max(ai.maxStatementChars),
    wordLimit: z.number().int().min(1).max(5000).nullable().default(null),
    focus: z.array(FeedbackAspectSchema).max(FEEDBACK_ASPECTS.length).default([]),
  })
  .strict();
export type StatementFeedbackRequest = z.infer<typeof StatementFeedbackRequestSchema>;

export const StatementFeedbackModelOutputSchema = z
  .object({
    overall: z.string(),
    strengths: z.array(z.object({ aspect: FeedbackAspectSchema, comment: z.string(), excerpt: z.string() }).strict()),
    improvements: z.array(
      z.object({ aspect: FeedbackAspectSchema, comment: z.string(), excerpt: z.string(), suggestion: z.string() }).strict(),
    ),
    promptCoverage: z.array(
      z.object({ promptPart: z.string(), addressed: z.enum(["yes", "partly", "no"]), note: z.string() }).strict(),
    ),
    sourceIds: z.array(z.string()),
  })
  .strict();
export type StatementFeedbackModelOutput = z.infer<typeof StatementFeedbackModelOutputSchema>;

const FeedbackItemSchema = z
  .object({
    aspect: FeedbackAspectSchema,
    comment: z.string().max(600),
    /** A short span copied from the student's own statement; the server checks it is verbatim. */
    excerpt: z.string().max(300).nullable(),
  })
  .strict();

export const StatementFeedbackResponseSchema = z
  .object({
    meta: AiMetaSchema,
    /** Facts about the text, computed deterministically. */
    wordCount: z.number().int().nonnegative(),
    wordLimit: z.number().int().positive().nullable(),
    overLimit: z.boolean().nullable(),
    overall: z.string().max(1200),
    strengths: z.array(FeedbackItemSchema).max(6),
    improvements: z.array(FeedbackItemSchema.extend({ suggestion: z.string().max(600) }).strict()).max(8),
    promptCoverage: z
      .array(z.object({ promptPart: z.string().max(300), addressed: z.enum(["yes", "partly", "no"]), note: z.string().max(400) }).strict())
      .max(8),
    citations: z.array(AiCitationSchema).max(10),
    /** True when status or identity terms were masked before the text reached the model. */
    redactionApplied: z.boolean(),
  })
  .strict();
export type StatementFeedbackResponse = z.infer<typeof StatementFeedbackResponseSchema>;

// ---------------------------------------------------------------------------------------------
// 3. Ask: questions about programs, answered only from Novus records and official sources.
// ---------------------------------------------------------------------------------------------

export const AskRequestSchema = z
  .object({
    question: z.string().min(3).max(ai.maxQuestionChars),
    programSlug: SlugSchema.nullable().default(null),
  })
  .strict();
export type AskRequest = z.infer<typeof AskRequestSchema>;

export const ASK_ANSWER_TYPES = ["answered", "partial", "not_in_sources", "declined_sensitive"] as const;

export const AskModelOutputSchema = z
  .object({
    answer: z.string(),
    answerType: z.enum(["answered", "partial", "not_in_sources"]),
    sourceIds: z.array(z.string()),
    followUps: z.array(z.string()),
  })
  .strict();
export type AskModelOutput = z.infer<typeof AskModelOutputSchema>;

export const AskResponseSchema = z
  .object({
    meta: AiMetaSchema,
    answer: z.string().max(2000),
    /**
     * declined_sensitive: the question asked Novus to judge a status or identity criterion; the
     * answer points to the on-device check and the official rule instead.
     */
    answerType: z.enum(ASK_ANSWER_TYPES),
    citations: z.array(AiCitationSchema).max(10),
    programRefs: z.array(z.object({ slug: SlugSchema, name: z.string().max(200) }).strict()).max(10),
    followUps: z.array(z.string().max(200)).max(4),
  })
  .strict()
  .refine(
    (r) => !(r.answerType === "answered" || r.answerType === "partial") || r.citations.length > 0,
    "answers cite at least one source",
  );
export type AskResponse = z.infer<typeof AskResponseSchema>;
