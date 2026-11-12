import { z } from "zod";
import {
  CITIZENSHIP_STATUSES,
  CLASS_YEARS,
  DeadlineKindSchema,
  ENROLLMENT_INTENSITIES,
  GPA_BANDS,
  IDENTITY_CATEGORIES,
  IDENTITY_VALUES,
  INSTITUTION_LEVELS,
  MAJOR_FAMILIES,
  NominatorSchema,
  PELL_ANSWERS,
  STATUS_ANSWERS,
  TRANSFER_INTENTS,
  US_STATES,
  type IdentityCategory,
} from "../taxonomy";
import { IdSchema, IsoDateSchema, IsoDateTimeSchema, CuratorHandleSchema, Sha256Schema, SlugSchema } from "./common";
import { EvidenceQuoteSchema } from "./evidence";
import { StudentProfileSchema } from "./student";

/**
 * Eligibility contracts. A rule set is a versioned list of JsonLogic rules over a fixed field
 * catalogue. Each rule names the fields it reads and whether any of them is sensitive, so the
 * evaluator can return met / not_met / unknown per rule with a reason and its evidence, and so
 * sensitive rules are evaluated only in the browser.
 */

// ---------------------------------------------------------------------------------------------
// Dimensions and coverage
// ---------------------------------------------------------------------------------------------

export const ELIGIBILITY_DIMENSIONS = [
  "standing",
  "enrollment",
  "transfer",
  "gpa",
  "citizenship",
  "pell",
  "institution",
  "field",
  "identity",
  "age",
  "residency",
  "first_gen",
  "prior_award",
  "team",
  "host_enrollment",
] as const;
export const EligibilityDimensionSchema = z.enum(ELIGIBILITY_DIMENSIONS);
export type EligibilityDimension = z.infer<typeof EligibilityDimensionSchema>;

/** Dimensions a verified rule set must encode or mark no_restriction (never none_stated). */
export const LAUNCH_DIMENSIONS = ["standing", "enrollment", "transfer", "gpa", "citizenship", "pell"] as const satisfies readonly EligibilityDimension[];

/** Dimensions whose answers are SensitiveAnswers; rules on them are always `sensitive`. */
export const SENSITIVE_DIMENSIONS = ["citizenship", "pell", "identity", "first_gen"] as const satisfies readonly EligibilityDimension[];

export const COVERAGE_STATES = ["encoded", "no_restriction", "none_stated", "not_reviewed"] as const;
export const CoverageSchema = z.enum(COVERAGE_STATES);
export type Coverage = z.infer<typeof CoverageSchema>;

// ---------------------------------------------------------------------------------------------
// Field catalogue: the only variables a rule may read.
// ---------------------------------------------------------------------------------------------

export type EligibilityFieldSource = "profile" | "derived" | "context" | "sensitive";
export type EligibilityValueType = "enum" | "enum_list" | "number" | "string" | "boolean";

export interface EligibilityFieldDef {
  readonly label: string;
  readonly valueType: EligibilityValueType;
  readonly values?: readonly string[];
  readonly dimension: EligibilityDimension;
  readonly source: EligibilityFieldSource;
  /** True for SensitiveAnswers: read only in the browser, never sent to a server or a model. */
  readonly sensitive: boolean;
  /** Answers that count as "not answered", leaving the rule unknown. */
  readonly unknownValues?: readonly string[];
}

const UNANSWERED = ["prefer_not", "not_sure", "none_yet"] as const;

const identityFields = Object.fromEntries(
  IDENTITY_CATEGORIES.map((category) => [
    `identity.${category}`,
    {
      label: `Identity: ${category.replace(/_/g, " ")}`,
      valueType: "enum_list",
      values: IDENTITY_VALUES[category],
      dimension: "identity",
      source: "sensitive",
      sensitive: true,
      unknownValues: ["prefer_not"],
    } satisfies EligibilityFieldDef,
  ]),
) as unknown as Record<`identity.${IdentityCategory}`, EligibilityFieldDef>;

