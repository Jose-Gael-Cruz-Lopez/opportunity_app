import { z } from "zod";
import {
  EligibilityDimensionSchema,
  NominationProcessSchema,
  type EligibilityRuleSet,
  type ProgramCard,
  type ProgramDetail,
  type StageOdds,
} from "@shared/contracts";
import { CountStageSchema, RequirementKindSchema } from "@shared/taxonomy";
import type { CitationContext } from "../citation";
import { citeProgram } from "../citation";
import { ProgramFactsSchema, publicDeadlines, toMcpDeadline, toProgramSummary } from "../shapes";
import { ToolError, type ToolDef } from "./types";

export const INCLUDE_PARTS = ["requirements", "eligibility", "odds", "predictions", "history"] as const;

const GetProgramInput = z
  .object({
    program: z.string().min(1).max(120).describe("Program slug (for example sample-example-leadership-fellowship) or id."),
    include: z.array(z.enum(INCLUDE_PARTS)).max(INCLUDE_PARTS.length).optional().describe("Extra sections to return."),
  })
  .strict();

const RequirementOut = z
  .object({
    kind: RequirementKindSchema,
    label: z.string(),
    detail: z.string().nullable(),
    quantity: z.number().int(),
    wordLimit: z.number().int().nullable(),
    leadTimeDays: z.number().int().nullable(),
  })
  .strict();

const EligibilityRuleOut = z
  .object({
    id: z.string(),
    dimension: EligibilityDimensionSchema,
    group: z.string(),
    /** The rule as the official page states it (or a Curator paraphrase where the host forbids quoting). */
    officialText: z.string(),
    /** Sensitive criteria are checked only by the student, privately. */
    selfCheckOnly: z.boolean(),
  })
  .strict();

const EligibilityOut = z
  .object({
    rules: z.array(EligibilityRuleOut),
    anyOf: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
    attestations: z.array(z.object({ id: z.string(), text: z.string() }).strict()),
    nomination: NominationProcessSchema.nullable(),
    ruleSet: z.object({ id: z.string(), version: z.number().int(), hash: z.string().nullable() }).strict(),
    /** Set when the rules were carried over from an earlier cycle and may change. */
    fromPreviousCycle: z.string().nullable(),
  })
  .strict();

const OddsOut = z
  .object({
    fromStage: CountStageSchema,
    toStage: CountStageSchema,
    cycleYear: z.number().int(),
    numerator: z.number().int(),
    denominator: z.number().int(),
    /** "12 of 340 (applicants to awards, 2026, official count)"; "at most" when the denominator is a lower bound. */
    text: z.string(),
    sourceUrl: z.string(),
    verifiedAt: z.string(),
    verifiedBy: z.string(),
  })
  .strict();

const GetProgramOutput = z
  .object({
    program: ProgramFactsSchema,
    /** False when this release published no per-program detail; requirements, odds and history are then absent. */
    detailAvailable: z.boolean(),
    requirements: z.array(RequirementOut).optional(),
    requirementsChecked: z.boolean().optional(),
    eligibility: EligibilityOut.nullable().optional(),
    odds: z.array(OddsOut).optional(),
    history: z.array(z.object({ cycleKey: z.string(), status: z.string() }).strict()).optional(),
    release: z.number().int(),
  })
  .strict();

type Include = (typeof INCLUDE_PARTS)[number];

export function eligibilityView(rules: EligibilityRuleSet, fromPreviousCycle: string | null): z.infer<typeof EligibilityOut> {
  return {
    rules: rules.rules.map((r) => ({ id: r.id, dimension: r.dimension, group: r.group, officialText: r.officialText, selfCheckOnly: r.sensitive })),
    anyOf: rules.anyOf.map((g) => ({ id: g.id, label: g.label })),
    attestations: rules.attestations.map((a) => ({ id: a.id, text: a.text })),
    nomination: rules.nomination,
    ruleSet: { id: rules.id, version: rules.version, hash: rules.hash },
    fromPreviousCycle,
  };
}

const ODDS_QUALIFIER: Record<StageOdds["denominatorKind"], string> = { exact: "", lower_bound: "at most ", approx: "about " };

/** Official counts only; "at most" marks a lower-bound denominator so the rate is never overstated. */
export function oddsView(odds: StageOdds): z.infer<typeof OddsOut> {
  const from = odds.fromStage.replace(/_/g, " ");
  const to = odds.toStage.replace(/_/g, " ");
  return {
    fromStage: odds.fromStage,
    toStage: odds.toStage,
    cycleYear: odds.cycleYear,
    numerator: odds.numerator,
    denominator: odds.denominator,
    text: `${ODDS_QUALIFIER[odds.denominatorKind]}${odds.numerator} of ${odds.denominator} (${from} to ${to}, ${odds.cycleYear}, official count)`,
    sourceUrl: odds.sourceUrl,
    verifiedAt: odds.verifiedAt,
    verifiedBy: odds.verifiedBy,
  };
}

function facts(card: ProgramCard, ctx: CitationContext, now: number, detail: ProgramDetail | null, include: ReadonlySet<Include>) {
  const summary = toProgramSummary(card, ctx, now);
  return {
    ...summary,
    citation: citeProgram(card, ctx, detail),
    classYears: card.classYears,
    majorFamilies: card.majorFamilies,
    compensation: card.compensation,
    prepDays: card.prepDays,
    prediction: include.has("predictions") && card.prediction ? { ...card.prediction, note: "predicted, not announced" } : null,
    deadlines: publicDeadlines(card).map((d) => toMcpDeadline(card, d, ctx)),
  };
}

export const getProgramTool: ToolDef<typeof GetProgramInput, typeof GetProgramOutput> = {
  name: "get_program",
  title: "Get program",
  description:
    "Returns one published program and its current cycle: status, every national deadline with its citation, cost and " +
    "pay flags, and on request its Curator-confirmed requirements, eligibility rules as official text, official " +
    "stage counts (k of n), labeled date predictions and past cycles.",
  input: GetProgramInput,
  output: GetProgramOutput,
  async run(args, ctx) {
    const card = ctx.registry.findCard(args.program);
    if (!card) throw new ToolError("No published program matches that slug or id.", "not_found");
    const include = new Set<Include>(args.include ?? []);
    // Detail is always read: the program citation's evidence URL and excerpt come from it.
    const detail = await ctx.registry.getDetail(card.slug);
    const citation = { origin: ctx.origin, release: ctx.registry.release };
    const ruleSet = card.rules ?? detail?.ruleSet ?? null;
    return {
      output: {
        program: facts(card, citation, ctx.now, detail, include),
        detailAvailable: detail !== null,
        ...(include.has("requirements") && detail
          ? {
              // Only Curator-confirmed requirement text leaves Novus.
              requirements: detail.requirements
                .filter((r) => r.verificationState === "verified")
                .map((r) => ({ kind: r.kind, label: r.label, detail: r.detail, quantity: r.quantity, wordLimit: r.wordLimit, leadTimeDays: r.leadTimeDays })),
              requirementsChecked: detail.requirementsChecked,
            }
          : {}),
        ...(include.has("eligibility") ? { eligibility: ruleSet ? eligibilityView(ruleSet, card.rulesFromPreviousCycle) : null } : {}),
        ...(include.has("odds") && detail ? { odds: detail.stageOdds.map(oddsView) } : {}),
        ...(include.has("history") && detail ? { history: detail.otherCycles } : {}),
        release: ctx.registry.release,
      },
      resultCount: 1,
      programIds: null,
    };
  },
};
