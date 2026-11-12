import { z } from "zod";
import { DeadlineKindSchema, RequirementKindSchema } from "../taxonomy";
import { ELIGIBILITY_DIMENSIONS } from "./eligibility";

/**
 * extraction.v1: what an LLM may propose from one official page. Structured-output limits allow
 * no unions, nullable fields or optional properties, so every leaf is a plain-string
 * `{value, quote, status, basis}` and empty strings mean "not stated". The server parses typed
 * values from the located quote span, never from `value`.
 */

export const LeafStatusSchema = z.enum(["found", "not_stated", "ambiguous"]);
export const LeafBasisSchema = z.enum(["stated", "inferred"]);

export const LeafSchema = z
  .object({ value: z.string(), quote: z.string(), status: LeafStatusSchema, basis: LeafBasisSchema })
  .strict();
export type Leaf = z.infer<typeof LeafSchema>;

export const DeadlineDraftSchema = z
  .object({
    kind: DeadlineKindSchema,
    scope: z.enum(["national", "campus"]),
    precision: z.enum(["exact", "date_only", "month_only", "rolling", "tbd"]),
    /** `not_stated` exists only in drafts and maps to a TZ_MISSING finding. */
    tz_mode: z.enum(["fixed", "applicant_local", "not_stated"]),
    round_label: z.string(),
    local_date: z.string(),
    local_time: z.string(),
    time_zone_text: z.string(),
    quote: z.string(),
    status: LeafStatusSchema,
    basis: LeafBasisSchema,
  })
  .strict();
export type DeadlineDraft = z.infer<typeof DeadlineDraftSchema>;

/**
 * One stated eligibility restriction, flat. The compiler turns rows into an EligibilityRuleSet.
 * A dimension without a row stays `not_reviewed`; `no_restriction` needs an affirmative quote.
 */
export const EligibilityRowSchema = z
  .object({
    clause_id: z.string(),
    row_kind: z.enum(["clause", "attest"]),
    dimension: z.enum(ELIGIBILITY_DIMENSIONS),
    operator: z.enum(["in", "not_in", "gte", "lte", "between", "is_true", "is_false", "no_restriction"]),
    values: z.array(z.string()),
    measure: z.string(),
    as_of: z.string(),
    borderline: z.array(z.string()),
    group: z.string(),
    quote: z.string(),
  })
  .strict();
export type EligibilityRow = z.infer<typeof EligibilityRowSchema>;

export const PAGE_KINDS = [
  "current_cycle",
  "next_cycle_announced",
  "past_cycle",
  "program_ended",
  "not_a_program_page",
  "mixed",
] as const;

export const ExtractionPageV1Schema = z
  .object({
    page_kind: z.enum(PAGE_KINDS),
    program_name: LeafSchema,
    organization_name: LeafSchema,
    cycle_label: LeafSchema,
    cycle_status: LeafSchema,
    opens_on: LeafSchema,
    application_url: LeafSchema,
    cost_to_participate: LeafSchema,
    stipend: LeafSchema,
    award_count: LeafSchema,
    applicant_count: LeafSchema,
    nomination_required: LeafSchema,
    campus_quota_text: LeafSchema,
    primary_type: LeafSchema,
    deadlines: z.array(DeadlineDraftSchema),
    requirements: z.array(z.object({ kind: RequirementKindSchema, detail: z.string(), quote: z.string() }).strict()),
    eligibility_rows: z.array(EligibilityRowSchema),
  })
  .strict();
export type ExtractionPageV1 = z.infer<typeof ExtractionPageV1Schema>;