export const ELIGIBILITY_FIELDS = {
  classYear: { label: "Class year", valueType: "enum", values: CLASS_YEARS, dimension: "standing", source: "profile", sensitive: false },
  semestersRemaining: { label: "Full-time semesters remaining at the rule's date", valueType: "number", dimension: "standing", source: "derived", sensitive: false },
  yearsRemaining: { label: "Years of study remaining at the rule's date", valueType: "number", dimension: "standing", source: "derived", sensitive: false },
  expectedGraduationTerm: { label: "Expected graduation term", valueType: "string", dimension: "standing", source: "profile", sensitive: false },
  expectedGraduationYear: { label: "Expected graduation year", valueType: "number", dimension: "standing", source: "derived", sensitive: false },
  enrollmentIntensity: { label: "Full-time or part-time", valueType: "enum", values: ENROLLMENT_INTENSITIES, dimension: "enrollment", source: "profile", sensitive: false, unknownValues: ["not_sure"] },
  institutionLevel: { label: "Two-year or four-year institution", valueType: "enum", values: INSTITUTION_LEVELS, dimension: "enrollment", source: "profile", sensitive: false },
  transferIntent: { label: "Transfer plans", valueType: "enum", values: TRANSFER_INTENTS, dimension: "transfer", source: "profile", sensitive: false, unknownValues: ["not_sure"] },
  gpaBand: { label: "GPA band", valueType: "enum", values: GPA_BANDS, dimension: "gpa", source: "profile", sensitive: false, unknownValues: UNANSWERED },
  gpaMin: { label: "Lower edge of the GPA band", valueType: "number", dimension: "gpa", source: "derived", sensitive: false },
  gpaMax: { label: "Upper edge of the GPA band", valueType: "number", dimension: "gpa", source: "derived", sensitive: false },
  majorCip: { label: "Major (CIP code)", valueType: "string", dimension: "field", source: "profile", sensitive: false },
  minorCip: { label: "Minor (CIP code)", valueType: "string", dimension: "field", source: "profile", sensitive: false },
  majorFamily: { label: "Major family", valueType: "enum", values: MAJOR_FAMILIES, dimension: "field", source: "profile", sensitive: false, unknownValues: ["undeclared"] },
  residenceState: { label: "State of residence", valueType: "enum", values: US_STATES, dimension: "residency", source: "profile", sensitive: false },
  ageAtAsOf: { label: "Age at the rule's date", valueType: "number", dimension: "age", source: "derived", sensitive: false },
  institutionId: { label: "Institution", valueType: "string", dimension: "institution", source: "profile", sensitive: false },
  institutionParticipates: { label: "Your institution can nominate", valueType: "boolean", dimension: "institution", source: "context", sensitive: false },
  citizenship: { label: "Citizenship or immigration status", valueType: "enum", values: CITIZENSHIP_STATUSES, dimension: "citizenship", source: "sensitive", sensitive: true, unknownValues: ["prefer_not"] },
  pell: { label: "Federal Pell Grant", valueType: "enum", values: PELL_ANSWERS, dimension: "pell", source: "sensitive", sensitive: true, unknownValues: ["prefer_not"] },
  financialNeed: { label: "Demonstrated financial need", valueType: "enum", values: STATUS_ANSWERS, dimension: "pell", source: "sensitive", sensitive: true, unknownValues: ["prefer_not", "not_sure"] },
  firstGeneration: { label: "First-generation college student", valueType: "enum", values: STATUS_ANSWERS, dimension: "first_gen", source: "sensitive", sensitive: true, unknownValues: ["prefer_not", "not_sure"] },
  ...identityFields,
} as const satisfies Record<string, EligibilityFieldDef>;

export type EligibilityFieldKey = keyof typeof ELIGIBILITY_FIELDS;
export const ELIGIBILITY_FIELD_KEYS = Object.keys(ELIGIBILITY_FIELDS) as [EligibilityFieldKey, ...EligibilityFieldKey[]];
export const EligibilityFieldKeySchema = z.enum(ELIGIBILITY_FIELD_KEYS);

