import { z } from "zod";
import {
  EvidenceBasisSchema,
  EvidenceEntitySchema,
  EvidenceMatchSchema,
  FreshnessSchema,
  HostPolicySchema,
  SourceKindSchema,
  VerificationDisplaySchema,
  VerificationStoredSchema,
} from "../taxonomy";
import {
  CuratorHandleSchema,
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  Sha256Schema,
  UrlSchema,
} from "./common";

/** Sources, Snapshots, evidence quotes, verification records and citations. */

export const SOURCE_RENDER_MODES = ["static", "javascript", "pdf", "api", "manual"] as const;
export const SOURCE_HEALTH = ["ok", "degraded", "broken", "blocked", "opted_out"] as const;
export const SOURCE_APPROVALS = ["approved", "pending_approval", "rejected"] as const;

export const SourceSchema = z
  .object({
    id: IdSchema,
    kind: SourceKindSchema,
    url: UrlSchema,
    host: z.string().min(1).max(253),
    renderMode: z.enum(SOURCE_RENDER_MODES),
    programId: IdSchema.nullable(),
    organizationId: IdSchema.nullable(),
    approval: z.enum(SOURCE_APPROVALS),
    health: z.enum(SOURCE_HEALTH),
    hostPolicy: HostPolicySchema,
    baselineSnapshotId: IdSchema.nullable(),
    nextCheckAt: IsoDateTimeSchema.nullable(),
    lastFetchedAt: IsoDateTimeSchema.nullable(),
    optedOutOn: IsoDateSchema.nullable(),
  })
  .strict();
export type Source = z.infer<typeof SourceSchema>;

/** How much a new Snapshot differs from the baseline (the change detector's classes). */
export const CHANGE_CLASSES = ["none", "cosmetic", "minor", "key"] as const;
export const ChangeClassSchema = z.enum(CHANGE_CLASSES);
export type ChangeClass = z.infer<typeof ChangeClassSchema>;

export const SnapshotSchema = z
  .object({
    id: IdSchema,
    sourceId: IdSchema,
    fetchedAt: IsoDateTimeSchema,
    requestedUrl: UrlSchema,
    finalUrl: UrlSchema,
    redirectChain: z.array(UrlSchema).max(10),
    httpStatus: z.number().int().min(100).max(599),
    contentType: z.string().max(200),
    rawSha256: Sha256Schema,
    mainTextSha256: Sha256Schema.nullable(),
    normalizerVersion: z.string().max(40),
    /** R2 keys under the `snapshots/` prefix; page bytes never live in D1. */
    rawKey: z.string().max(512),
    textKey: z.string().max(512).nullable(),
    changeClass: ChangeClassSchema.nullable(),
    hostPolicy: HostPolicySchema,
    /** False when the host signals no AI input; such a Snapshot never reaches a model. */
    aiInputAllowed: z.boolean(),
    deleteAfter: IsoDateTimeSchema.nullable(),
    legalHold: z.boolean(),
  })
  .strict();
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Where in a Snapshot a quote sits. Upload, OCR and QR locators are hints, never sole evidence. */
export const EvidenceLocatorSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("html"),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
      selector: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pdf_text"),
      page: z.number().int().min(1),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("upload_text"),
      documentId: IdSchema,
      page: z.number().int().min(1),
      start: z.number().int().nonnegative(),
      end: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ocr_image"),
      documentId: IdSchema,
      page: z.number().int().min(1),
      bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    })
    .strict(),
  z.object({ kind: z.literal("qr"), documentId: IdSchema, payloadUrl: UrlSchema }).strict(),
]);
export type EvidenceLocator = z.infer<typeof EvidenceLocatorSchema>;

export const HINT_LOCATOR_KINDS = ["upload_text", "ocr_image", "qr"] as const;

/**
 * FieldEvidence: one quote backing one field of one record. For basis `snapshot` the quote is the
 * canonical Snapshot text at the locator; quotes and URLs are never rewritten in place.
 */
