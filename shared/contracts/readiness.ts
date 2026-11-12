import { z } from "zod";
import { CountStageSchema, RequirementKindSchema } from "../taxonomy";
import { IdSchema, IsoDateSchema, IsoDateTimeSchema, UrlSchema } from "./common";
import { EligibilityResultSchema } from "./eligibility";
import { EvidenceQuoteSchema } from "./evidence";
import { StageOddsSchema } from "./registry";

/**
 * ReadinessReport: exactly four visible parts.
 *   1. eligibility   - the evaluator's result, with a reason per rule
 *   2. requirements  - a checklist that names each gap and its start-by date
 *   3. competitiveness - a band with its basis, or a status such as "insufficient_data"
 *   4. nextActions   - dated actions linked to the Roadmap
 * There is never one composite score, percentage or "match" number about a student.
 * Readiness is computed on read and never stored.
 */

export const REQUIREMENT_STATES = ["met", "in_progress", "gap", "unknown", "not_applicable"] as const;
export const RequirementStateSchema = z.enum(REQUIREMENT_STATES);
export type RequirementState = z.infer<typeof RequirementStateSchema>;

export const START_SEVERITIES = ["late", "soon", "planned"] as const;
export const StartSeveritySchema = z.enum(START_SEVERITIES);
export type StartSeverity = z.infer<typeof StartSeveritySchema>;