export function getEligibilityField(key: string): EligibilityFieldDef | undefined {
  return (ELIGIBILITY_FIELDS as Record<string, EligibilityFieldDef>)[key];
}

export function isSensitiveField(key: string): boolean {
  return getEligibilityField(key)?.sensitive ?? false;
}

export const SENSITIVE_FIELD_KEYS = ELIGIBILITY_FIELD_KEYS.filter((k) => isSensitiveField(k));

// ---------------------------------------------------------------------------------------------
// JsonLogic expressions
// ---------------------------------------------------------------------------------------------

/** JsonLogic operators a rule may use (no `log`, no `method`, nothing with side effects). */
export const JSON_LOGIC_OPERATORS = [
  "var", "missing", "missing_some",
  "==", "===", "!=", "!==", "<", "<=", ">", ">=",
  "!", "!!", "and", "or", "if", "?:",
  "in", "all", "some", "none", "merge",
  "+", "-", "*", "/", "%", "min", "max",
  "cat", "substr",
] as const;
const OPERATOR_SET: ReadonlySet<string> = new Set(JSON_LOGIC_OPERATORS);

export type JsonLogicExpression = { [operator: string]: unknown };

/** Walks an expression, returning variable names and any disallowed operators. */
export function inspectJsonLogic(expr: unknown): { vars: string[]; badOperators: string[] } {
  const vars = new Set<string>();
  const bad = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const keys = Object.keys(node);
    if (keys.length !== 1) {
      bad.add(`{${keys.join(",")}}`);
      return;
    }
    const op = keys[0] as string;
    const arg = (node as Record<string, unknown>)[op];
    if (!OPERATOR_SET.has(op)) bad.add(op);
    if (op === "var") {
      const name = Array.isArray(arg) ? arg[0] : arg;
      if (typeof name === "string" && name !== "") vars.add(name);
      if (Array.isArray(arg)) arg.slice(1).forEach(visit);
      return;
    }
    if (op === "missing" || op === "missing_some") {
      const list = op === "missing" ? arg : Array.isArray(arg) ? arg[1] : [];
      (Array.isArray(list) ? list : [list]).forEach((n) => typeof n === "string" && vars.add(n));
      return;
    }
    if (op === "all" || op === "some" || op === "none") {
      // The second argument runs against each array item, so its vars are item-relative.
      if (Array.isArray(arg)) visit(arg[0]);
      return;
    }
    visit(arg);
  };
  visit(expr);
  return { vars: [...vars], badOperators: [...bad] };
}

export const JsonLogicExpressionSchema = z
  .record(z.unknown())
  .refine((e) => Object.keys(e).length === 1, "a JsonLogic expression has exactly one operator")
  .refine((e) => inspectJsonLogic(e).badOperators.length === 0, "unsupported JsonLogic operator");

// ---------------------------------------------------------------------------------------------
// Rules, attestations, nomination and the rule set
// ---------------------------------------------------------------------------------------------

export const RULE_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
export const RuleIdSchema = z.string().regex(RULE_ID_PATTERN, "rule id: lowercase, digits, _ . : -");
export const EvidenceKeySchema = z.string().regex(/^e\d{1,3}$/, "evidence key like e1");

/** Which date a rule is judged at (standing and age rules). */
export const RULE_AS_OF = ["today", "campus_deadline", "national_deadline", "program_start"] as const;

