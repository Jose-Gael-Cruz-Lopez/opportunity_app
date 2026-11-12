import { z } from "zod";
import {
  ClassYearSchema,
  CountKindSchema,
  CountStageSchema,
  CycleKeySchema,
  CycleModelSchema,
  CycleStatusSchema,
  DeadlineBasisSchema,
  DeadlineKindSchema,
  DeadlinePrecisionSchema,
  DeadlineScopeSchema,
  FreshnessSchema,
  IdentityCategorySchema,
  InstitutionCalendarSchema,
  InstitutionLevelSchema,
  LifecycleSchema,
  MajorFamilySchema,
  OpportunityTypeSlugSchema,
  OrganizationKindSchema,
  PellDisplacementSchema,
  PredictionLabelSchema,
  RecurrenceSchema,
  RequirementKindSchema,
  TzModeSchema,
  TzSourceSchema,
  UsStateSchema,
  VerificationDisplaySchema,
  VerificationStoredSchema,
} from "../taxonomy";
import { isIsoDate, isIsoMonth } from "../time/iso";
import {
  CentsSchema,
  CuratorHandleSchema,
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  LocalTimeSchema,
  PublishedDateSchema,
  SampleFlagSchema,
  SlugSchema,
  TimeZoneSchema,
  UrlSchema,
} from "./common";
import { EligibilityRuleSetSchema } from "./eligibility";
import { EvidenceQuoteSchema, RecordCitationSchema } from "./evidence";

/** Registry entities: Organization, Program, ProgramCycle, Deadline, Requirement, Institution. */

export const OrganizationSchema = z
  .object({
    id: IdSchema,
    slug: SlugSchema,
    name: z.string().min(1).max(200),
    kind: OrganizationKindSchema,
    country: z.string().length(2),
    /** Used for fixed deadlines whose page states no zone (tz_source = org_default). */
    defaultTimeZone: TimeZoneSchema.nullable(),
    websiteUrl: UrlSchema.nullable(),
    isSample: SampleFlagSchema,
  })
  .strict();
export type Organization = z.infer<typeof OrganizationSchema>;

export const ProgramSchema = z
  .object({
    id: IdSchema,
    slug: SlugSchema,
    name: z.string().min(1).max(200),
    organizationId: IdSchema,
    /** Original prose written by Novus, never copied from the official page. */
    summary: z.string().max(600).nullable(),
    officialUrl: UrlSchema,
    recurrence: RecurrenceSchema,
    lifecycle: LifecycleSchema,
    opportunityTypes: z.array(OpportunityTypeSlugSchema).min(1).max(5),
    /** Open only to a non-citizen status, Pell recipients or a health condition: server never links a student to it without consent. */
    sensitiveAudience: z.boolean(),
    /** Communities a program serves (describes the program, never a student). */
    identityAudience: z.array(IdentityCategorySchema).max(10),
    majorFamilies: z.array(MajorFamilySchema).max(16).default([]),
    interestTags: z.array(z.string().min(1).max(40)).max(20).default([]),
    aliases: z.array(z.string().min(1).max(80)).max(20).default([]),
    isWedge: z.boolean().default(false),
    isPublished: z.boolean(),
    isSample: SampleFlagSchema,
    version: z.number().int().min(1),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.identityAudience.includes("health") && !p.sensitiveAudience) {
      ctx.addIssue({ code: "custom", path: ["sensitiveAudience"], message: "health audience requires sensitiveAudience" });
    }
  });
export type Program = z.infer<typeof ProgramSchema>;

export const COMPENSATION_KINDS = ["stipend", "salary_hourly", "award", "tuition", "travel", "none", "varies"] as const;
export const CompensationSchema = z
  .object({
    kind: z.enum(COMPENSATION_KINDS),
    amountCents: CentsSchema.nullable(),
    period: z.enum(["one_time", "hour", "week", "month", "term", "year", "total"]).nullable(),
    note: z.string().max(200).optional(),
  })
  .strict();
export type Compensation = z.infer<typeof CompensationSchema>;

/**
 * A Deadline keeps what the official page said plus any derivable instant. Refinements mirror
 * the table's CHECKs, so an invalid row fails at the single write path before it reaches D1.
 */
