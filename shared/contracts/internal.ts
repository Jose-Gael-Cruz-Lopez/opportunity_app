import { z } from "zod";
import {
  CycleKeySchema,
  CycleModelSchema,
  CycleStatusSchema,
  DeadlineBasisSchema,
  DeadlineKindSchema,
  DeadlinePrecisionSchema,
  DeadlineScopeSchema,
  IdentityCategorySchema,
  OpportunityTypeSlugSchema,
  OrganizationKindSchema,
  RecurrenceSchema,
  RequirementKindSchema,
  SourceKindSchema,
  TzModeSchema,
} from "../taxonomy";
import {
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  LocalTimeSchema,
  PublishedDateSchema,
  Sha256Schema,
  SlugSchema,
  TimeZoneSchema,
  UrlSchema,
} from "./common";
import { EligibilityRuleSetDraftSchema } from "./eligibility";
import { EvidenceLocatorSchema } from "./evidence";
import { ExtractionPageV1Schema } from "./extraction.v1";

/**
 * Internal ingest shapes for `/internal/v1/*`. The pipeline holds no database credentials; it posts
 * these bodies signed with HMAC (key id + timestamp + nonce) and the Worker validates and writes.
 */

export const HMAC_HEADERS = {
  keyId: "x-novus-key-id",
  timestamp: "x-novus-timestamp",
  nonce: "x-novus-nonce",
  signature: "x-novus-signature",
} as const;

/** One quote with where it was found; the Worker recomputes the canonical span. */
export const EvidenceInputSchema = z
  .object({
    fieldPath: z.string().min(1).max(120),
    url: UrlSchema,
    quote: z.string().min(1).max(2000),
    snapshotId: IdSchema.nullable(),
    locator: EvidenceLocatorSchema.nullable(),
    basis: z.enum(["snapshot", "api_record", "manual_note"]),
  })
  .strict();
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;

export const DeadlineInputSchema = z
  .object({
    kind: DeadlineKindSchema,
    scope: DeadlineScopeSchema,
    institutionId: IdSchema.nullable().default(null),
    roundLabel: z.string().max(60).default(""),
    basis: DeadlineBasisSchema,
    precision: DeadlinePrecisionSchema,
    tzMode: TzModeSchema,
    localDate: PublishedDateSchema.nullable(),
    localTime: LocalTimeSchema.nullable(),
    windowStart: IsoDateSchema.nullable().default(null),
    windowEnd: IsoDateSchema.nullable().default(null),
    timeZone: TimeZoneSchema.nullable(),
    evidence: z.array(EvidenceInputSchema).max(5),
  })
  .strict();
export type DeadlineInput = z.infer<typeof DeadlineInputSchema>;

/**
 * A Curator-verified workbook row (or console edit) for one program cycle. `verified_by` comes from
 * the authenticated key, never from the payload.
 */
export const CurationPatchSchema = z
  .object({
    rowHash: Sha256Schema,
    organization: z
      .object({
        slug: SlugSchema,
        name: z.string().min(1).max(200),
        kind: OrganizationKindSchema,
        country: z.string().length(2).default("US"),
        defaultTimeZone: TimeZoneSchema.nullable(),
        websiteUrl: UrlSchema.nullable(),
      })
      .strict(),
    program: z
      .object({
        slug: SlugSchema,
        name: z.string().min(1).max(200),
        summary: z.string().max(600).nullable(),
        officialUrl: UrlSchema,
        recurrence: RecurrenceSchema,
        opportunityTypes: z.array(OpportunityTypeSlugSchema).min(1).max(5),
        sensitiveAudience: z.boolean(),
        identityAudience: z.array(IdentityCategorySchema).max(10),
        aliases: z.array(z.string().max(80)).max(20).default([]),
      })
      .strict(),
    cycle: z
      .object({
        cycleKey: CycleKeySchema,
        termLabel: z.string().min(1).max(40),
        cycleModel: CycleModelSchema,
        status: CycleStatusSchema,
        timeZone: TimeZoneSchema.nullable(),
        opensOn: IsoDateSchema.nullable(),
        applicationUrl: UrlSchema.nullable(),
        applicationFeeCents: z.number().int().nonnegative().nullable(),
        participantCostCents: z.number().int().nonnegative().nullable(),
        pellDisplacement: z.enum(["none", "possible", "yes", "unknown"]).default("unknown"),
        statusEvidence: z.array(EvidenceInputSchema).max(5),
      })
      .strict(),
    deadlines: z.array(DeadlineInputSchema).max(20),
    requirements: z
      .array(
        z
          .object({
            kind: RequirementKindSchema,
            label: z.string().min(1).max(200),
            quantity: z.number().int().min(1).max(20).default(1),
            wordLimit: z.number().int().positive().nullable().default(null),
            evidence: z.array(EvidenceInputSchema).max(3),
          })
          .strict(),
      )
      .max(30),
    /** Draft rule set; ids, version, state and hash are assigned by the Worker. */
    ruleSet: EligibilityRuleSetDraftSchema.nullable(),
    isSample: z.boolean().default(false),
  })
  .strict();
export type CurationPatch = z.infer<typeof CurationPatchSchema>;

export const CurationPatchResultSchema = z
  .object({
    status: z.enum(["applied", "already_applied", "rejected"]),
    programId: IdSchema.nullable(),
    programCycleId: IdSchema.nullable(),
    release: z.number().int().nonnegative().nullable(),
    findings: z.array(z.object({ code: z.string().max(60), path: z.string().max(200) }).strict()),
  })
  .strict();
export type CurationPatchResult = z.infer<typeof CurationPatchResultSchema>;

export const SnapshotIngestSchema = z
  .object({
    sourceId: IdSchema.nullable(),
    sourceKind: SourceKindSchema,
    requestedUrl: UrlSchema,
    finalUrl: UrlSchema,
    redirectChain: z.array(UrlSchema).max(10),
    fetchedAt: IsoDateTimeSchema,
    httpStatus: z.number().int().min(100).max(599),
    contentType: z.string().max(200),
    rawSha256: Sha256Schema,
    mainTextSha256: Sha256Schema.nullable(),
    normalizerVersion: z.string().max(40),
    /** Base64 bytes for small pages; large bodies go to R2 via a signed upload first. */
    rawBase64: z.string().max(14_000_000).nullable(),
    mainText: z.string().max(2_000_000).nullable(),
    aiInputAllowed: z.boolean(),
    pdfPages: z.number().int().nonnegative().nullable(),
  })
  .strict();
export type SnapshotIngest = z.infer<typeof SnapshotIngestSchema>;

export const SnapshotIngestResultSchema = z
  .object({
    snapshotId: IdSchema,
    changeClass: z.enum(["none", "cosmetic", "minor", "key"]).nullable(),
    stored: z.boolean(),
  })
  .strict();

export const ExtractionIngestSchema = z
  .object({
    snapshotId: IdSchema,
    routeId: z.string().max(60),
    routeVersion: z.string().max(20),
    modelRequested: z.string().max(80),
    modelServed: z.string().max(80),
    promptVersion: z.string().max(40),
    schemaVersion: z.literal("extraction.v1"),
    requestId: z.string().max(120),
    payload: ExtractionPageV1Schema,
  })
  .strict();
export type ExtractionIngest = z.infer<typeof ExtractionIngestSchema>;

export const HeartbeatSchema = z
  .object({
    worker: z.string().max(60),
    at: IsoDateTimeSchema,
    version: z.string().max(40),
    leasedJobs: z.number().int().nonnegative(),
  })
  .strict();
export type Heartbeat = z.infer<typeof HeartbeatSchema>;