export const FieldEvidenceSchema = z
  .object({
    id: IdSchema,
    entityType: EvidenceEntitySchema,
    entityId: IdSchema,
    /** Column name ("local_date", "status") or a rule set's evidence key ("e1"). */
    fieldPath: z.string().min(1).max(120),
    basis: EvidenceBasisSchema,
    snapshotId: IdSchema.nullable(),
    attestationTaskId: IdSchema.nullable(),
    url: UrlSchema,
    quote: z.string().min(1).max(2000),
    locator: EvidenceLocatorSchema.nullable(),
    match: EvidenceMatchSchema,
    verifiedBy: CuratorHandleSchema.nullable(),
    supersededAt: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((ev, ctx) => {
    const needsSnapshot = ev.basis === "snapshot";
    if (needsSnapshot !== (ev.snapshotId !== null) && ev.basis !== "attestation") {
      ctx.addIssue({ code: "custom", path: ["snapshotId"], message: "snapshot basis needs a snapshotId; other bases must not have one" });
    }
    if (ev.basis === "attestation" && ev.attestationTaskId === null) {
      ctx.addIssue({ code: "custom", path: ["attestationTaskId"], message: "attestation basis needs a task id" });
    }
  });
export type FieldEvidence = z.infer<typeof FieldEvidenceSchema>;

/**
 * The public, compact form of evidence that rule sets, readiness reports and AI citations carry:
 * where a fact was read, and a short verbatim excerpt.
 */
export const EvidenceQuoteSchema = z
  .object({
    fieldEvidenceId: IdSchema.optional(),
    basis: z.enum(["snapshot", "attestation", "api_record", "manual_note"]),
    url: UrlSchema,
    /** At most 25 words on public surfaces; null where the host forbids republishing excerpts. */
    quote: z.string().max(2000).nullable(),
    retrievedOn: IsoDateSchema.nullable(),
  })
  .strict();
export type EvidenceQuote = z.infer<typeof EvidenceQuoteSchema>;

export const VERIFICATION_METHODS = ["curator_review", "second_review", "api_record", "bulk_unchanged"] as const;

/** A verification event on a registry record. */
export const VerificationSchema = z
  .object({
    entityType: EvidenceEntitySchema,
    entityId: IdSchema,
    state: VerificationStoredSchema,
    method: z.enum(VERIFICATION_METHODS),
    verifiedAt: IsoDateTimeSchema,
    verifiedBy: CuratorHandleSchema,
    evidenceIds: z.array(IdSchema).max(100),
    note: z.string().max(500).optional(),
  })
  .strict();
export type Verification = z.infer<typeof VerificationSchema>;

/** Citation attached to every Program and Deadline that leaves Novus (pages, API, MCP, AI answers). */
export const RecordCitationSchema = z
  .object({
    novusUrl: UrlSchema,
    officialUrl: UrlSchema,
    basis: z.enum(["official", "attested", "predicted", "estimated"]),
    evidenceUrl: UrlSchema.nullable(),
    evidenceExcerpt: z.string().max(400).nullable(),
    lastVerifiedAt: IsoDateSchema.nullable(),
    verifiedBy: CuratorHandleSchema.nullable(),
    derivation: z
      .object({
        method: z.enum(["cycle_prediction", "campus_estimate"]),
        p10: IsoDateSchema.nullable(),
        p90: IsoDateSchema.nullable(),
        leadTimeDays: z.number().int().nonnegative().nullable(),
        priorCycleUrl: UrlSchema.nullable(),
      })
      .strict()
      .nullable(),
    sourceCheckedAt: IsoDateTimeSchema.nullable(),
    verificationState: VerificationDisplaySchema.exclude(["draft"]),
    freshness: FreshnessSchema,
    recordVersion: z.string().max(40),
    license: z.string().max(40),
    termsUrl: UrlSchema,
  })
  .strict();
export type RecordCitation = z.infer<typeof RecordCitationSchema>;