export const EligibilityRuleSchema = z
  .object({
    /** Stable across versions and cycles, so diffs compare rules by id. */
    id: RuleIdSchema,
    dimension: EligibilityDimensionSchema,
    /** "all" or the id of an anyOf group. */
    group: z.string().min(1).max(40).default("all"),
    logic: JsonLogicExpressionSchema,
    /** Every catalogue field the logic reads. */
    fields: z.array(EligibilityFieldKeySchema).min(1).max(12),
    /** True when any field is sensitive; the rule is then evaluated only on the device. */
    sensitive: z.boolean(),
    asOf: z.enum(RULE_AS_OF).default("today"),
    /** CIP prefixes for which a field rule returns unknown instead of not_met. */
    borderline: z.array(z.string().max(7)).max(50).default([]),
    /** The rule as the official page states it, shown as "Eligible if ..." text. */
    officialText: z.string().min(1).max(400),
    evidenceKey: EvidenceKeySchema.nullable().default(null),
  })
  .strict()
  .superRefine((rule, ctx) => {
    const { vars } = inspectJsonLogic(rule.logic);
    const declared = new Set<string>(rule.fields);
    for (const v of vars) {
      if (!getEligibilityField(v)) ctx.addIssue({ code: "custom", path: ["logic"], message: `unknown field ${v}` });
      else if (!declared.has(v)) ctx.addIssue({ code: "custom", path: ["fields"], message: `logic reads undeclared field ${v}` });
    }
    const anySensitive = rule.fields.some((f) => isSensitiveField(f)) || (SENSITIVE_DIMENSIONS as readonly string[]).includes(rule.dimension);
    if (anySensitive !== rule.sensitive) {
      ctx.addIssue({ code: "custom", path: ["sensitive"], message: "sensitive must be true exactly when a field or the dimension is sensitive" });
    }
  });
export type EligibilityRule = z.infer<typeof EligibilityRuleSchema>;

/** A restriction the rules cannot express; the student confirms it on the device. */
export const AttestationSchema = z
  .object({
    id: RuleIdSchema,
    dimension: EligibilityDimensionSchema,
    text: z.string().min(1).max(400),
    /** Defaults to true: attestation text often names status, health or identity criteria. */
    sensitive: z.boolean().default(true),
    evidenceKey: EvidenceKeySchema.nullable().default(null),
  })
  .strict();
export type Attestation = z.infer<typeof AttestationSchema>;

export const AnyOfGroupSchema = z
  .object({ id: z.string().min(1).max(40).refine((v) => v !== "all", "reserved"), label: z.string().min(1).max(120) })
  .strict();

/** Nomination is process, not eligibility: it feeds requirements and reminders, never the verdict. */
export const NominationProcessSchema = z
  .object({
    nominator: NominatorSchema,
    campusDeadlineKinds: z.array(DeadlineKindSchema).max(5),
    quota: z
      .object({
        base: z.number().int().min(0),
        bonuses: z.array(z.object({ if: z.string().max(80), add: z.number().int().min(1) }).strict()).max(5),
        max: z.number().int().min(0),
      })
      .strict()
      .nullable(),
    evidenceKey: EvidenceKeySchema.nullable(),
  })
  .strict();
export type NominationProcess = z.infer<typeof NominationProcessSchema>;

export const RULE_SET_STATES = ["draft", "verified", "superseded"] as const;
export const RULE_SET_CREATED_VIA = ["sheet", "console", "rollover", "llm_draft", "sample"] as const;
export const RULE_SET_FORMAT = "jsonlogic-v1" as const;

/** The rule set's fields without cross-field checks (use EligibilityRuleSetSchema to validate). */
export const EligibilityRuleSetObjectSchema = z
  .object({
    id: IdSchema,
    programCycleId: IdSchema,
    version: z.number().int().min(1),
    format: z.literal(RULE_SET_FORMAT),
    state: z.enum(RULE_SET_STATES),
    templateKey: z.string().max(80).nullable().default(null),
    /** Missing dimensions count as not_reviewed, which can never yield "eligible". */
    coverage: z.record(EligibilityDimensionSchema, CoverageSchema),
    rules: z.array(EligibilityRuleSchema).max(60),
    anyOf: z.array(AnyOfGroupSchema).max(10).default([]),
    attestations: z.array(AttestationSchema).max(20).default([]),
    nomination: NominationProcessSchema.nullable().default(null),
    /** Evidence quotes by key; rules and attestations point here so a quote is stored once. */
    evidence: z.record(EvidenceKeySchema, EvidenceQuoteSchema).default({}),
    /** sha256 of the canonical JSON of the rules; set when verified. */
    hash: Sha256Schema.nullable().default(null),
    createdVia: z.enum(RULE_SET_CREATED_VIA),
    verifiedAt: IsoDateTimeSchema.nullable().default(null),
    verifiedBy: CuratorHandleSchema.nullable().default(null),
    /** Rules copied from an earlier cycle and labelled "may change". */
    fromCycleKey: z.string().max(20).nullable().default(null),
  })
  .strict();

