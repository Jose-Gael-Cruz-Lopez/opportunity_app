import { z } from "zod";
import { IsoDateSchema, type ProgramCard } from "@shared/contracts";
import { buildEvalContext, evaluateEligibility } from "@shared/eligibility";
import type { SearchFilters } from "@shared/matching";
import { ClassYearSchema, CycleStatusSchema, MajorFamilySchema, OpportunityTypeSlugSchema } from "@shared/taxonomy";
import { localDateIn } from "@shared/time";
import { MCP_CONFIG } from "../config";

/** Non-sensitive catalogue filters shared by search_programs and list_deadlines. */
export const catalogueFilterShape = {
  types: z.array(OpportunityTypeSlugSchema).max(10).optional().describe("Opportunity type slugs, for example summer_internship."),
  class_years: z.array(ClassYearSchema).max(8).optional().describe("Keep programs open to any of these class years."),
  major_families: z.array(MajorFamilySchema).max(16).optional().describe("Keep programs open to any of these fields (programs open to all majors always pass)."),
  paid: z.boolean().optional().describe("true keeps only paid programs (stipend, salary or award)."),
} as const;

export const limitSchema = z
  .number()
  .int()
  .min(1)
  .max(MCP_CONFIG.maxResults)
  .optional()
  .describe(`Results per page, at most ${MCP_CONFIG.maxResults}.`);

export const searchFilterShape = {
  ...catalogueFilterShape,
  statuses: z.array(CycleStatusSchema).max(6).optional().describe("Current-cycle statuses, for example open or expected."),
  deadline_after: IsoDateSchema.optional().describe("Next deadline on or after this date (YYYY-MM-DD)."),
  deadline_before: IsoDateSchema.optional().describe("Next deadline on or before this date (YYYY-MM-DD)."),
  open_to_community_college: z.boolean().optional().describe("true drops programs whose verified rules exclude two-year college students."),
} as const;

export interface CatalogueFilterArgs {
  readonly types?: readonly z.infer<typeof OpportunityTypeSlugSchema>[];
  readonly class_years?: readonly z.infer<typeof ClassYearSchema>[];
  readonly major_families?: readonly z.infer<typeof MajorFamilySchema>[];
  readonly paid?: boolean;
  readonly statuses?: readonly z.infer<typeof CycleStatusSchema>[];
  readonly deadline_after?: string;
  readonly deadline_before?: string;
}

export function toSearchFilters(args: CatalogueFilterArgs): SearchFilters {
  return {
    ...(args.types?.length ? { types: args.types } : {}),
    ...(args.class_years?.length ? { classYears: args.class_years } : {}),
    ...(args.major_families?.length ? { majorFamilies: args.major_families } : {}),
    ...(args.statuses?.length ? { statuses: args.statuses } : {}),
    ...(args.paid !== undefined ? { paid: args.paid } : {}),
    ...(args.deadline_after ? { deadlineAfter: args.deadline_after } : {}),
    ...(args.deadline_before ? { deadlineBefore: args.deadline_before } : {}),
  };
}

/**
 * True unless the card's verified rules rule out a two-year college student. Uses the same
 * eligibility engine as everything else, with only `institutionLevel` known, so a program whose
 * rules say nothing about institution level stays in.
 */
export function openToCommunityCollege(card: ProgramCard, now: number): boolean {
  if (!card.rules) return true;
  const result = evaluateEligibility(
    card.rules,
    { institutionLevel: "two_year" },
    { asOf: localDateIn(now, "UTC"), context: buildEvalContext({ deadlines: card.deadlines.map((d) => ({ ...d, institutionId: null })) }) },
  );
  return result.verdict !== "not_met";
}
