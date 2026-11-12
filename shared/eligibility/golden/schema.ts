import { z } from "zod";
import { ELIGIBILITY_STATUSES, ELIGIBILITY_VERDICTS, EligibilityRuleSetObjectSchema, RESOLVERS } from "../../contracts/eligibility";
import { REASON_CODES } from "../reasons";

/**
 * Format of the golden files in this folder. They are the cross-runtime contract: the Node runner
 * (golden.test.ts), the Worker and browser runners once configured, and the Python pipeline all
 * read the same JSON. golden-files.schema.json is generated from these schemas for pydantic.
 *
 * - rule-sets.json: sample rule sets with every default explicit and an expected hash.
 * - cases.json: hand-labelled cases. `device` holds synthetic SensitiveAnswers and attestation
 *   answers; such cases list only the runtimes that may see them (browser, node), and every runner
 *   checks the redacted twin (the same case without `device`) instead.
 * - reason-templates.json: the reason and self-check copy, mirrored from reasons.ts.
 */

export const GOLDEN_RUNTIMES = ["node", "workerd", "browser", "python"] as const;

const VerdictSchema = z.enum(ELIGIBILITY_VERDICTS);

export const GoldenPendingSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["rule", "attestation", "coverage", "rule_set_missing"]),
    resolver: z.enum(RESOLVERS),
    sensitive: z.boolean(),
  })
  .strict();

export const GoldenExpectSchema = z
  .object({
    verdict: VerdictSchema,
    status: z.enum(ELIGIBILITY_STATUSES),
    /** Verdict per rule and attestation id. */
    rules: z.record(VerdictSchema),
    reasonCodes: z.record(z.enum(REASON_CODES as [string, ...string[]])),
    /** Missing field names per rule id; rules not listed expect []. */
    missingFields: z.record(z.array(z.string())).optional(),
    /** Compared as a set (order-insensitive). */
    pending: z.array(GoldenPendingSchema),
    basedOnListedRequirements: z.boolean(),
  })
  .strict();

export const GoldenDeviceSchema = z
  .object({
    /** Synthetic SensitiveAnswers (shape of shared/contracts/sensitive.ts). */
    answers: z.record(z.unknown()),
    attestations: z.record(z.boolean()),
  })
  .strict();

export const GoldenContextSchema = z
  .object({
    anchors: z.record(z.string()),
    institution: z
      .object({
        id: z.string().nullable(),
        level: z.string().nullable(),
        calendar: z.string().nullable(),
        academicYearStartMonth: z.number().int(),
        participates: z.literal(true).nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const GoldenCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    sample: z.literal(true),
    tags: z.array(z.string()),
    runtimes: z.array(z.enum(GOLDEN_RUNTIMES)).min(1),
    /** Key into rule-sets.json, or null for "no rule set". */
    ruleSet: z.string().nullable(),
    /** Key into the file's contexts. */
    context: z.string(),
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Non-sensitive StudentProfile fields (partial). */
    profile: z.record(z.unknown()),
    device: GoldenDeviceSchema.optional(),
    expect: GoldenExpectSchema,
  })
  .strict()
  .refine((c) => !c.device || c.runtimes.every((r) => r === "browser" || r === "node"), "device cases run only in browser and node");

export const GoldenCasesFileSchema = z
  .object({
    $comment: z.string(),
    format: z.literal("jsonlogic-v1"),
    /** Oldest ENGINE_VERSION the expectations hold for; runners refuse newer files. */
    engineMin: z.string(),
    sample: z.literal(true),
    contexts: z.record(GoldenContextSchema),
    cases: z.array(GoldenCaseSchema),
  })
  .strict();

export const GoldenRuleSetsFileSchema = z
  .object({
    $comment: z.string(),
    ruleSets: z.record(
      z
        .object({
          sample: z.literal(true),
          note: z.string(),
          expectHash: z.string().regex(/^[0-9a-f]{64}$/),
          ruleSet: EligibilityRuleSetObjectSchema,
        })
        .strict(),
    ),
  })
  .strict();

export type GoldenCase = z.infer<typeof GoldenCaseSchema>;
export type GoldenCasesFile = z.infer<typeof GoldenCasesFileSchema>;
export type GoldenRuleSetsFile = z.infer<typeof GoldenRuleSetsFileSchema>;
