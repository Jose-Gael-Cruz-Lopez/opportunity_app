import { z } from "zod";
import {
  EligibilityDimensionSchema,
  EligibilityResultSchema,
  IsoDateSchema,
  StudentProfileSchema,
  findSensitiveKeys,
  type EligibilityResult,
  type EligibilityStatus,
  type ProgramCard,
} from "@shared/contracts";
import { buildEvalContext, evaluateEligibility } from "@shared/eligibility";
import { localDateIn } from "@shared/time";
import { ELIGIBILITY_NOTICE, MCP_CONFIG, SENSITIVE_REFUSAL } from "../config";
import { McpCitationSchema } from "../shapes";
import { citeProgram } from "../citation";
import type { ToolDef } from "./types";

/**
 * check_eligibility (plan 8.12, D10). The profile accepts only non-sensitive StudentProfile fields;
 * any other key, and any key that looks like a status or identity answer, is refused with a
 * message that Novus does not accept that information. Criteria on sensitive dimensions come back
 * as self_check with the official rule text, so the student decides privately. The result is
 * never cached and the arguments are never logged; logging records only how many programs were
 * checked, never which ones.
 */

/** The profile fields an assistant may send. Plan 8.12's list plus residence state (state-limited awards). */
export const MCP_PROFILE_KEYS = [
  "classYear",
  "expectedGraduationTerm",
  "institutionLevel",
  "enrollmentIntensity",
  "transferIntent",
  "majorCip",
  "majorFamily",
  "gpaBand",
  "birthYearMonth",
  "residenceState",
] as const;

const McpProfileSchema = StudentProfileSchema.pick({
  classYear: true,
  expectedGraduationTerm: true,
  institutionLevel: true,
  enrollmentIntensity: true,
  transferIntent: true,
  majorCip: true,
  majorFamily: true,
  gpaBand: true,
  birthYearMonth: true,
  residenceState: true,
})
  .partial()
  .strict();

const CheckEligibilityInput = z
  .object({
    programs: z.array(z.string().min(1).max(120)).min(1).max(MCP_CONFIG.maxEligibilityPrograms).describe("Program slugs or ids, 1-10."),
    profile: McpProfileSchema.describe(
      "Non-sensitive profile fields only. Do not send citizenship, immigration, income, Pell, disability, race or ethnicity, gender, sexual orientation, first-generation, veteran or foster-care status.",
    ),
    as_of: IsoDateSchema.optional().describe("Evaluation date (YYYY-MM-DD); defaults to today."),
  })
  .strict();

export const ANSWERS = ["yes", "no", "self_check", "not_fully_checked"] as const;
const ANSWER_FOR: Record<EligibilityStatus, (typeof ANSWERS)[number]> = {
  eligible: "yes",
  not_eligible: "no",
  conditional: "self_check",
  unknown: "not_fully_checked",
};

const SelfCheckSchema = z
  .object({
    dimension: EligibilityDimensionSchema.nullable(),
    /** True for criteria Novus never evaluates on a server (status and identity). */
    sensitive: z.boolean(),
    resolver: z.enum(["student", "novus"]),
    text: z.string(),
  })
  .strict();

const ProgramResultSchema = z
  .object({
    program: z.string(),
    found: z.boolean(),
    slug: z.string().nullable(),
    name: z.string().nullable(),
    cycleKey: z.string().nullable(),
    answer: z.enum(ANSWERS).nullable(),
    selfCheck: z.array(SelfCheckSchema),
    result: EligibilityResultSchema.nullable(),
    isSample: z.boolean().nullable(),
    citation: McpCitationSchema.nullable(),
  })
  .strict();

const CheckEligibilityOutput = z.object({ results: z.array(ProgramResultSchema), notice: z.string() }).strict();

/** Refuses sensitive-looking keys anywhere and any profile key outside the allowlist, without echoing them. */
export function precheckEligibilityArgs(value: unknown): string | null {
  if (findSensitiveKeys(value).length > 0) return SENSITIVE_REFUSAL;
  if (value && typeof value === "object" && "profile" in value) {
    const profile = (value as { profile: unknown }).profile;
    if (profile && typeof profile === "object" && !Array.isArray(profile)) {
      const allowed: readonly string[] = MCP_PROFILE_KEYS;
      if (Object.keys(profile).some((k) => !allowed.includes(k))) return `${SENSITIVE_REFUSAL} Accepted profile fields: ${MCP_PROFILE_KEYS.join(", ")}.`;
    }
  }
  return null;
}

/** Same engine and context as the browser and POST /api/v1/eligibility/check, so the tuples agree. */
export function evaluateCard(card: ProgramCard, profile: z.infer<typeof McpProfileSchema>, asOf: string): EligibilityResult {
  const context = buildEvalContext({ deadlines: card.deadlines.map((d) => ({ ...d, institutionId: null })) });
  return evaluateEligibility(card.rules, profile, { asOf, context });
}

function selfCheckItems(result: EligibilityResult): z.infer<typeof SelfCheckSchema>[] {
  return result.pending.map((p) => ({ dimension: p.dimension, sensitive: p.sensitive, resolver: p.resolver, text: p.selfCheckText }));
}

export const checkEligibilityTool: ToolDef<typeof CheckEligibilityInput, typeof CheckEligibilityOutput> = {
  name: "check_eligibility",
  title: "Check eligibility",
  description:
    "Checks 1-10 published programs against non-sensitive profile fields (class year, graduation term, institution " +
    "level, enrollment, transfer intent, major, GPA band, birth month, residence state). Returns per program an answer " +
    "(yes, no, self_check or not_fully_checked), the rule-by-rule reasons with official rule text, the items left for the " +
    "student to check, the rule-set version and a citation. Status and identity criteria always come back as self_check.",
  input: CheckEligibilityInput,
  output: CheckEligibilityOutput,
  precheck: precheckEligibilityArgs,
  async run(args, ctx) {
    const asOf = args.as_of ?? localDateIn(ctx.now, "UTC");
    const citation = { origin: ctx.origin, release: ctx.registry.release };
    const results = args.programs.map((ref) => {
      const card = ctx.registry.findCard(ref);
      if (!card) {
        return { program: ref, found: false, slug: null, name: null, cycleKey: null, answer: null, selfCheck: [], result: null, isSample: null, citation: null };
      }
      const result = evaluateCard(card, args.profile, asOf);
      return {
        program: ref,
        found: true,
        slug: card.slug,
        name: card.name,
        cycleKey: card.cycleKey,
        answer: ANSWER_FOR[result.status],
        selfCheck: selfCheckItems(result),
        result,
        isSample: card.isSample,
        citation: citeProgram(card, citation),
      };
    });
    return {
      output: { results, notice: ELIGIBILITY_NOTICE },
      resultCount: args.programs.length,
      programIds: null,
    };
  },
};