const DeadlineBaseSchema = z
  .object({
    id: IdSchema,
    programCycleId: IdSchema,
    kind: DeadlineKindSchema,
    scope: DeadlineScopeSchema,
    institutionId: IdSchema.nullable(),
    roundLabel: z.string().max(60).default(""),
    basis: DeadlineBasisSchema,
    precision: DeadlinePrecisionSchema,
    tzMode: TzModeSchema,
    localDate: PublishedDateSchema.nullable(),
    localTime: LocalTimeSchema.nullable(),
    windowStart: IsoDateSchema.nullable(),
    windowEnd: IsoDateSchema.nullable(),
    timeZone: TimeZoneSchema.nullable(),
    tzSource: TzSourceSchema.nullable(),
    /** Derived by shared/time computeDueAt; null for applicant-local, month-only, window, rolling, TBD. */
    dueAt: IsoDateTimeSchema.nullable(),
    sortAt: IsoDateTimeSchema.nullable(),
    revision: z.number().int().min(1),
    verificationState: VerificationStoredSchema,
    withdrawnAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export function deadlineIssues(d: z.infer<typeof DeadlineBaseSchema>): { path: string; message: string }[] {
  const issues: { path: string; message: string }[] = [];
  const dated = ["exact", "date_only", "month_only", "window"].includes(d.precision);
  if (d.scope === "campus" && d.institutionId === null) issues.push({ path: "institutionId", message: "campus rows name an institution" });
  if (d.basis === "attested" && d.scope !== "campus") issues.push({ path: "basis", message: "attested rows are campus rows" });
  const hasWindow = d.windowStart !== null && d.windowEnd !== null;
  if ((d.precision === "window") !== hasWindow) issues.push({ path: "precision", message: "window precision requires windowStart and windowEnd" });
  if (d.precision === "window" && d.basis !== "predicted") issues.push({ path: "basis", message: "only predicted rows use window precision" });
  if (d.basis === "predicted" && !["window", "tbd"].includes(d.precision)) issues.push({ path: "precision", message: "predicted rows are window or tbd" });
  if (dated !== (d.localDate !== null)) issues.push({ path: "localDate", message: "localDate is required exactly for dated precisions" });
  if (d.localDate !== null) {
    const wantsMonth = d.precision === "month_only";
    if (wantsMonth ? !isIsoMonth(d.localDate) : !isIsoDate(d.localDate)) {
      issues.push({ path: "localDate", message: wantsMonth ? "month-only rows use YYYY-MM" : "use YYYY-MM-DD" });
    }
  }
  if ((d.precision === "exact") !== (d.localTime !== null)) issues.push({ path: "localTime", message: "localTime is required exactly for exact rows" });
  if (d.tzMode === "applicant_local") {
    if (d.timeZone !== null) issues.push({ path: "timeZone", message: "applicant-local rows store no zone" });
    if (!["exact", "date_only"].includes(d.precision)) issues.push({ path: "precision", message: "applicant-local rows are exact or date_only" });
  } else if (d.timeZone === null && !["month_only", "rolling", "tbd"].includes(d.precision)) {
    issues.push({ path: "timeZone", message: "fixed dated rows need a zone" });
  }
  const shouldHaveDueAt = d.tzMode === "fixed" && ["exact", "date_only"].includes(d.precision);
  if (shouldHaveDueAt !== (d.dueAt !== null)) issues.push({ path: "dueAt", message: "dueAt exists exactly for fixed exact or date_only rows" });
  if (hasWindow && d.windowStart! > d.windowEnd!) issues.push({ path: "windowEnd", message: "window ends before it starts" });
  return issues;
}

export const DeadlineSchema = DeadlineBaseSchema.superRefine((d, ctx) => {
  for (const issue of deadlineIssues(d)) ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
});
export type Deadline = z.infer<typeof DeadlineSchema>;

export const PredictionSchema = z
  .object({
    p10: IsoDateSchema,
    p50: IsoDateSchema,
    p90: IsoDateSchema,
    label: PredictionLabelSchema,
    method: z.enum(["official_rule", "history", "curator_month", "curator_estimate"]),
  })
  .strict();
export type Prediction = z.infer<typeof PredictionSchema>;

export const ProgramCycleSchema = z
  .object({
    id: IdSchema,
    programId: IdSchema,
    cycleKey: CycleKeySchema,
    termLabel: z.string().min(1).max(40),
    cycleModel: CycleModelSchema,
    status: CycleStatusSchema,
    statusChangedAt: IsoDateTimeSchema,
    /** "system:pipeline.hourly" or a Curator handle. */
    statusChangedBy: z.string().max(80),
    /** Default zone for this cycle's fixed deadlines (stated on the page, else the Organization's). */
    timeZone: TimeZoneSchema.nullable(),
    opensOn: IsoDateSchema.nullable(),
    predictedOpensOn: IsoDateSchema.nullable(),
    predictionLabel: PredictionLabelSchema.nullable(),
    decisionWindowStart: IsoDateSchema.nullable(),
    decisionWindowEnd: IsoDateSchema.nullable(),
    decisionsReleasedOn: IsoDateSchema.nullable(),
    eventStart: IsoDateSchema.nullable(),
    eventEnd: IsoDateSchema.nullable(),
    applicationUrl: UrlSchema.nullable(),
    pellDisplacement: PellDisplacementSchema,
    applicationFeeCents: CentsSchema.nullable(),
    participantCostCents: CentsSchema.nullable(),
    compensation: CompensationSchema.nullable(),
    verificationState: VerificationStoredSchema,
    lastVerifiedAt: IsoDateTimeSchema.nullable(),
    verifiedBy: CuratorHandleSchema.nullable(),
    sourceCheckedAt: IsoDateTimeSchema.nullable(),
    rolledOverFromId: IdSchema.nullable(),
    version: z.number().int().min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    const verifiedLike = !["draft", "unverified"].includes(c.verificationState);
    if (verifiedLike && (c.lastVerifiedAt === null || c.verifiedBy === null)) {
      ctx.addIssue({ code: "custom", path: ["verifiedBy"], message: "verified cycles record when and by whom" });
    }
  });
export type ProgramCycle = z.infer<typeof ProgramCycleSchema>;

export const RequirementSchema = z
  .object({
    id: IdSchema,
    programCycleId: IdSchema,
    kind: RequirementKindSchema,
    /** The official wording, short. */
    label: z.string().min(1).max(200),
    detail: z.string().max(200).nullable(),
    quantity: z.number().int().min(1).max(20).default(1),
    wordLimit: z.number().int().min(1).max(20000).nullable(),
    /** A Requirement may have its own deadline (for example, letters due before the application). */
    deadlineId: IdSchema.nullable(),
    /** Curator overrides of the guidance table. */
    effortHours: z.number().min(0).max(500).nullable(),
    leadTimeDays: z.number().int().min(0).max(365).nullable(),
    evidence: EvidenceQuoteSchema.nullable(),
    verificationState: VerificationStoredSchema,
  })
  .strict();
export type Requirement = z.infer<typeof RequirementSchema>;

export const InstitutionSchema = z
  .object({
    id: IdSchema,
    /** IPEDS UNITID. */
    unitId: z.string().regex(/^\d{6}$/).nullable(),
    name: z.string().min(1).max(200),
    level: InstitutionLevelSchema,
    control: z.enum(["public", "private_nonprofit", "private_for_profit"]).nullable(),
    state: UsStateSchema.nullable(),
    calendar: InstitutionCalendarSchema.nullable(),
    academicYearStartMonth: z.number().int().min(1).max(12).default(8),
    timeZone: TimeZoneSchema.nullable(),
    isHbcu: z.boolean().default(false),
    isTribal: z.boolean().default(false),
    isHsi: z.boolean().default(false),
    emailDomains: z.array(z.string().max(253)).max(20).default([]),
  })
  .strict();
export type Institution = z.infer<typeof InstitutionSchema>;

/** Official count per stage (only `official_publication` rows feed odds). */
export const ProgramCycleCountSchema = z
  .object({
    programCycleId: IdSchema,
    stage: CountStageSchema,
    count: z.number().int().nonnegative(),
    kind: CountKindSchema,
    provenance: z.enum(["official_publication", "owner_reported"]),
    asOf: IsoDateSchema,
    evidence: EvidenceQuoteSchema.nullable(),
  })
  .strict();
export type ProgramCycleCount = z.infer<typeof ProgramCycleCountSchema>;

/** Odds between two consecutive official stages, as k of n with its source. Program-level, never about a student. */
export const StageOddsSchema = z
  .object({
    fromStage: CountStageSchema,
    toStage: CountStageSchema,
    cycleYear: z.number().int().min(1990).max(2100),
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().positive(),
    denominatorKind: CountKindSchema,
    sourceUrl: UrlSchema,
    verifiedAt: IsoDateSchema,
    verifiedBy: CuratorHandleSchema,
  })
  .strict()
  .refine((o) => o.numerator <= o.denominator, "numerator exceeds denominator");
export type StageOdds = z.infer<typeof StageOddsSchema>;

// ---------------------------------------------------------------------------------------------
// Read models served to clients.
// ---------------------------------------------------------------------------------------------

/** A national Deadline as listed on cards (no internal ids beyond the row id). */
export const DeadlineViewSchema = z
  .object({
    id: IdSchema,
    kind: DeadlineKindSchema,
    scope: DeadlineScopeSchema,
    roundLabel: z.string().max(60),
    basis: DeadlineBasisSchema,
    precision: DeadlinePrecisionSchema,
    tzMode: TzModeSchema,
    localDate: PublishedDateSchema.nullable(),
    localTime: LocalTimeSchema.nullable(),
    windowStart: IsoDateSchema.nullable(),
    windowEnd: IsoDateSchema.nullable(),
    timeZone: TimeZoneSchema.nullable(),
    dueAt: IsoDateTimeSchema.nullable(),
    sortAt: IsoDateTimeSchema.nullable(),
    revision: z.number().int().min(1),
  })
  .strict();
export type DeadlineView = z.infer<typeof DeadlineViewSchema>;

/** Flags the client needs without loading detail (cost, Pell displacement, audiences). */
export const ProgramFlagsSchema = z
  .object({
    paid: z.boolean(),
    participantCost: z.boolean(),
    applicationFee: z.boolean(),
    pellDisplacement: z.boolean(),
    sensitiveAudience: z.boolean(),
    identityAudience: z.boolean(),
    nominationRequired: z.boolean(),
  })
  .strict();
export type ProgramFlags = z.infer<typeof ProgramFlagsSchema>;

/** One card per current cycle, as shipped in the release artifact and list responses. */
export const ProgramCardSchema = z
  .object({
    programId: IdSchema,
    programCycleId: IdSchema,
    slug: SlugSchema,
    cycleKey: CycleKeySchema,
    name: z.string().max(200),
    organizationName: z.string().max(200),
    summary: z.string().max(600).nullable(),
    opportunityTypes: z.array(OpportunityTypeSlugSchema),
    status: CycleStatusSchema,
    verification: z
      .object({
        state: VerificationDisplaySchema,
        verifiedOn: IsoDateSchema.nullable(),
        verifiedBy: CuratorHandleSchema.nullable(),
        freshness: FreshnessSchema,
      })
      .strict(),
    deadlines: z.array(DeadlineViewSchema),
    opensOn: IsoDateSchema.nullable(),
    prediction: PredictionSchema.nullable(),
    classYears: z.array(ClassYearSchema),
    majorFamilies: z.array(MajorFamilySchema),
    cipPrefixes: z.array(z.string().max(7)),
    interestTags: z.array(z.string().max(40)),
    aliases: z.array(z.string().max(80)),
    flags: ProgramFlagsSchema,
    compensation: CompensationSchema.nullable(),
    applicationUrl: UrlSchema.nullable(),
    officialUrl: UrlSchema,
    /** Max lead + effort days across curated Requirements; null means unknown, never zero. */
    prepDays: z.number().int().nonnegative().nullable(),
    /** The current verified rule set (or the previous cycle's, see rulesFromPreviousCycle). */
    rules: EligibilityRuleSetSchema.nullable(),
    rulesFromPreviousCycle: CycleKeySchema.nullable(),
    isSample: SampleFlagSchema,
  })
  .strict();
export type ProgramCard = z.infer<typeof ProgramCardSchema>;

/** Lazily loaded detail for one program (`GET /api/v1/programs/:slug`). */
export const ProgramDetailSchema = z
  .object({
    program: ProgramSchema,
    organization: OrganizationSchema,
    cycle: ProgramCycleSchema,
    deadlines: z.array(DeadlineSchema),
    requirements: z.array(RequirementSchema),
    requirementsChecked: z.boolean(),
    counts: z.array(ProgramCycleCountSchema),
    stageOdds: z.array(StageOddsSchema),
    prediction: PredictionSchema.nullable(),
    ruleSet: EligibilityRuleSetSchema.nullable(),
    otherCycles: z.array(z.object({ cycleKey: CycleKeySchema, status: CycleStatusSchema }).strict()),
    citation: RecordCitationSchema,
    release: z.number().int().nonnegative(),
  })
  .strict();
export type ProgramDetail = z.infer<typeof ProgramDetailSchema>;

/** The immutable per-release artifact the browser and Worker index (client-core). */
export const ReleaseArtifactSchema = z
  .object({
    v: z.literal(1),
    release: z.number().int().nonnegative(),
    generatedAt: IsoDateTimeSchema,
    cards: z.array(ProgramCardSchema),
    /** Loser slug -> survivor slug for merges in the last 13 months. */
    merged: z.record(SlugSchema),
    /** True when any card is sample data (local development, demos). */
    containsSample: z.boolean(),
  })
  .strict();
export type ReleaseArtifact = z.infer<typeof ReleaseArtifactSchema>;

export const ReleasePointerSchema = z
  .object({ release: z.number().int().nonnegative(), path: z.string().max(200), sha256: z.string().max(64), publishedAt: IsoDateTimeSchema })
  .strict();
export type ReleasePointer = z.infer<typeof ReleasePointerSchema>;