export const ChecklistItemSchema = z
  .object({
    /** Requirement id, or `kind:{kind}` for reusable items such as a résumé. */
    key: z.string().max(80),
    requirementId: IdSchema.nullable(),
    kind: RequirementKindSchema,
    label: z.string().max(200),
    quantity: z.number().int().min(1),
    state: RequirementStateSchema,
    /** Names the gap in plain words when state is gap or unknown ("Ask two recommenders"). */
    gap: z.string().max(300).nullable(),
    /** Latest date to start so the item is ready by the effective deadline. */
    startBy: IsoDateSchema.nullable(),
    severity: StartSeveritySchema.nullable(),
    effortHours: z.number().min(0).nullable(),
    leadDays: z.number().int().min(0).nullable(),
    evidence: EvidenceQuoteSchema.nullable(),
  })
  .strict();
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const RequirementsChecklistSchema = z
  .object({
    /** False: "Requirements not yet checked by Novus: see the official page". */
    checked: z.boolean(),
    items: z.array(ChecklistItemSchema),
    /** The deadline start-by dates count back from, and where it came from. */
    effectiveDeadline: z
      .object({
        date: IsoDateSchema,
        basis: z.enum(["official", "attested", "estimated", "student_entered", "predicted"]),
        scope: z.enum(["national", "campus"]),
        label: z.string().max(200),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type RequirementsChecklist = z.infer<typeof RequirementsChecklistSchema>;

/** Bands are relative to the stage base rate and never shown as percentages. */
export const COMPETITIVENESS_BANDS = ["below_typical", "typical", "above_typical", "same_for_everyone"] as const;
export const CompetitivenessBandSchema = z.enum(COMPETITIVENESS_BANDS);
export type CompetitivenessBand = z.infer<typeof CompetitivenessBandSchema>;

export const COMPETITIVENESS_STATUSES = ["available", "official_odds_only", "insufficient_data", "not_applicable"] as const;
export const CompetitivenessStatusSchema = z.enum(COMPETITIVENESS_STATUSES);
export type CompetitivenessStatus = z.infer<typeof CompetitivenessStatusSchema>;

export const BASIS_KINDS = ["official_counts", "outcome_model", "profile_signals", "none"] as const;

/** A named factor behind a band; direction only, no weights or numbers about the student. */
export const CompetitivenessFactorSchema = z
  .object({
    code: z.string().max(60),
    label: z.string().max(200),
    direction: z.enum(["helps", "hurts", "neutral"]),
  })
  .strict();
export type CompetitivenessFactor = z.infer<typeof CompetitivenessFactorSchema>;

export const CompetitivenessBasisSchema = z
  .object({
    kind: z.enum(BASIS_KINDS),
    /** One or two sentences: what the band rests on and its limits. */
    summary: z.string().max(400),
    /** Official program-level odds (k of n), never a number about this student. */
    stageOdds: z.array(StageOddsSchema),
    currentStage: CountStageSchema.nullable(),
    factors: z.array(CompetitivenessFactorSchema).max(10),
    /** Banded count of verified reports, e.g. "about 10 verified reports". */
    reportsBanded: z.string().max(80).nullable(),
    nEff: z.number().int().nonnegative().nullable(),
    cycles: z.array(z.number().int()).max(10),
    modelVersion: z.string().max(40).nullable(),
    methodologyUrl: UrlSchema.nullable(),
  })
  .strict();
export type CompetitivenessBasis = z.infer<typeof CompetitivenessBasisSchema>;

export const INSUFFICIENT_DATA_REASONS = [
  "no_official_counts",
  "new_program",
  "too_few_reports",
  "sensitive_program",
  "profile_incomplete",
] as const;

export const CompetitivenessSchema = z
  .object({
    status: CompetitivenessStatusSchema,
    band: CompetitivenessBandSchema.nullable(),
    basis: CompetitivenessBasisSchema,
    reason: z.enum(INSUFFICIENT_DATA_REASONS).nullable(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if ((c.status === "available") !== (c.band !== null)) {
      ctx.addIssue({ code: "custom", path: ["band"], message: "a band is present exactly when status is available" });
    }
    if (c.status === "insufficient_data" && c.reason === null) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "insufficient_data names a reason" });
    }
  });
export type Competitiveness = z.infer<typeof CompetitivenessSchema>;

export const NEXT_ACTION_SOURCES = ["gap", "eligibility_unknown", "nomination", "roadmap", "deadline"] as const;

export const NextActionSchema = z
  .object({
    id: z.string().max(80),
    label: z.string().max(200),
    detail: z.string().max(400).nullable(),
    dueOn: IsoDateSchema.nullable(),
    severity: StartSeveritySchema.nullable(),
    source: z.enum(NEXT_ACTION_SOURCES),
    /** Links the action to a Roadmap item when one exists. */
    roadmapItemKey: z.string().max(120).nullable(),
    /** Checklist item or rule this action resolves. */
    relatesTo: z.string().max(80).nullable(),
  })
  .strict();
export type NextAction = z.infer<typeof NextActionSchema>;

export const READINESS_PARTS = ["eligibility", "requirements", "competitiveness", "nextActions"] as const;

export const ReadinessReportSchema = z
  .object({
    programCycleId: IdSchema,
    programSlug: z.string().max(120),
    cycleKey: z.string().max(20),
    algoVersion: z.string().max(40),
    generatedAt: IsoDateTimeSchema,
    eligibility: EligibilityResultSchema,
    requirements: RequirementsChecklistSchema,
    competitiveness: CompetitivenessSchema,
    nextActions: z.array(NextActionSchema).max(10),
  })
  .strict();
export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;

/**
 * Field names that would turn readiness into a single number about a student. Contract tests walk
 * every student-facing schema and fail if one appears. Named fields, not a regex, so legitimate
 * names such as an evidence `match` stay allowed.
 */
export const FORBIDDEN_STUDENT_SCORE_FIELDS = [
  "score",
  "readinessScore",
  "matchScore",
  "matchPercent",
  "percentReady",
  "percentMatch",
  "compositeScore",
  "overallScore",
  "fitScore",
  "chance",
  "chanceOfAdmission",
  "probability",
  "admitProbability",
  "rating",
  "grade",
] as const;

export const ReadinessResponseSchema = z.object({ report: ReadinessReportSchema }).strict();
export type ReadinessResponse = z.infer<typeof ReadinessResponseSchema>;