export const EligibilityRuleSetSchema = EligibilityRuleSetObjectSchema.superRefine((rs, ctx) => {
    const groupIds = new Set(rs.anyOf.map((g) => g.id));
    const ids = new Set<string>();
    for (const [i, rule] of rs.rules.entries()) {
      if (ids.has(rule.id)) ctx.addIssue({ code: "custom", path: ["rules", i, "id"], message: "duplicate rule id" });
      ids.add(rule.id);
      if (rule.group !== "all" && !groupIds.has(rule.group)) {
        ctx.addIssue({ code: "custom", path: ["rules", i, "group"], message: "unknown anyOf group" });
      }
      if (rule.evidenceKey && !(rule.evidenceKey in rs.evidence)) {
        ctx.addIssue({ code: "custom", path: ["rules", i, "evidenceKey"], message: "evidence key not in evidence map" });
      }
    }
    for (const [i, a] of rs.attestations.entries()) {
      if (ids.has(a.id)) ctx.addIssue({ code: "custom", path: ["attestations", i, "id"], message: "duplicate id" });
      ids.add(a.id);
    }
    if (rs.state !== "draft" && (rs.hash === null || rs.verifiedBy === null || rs.verifiedAt === null)) {
      ctx.addIssue({ code: "custom", path: ["state"], message: "verified rule sets carry hash, verifiedBy and verifiedAt" });
    }
    for (const dim of LAUNCH_DIMENSIONS) {
      if (rs.coverage[dim] === "none_stated") {
        ctx.addIssue({ code: "custom", path: ["coverage", dim], message: "launch dimensions are encoded or no_restriction, never none_stated" });
      }
    }
  });
export type EligibilityRuleSet = z.infer<typeof EligibilityRuleSetSchema>;
export type EligibilityRuleSetInput = z.input<typeof EligibilityRuleSetSchema>;

/** A draft as Curators or the pipeline submit it; the Worker assigns ids, version, state and hash. */
export const EligibilityRuleSetDraftSchema = EligibilityRuleSetObjectSchema.omit({
  id: true,
  programCycleId: true,
  version: true,
  state: true,
  hash: true,
  verifiedAt: true,
  verifiedBy: true,
});
export type EligibilityRuleSetDraft = z.infer<typeof EligibilityRuleSetDraftSchema>;

// ---------------------------------------------------------------------------------------------
// Results: tri-state per rule, display status overall. No score.
// ---------------------------------------------------------------------------------------------

export const ELIGIBILITY_VERDICTS = ["met", "not_met", "unknown"] as const;
export const EligibilityVerdictSchema = z.enum(ELIGIBILITY_VERDICTS);
export type EligibilityVerdict = z.infer<typeof EligibilityVerdictSchema>;

/**
 * eligible: every rule met. not_eligible: a rule not met. conditional: unknown, and the student can
 * resolve every open item ("Eligible if ..."). unknown: Novus has not checked something yet.
 */
export const ELIGIBILITY_STATUSES = ["eligible", "conditional", "unknown", "not_eligible"] as const;
export const EligibilityStatusSchema = z.enum(ELIGIBILITY_STATUSES);
export type EligibilityStatus = z.infer<typeof EligibilityStatusSchema>;

export const RESOLVERS = ["student", "novus"] as const;
export const ResolverSchema = z.enum(RESOLVERS);

export const EligibilityRuleResultSchema = z
  .object({
    ruleId: RuleIdSchema,
    dimension: EligibilityDimensionSchema,
    group: z.string().max(40),
    verdict: EligibilityVerdictSchema,
    sensitive: z.boolean(),
    /** Stable code for copy templates, e.g. ELIGIBLE_STANDING, MISSING_FIELD, SENSITIVE_ON_DEVICE. */
    reasonCode: z.string().max(60),
    /** Plain-language reason shown beside the evidence. */
    reason: z.string().max(400),
    officialText: z.string().max(400),
    /** Catalogue fields that were missing or unanswered (names only, never values). */
    missingFields: z.array(EligibilityFieldKeySchema),
    resolver: ResolverSchema.nullable(),
    evidenceKey: EvidenceKeySchema.nullable(),
    evidence: EvidenceQuoteSchema.nullable(),
  })
  .strict();
export type EligibilityRuleResult = z.infer<typeof EligibilityRuleResultSchema>;

export const EligibilityPendingSchema = z
  .object({
    id: z.string().max(80),
    kind: z.enum(["rule", "attestation", "coverage", "rule_set_missing"]),
    dimension: EligibilityDimensionSchema.nullable(),
    sensitive: z.boolean(),
    resolver: ResolverSchema,
    /** "Eligible if ..." text the student can check against the official rule. */
    selfCheckText: z.string().max(400),
  })
  .strict();
export type EligibilityPending = z.infer<typeof EligibilityPendingSchema>;

export const EligibilityResultSchema = z
  .object({
    verdict: EligibilityVerdictSchema,
    status: EligibilityStatusSchema,
    rules: z.array(EligibilityRuleResultSchema),
    pending: z.array(EligibilityPendingSchema),
    nomination: NominationProcessSchema.nullable(),
    ruleSet: z
      .object({ id: IdSchema.nullable(), version: z.number().int().min(1), hash: Sha256Schema.nullable() })
      .strict()
      .nullable(),
    /** True when an eligible verdict rests on a none_stated dimension. */
    basedOnListedRequirements: z.boolean(),
    asOf: IsoDateSchema,
    /** True only in the browser, when SensitiveAnswers were part of the evaluation. */
    sensitiveEvaluated: z.boolean(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const expected: Record<EligibilityVerdict, EligibilityStatus[]> = {
      met: ["eligible"],
      not_met: ["not_eligible"],
      unknown: ["conditional", "unknown"],
    };
    if (!expected[r.verdict].includes(r.status)) {
      ctx.addIssue({ code: "custom", path: ["status"], message: `status ${r.status} does not match verdict ${r.verdict}` });
    }
    if (!r.sensitiveEvaluated && r.rules.some((x) => x.sensitive && x.verdict !== "unknown")) {
      ctx.addIssue({ code: "custom", path: ["rules"], message: "sensitive rules stay unknown unless evaluated on the device" });
    }
  });
export type EligibilityResult = z.infer<typeof EligibilityResultSchema>;

// ---------------------------------------------------------------------------------------------
// Server check (non-sensitive fields only; `.strict()` rejects status or identity keys).
// ---------------------------------------------------------------------------------------------

export const EligibilityCheckRequestSchema = z
  .object({
    programs: z.array(SlugSchema).min(1).max(10),
    profile: StudentProfileSchema.partial().strict(),
    asOf: IsoDateSchema.optional(),
  })
  .strict();
export type EligibilityCheckRequest = z.infer<typeof EligibilityCheckRequestSchema>;

export const EligibilityCheckResponseSchema = z
  .object({
    results: z.array(
      z.object({ slug: SlugSchema, cycleKey: z.string().max(20).nullable(), result: EligibilityResultSchema }).strict(),
    ),
  })
  .strict();
export type EligibilityCheckResponse = z.infer<typeof EligibilityCheckResponseSchema>;
