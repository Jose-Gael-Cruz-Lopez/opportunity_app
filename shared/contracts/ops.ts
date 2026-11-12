import { z } from "zod";
import { EvidenceEntitySchema, ReviewTaskKindSchema, ReviewTaskStateSchema } from "../taxonomy";
import { CuratorHandleSchema, IdSchema, IsoDateTimeSchema } from "./common";

/** Jobs, audit logs and ReviewTasks. */

// ---------------------------------------------------------------------------------------------
// Jobs: the database is the queue. Worker kinds are `area.action`; Modal kinds are snake_case.
// ---------------------------------------------------------------------------------------------

export const WORKER_JOB_KINDS = [
  "notify.dispatch",
  "reminders.schedule",
  "alerts.match",
  "digest.send",
  "eligibility.audience",
  "campus_lead.refresh",
  "sources.enqueue_due",
  "pipeline.hourly",
  "audit.draw",
  "release.build",
  "cards.render",
  "sweep",
  "deletion.process",
  "audit.digest",
  "growth.daily",
  "growth.weekly",
  "registry.snapshot",
  "outcomes.quality",
  "aggregates.publish",
  "bands.fit",
] as const;

export const PIPELINE_JOB_KINDS = [
  "curate_import",
  "fetch",
  "nsf_sync",
  "list_sync",
  "rollover",
  "predict_cycles",
  "llm",
  "llm_collect",
  "eval_run",
  "docintel_ocr_hint",
  "docintel_eval",
  "mirror_export",
  "backup_copy",
] as const;

export const JOB_KINDS = [...WORKER_JOB_KINDS, ...PIPELINE_JOB_KINDS] as const;
export const JobKindSchema = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof JobKindSchema>;

export const JOB_STATUSES = ["pending", "leased", "done", "dead"] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobSchema = z
  .object({
    id: IdSchema,
    kind: JobKindSchema,
    /** Opaque ids only, never user-to-program pairs. */
    payload: z.record(z.unknown()),
    /** e.g. `fetch:{sourceId}:{slot}`; user-linked parts are HMACs. */
    idempotencyKey: z.string().min(1).max(200),
    /** e.g. `host:example.org`: at most one live lease per key. */
    concurrencyKey: z.string().max(200).nullable(),
    status: JobStatusSchema,
    priority: z.number().int().min(0).max(9),
    attempts: z.number().int().nonnegative(),
    maxAttempts: z.number().int().min(1).max(20),
    runAfter: IsoDateTimeSchema,
    leaseOwner: z.string().max(100).nullable(),
    leaseExpiresAt: IsoDateTimeSchema.nullable(),
    /** Error class only, never a stack trace or user data. */
    lastError: z.string().max(200).nullable(),
    finishedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();
export type Job = z.infer<typeof JobSchema>;

export const JobLeaseRequestSchema = z
  .object({
    kinds: z.array(z.enum(PIPELINE_JOB_KINDS)).min(1),
    max: z.number().int().min(1).max(50).default(5),
    leaseSeconds: z.number().int().min(30).max(3600).default(600),
    owner: z.string().min(1).max(100),
  })
  .strict();
export type JobLeaseRequest = z.infer<typeof JobLeaseRequestSchema>;

export const JobLeaseResponseSchema = z.object({ jobs: z.array(JobSchema) }).strict();
export type JobLeaseResponse = z.infer<typeof JobLeaseResponseSchema>;

export const JobCompleteSchema = z
  .object({ owner: z.string().min(1).max(100), result: z.record(z.unknown()).default({}) })
  .strict();
export const JobFailSchema = z
  .object({
    owner: z.string().min(1).max(100),
    errorClass: z.string().min(1).max(200),
    /** retry: back off; defer: a dependency is down, retry later without counting an attempt; dead: stop. */
    disposition: z.enum(["retry", "defer", "dead"]),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Audit logs. Registry audits keep before/after values of public registry fields; access audits
// keep field names and a pseudonymous subject key, never values.
// ---------------------------------------------------------------------------------------------

export const ActorSchema = z
  .object({
    kind: z.enum(["user", "curator", "system", "pipeline", "admin"]),
    /** Curator handle, a job name such as `system:pipeline.hourly`, or a pseudonymous key. */
    ref: z.string().max(120),
  })
  .strict();
export type Actor = z.infer<typeof ActorSchema>;

export const RegistryAuditEntrySchema = z
  .object({
    log: z.literal("registry"),
    id: z.string().max(80),
    at: IsoDateTimeSchema,
    actor: ActorSchema,
    entityType: EvidenceEntitySchema,
    entityId: IdSchema,
    field: z.string().max(120),
    before: z.unknown(),
    after: z.unknown(),
    taskId: z.string().max(80).nullable(),
    snapshotIds: z.array(IdSchema).max(20),
  })
  .strict();

export const AccessAuditEntrySchema = z
  .object({
    log: z.literal("access"),
    id: z.string().max(80),
    at: IsoDateTimeSchema,
    actor: ActorSchema,
    action: z.enum(["read", "export", "update", "delete", "share"]),
    purpose: z.string().max(120),
    /** Names of the fields touched, never their values. */
    fields: z.array(z.string().max(80)).max(50),
    subjectKey: z.string().max(120),
    requestId: z.string().max(100).nullable(),
  })
  .strict();

export const AuditLogEntrySchema = z.discriminatedUnion("log", [RegistryAuditEntrySchema, AccessAuditEntrySchema]);
export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;

// ---------------------------------------------------------------------------------------------
// ReviewTasks and their reason codes (one casing everywhere).
// ---------------------------------------------------------------------------------------------

export const REVIEW_REASON_CODES = [
  // cycle_update
  "key_change",
  "quote_missing",
  "urgent_recheck",
  "pdf_changed",
  "close_unconfirmed",
  "value_changed",
  "key_change_pending_draft",
  // reconfirm
  "deadline_audit",
  // evidence and documents
  "page_changed",
  "extraction_change",
  "evidence_changed",
  "ocr_disagreement",
  "hidden_text_suspect",
  "no_text_layer",
  "parse_failed",
  // imports
  "list_row",
  "pre_fetcher_entry",
  "slug_collision",
  // extraction_failed
  "max_tokens",
  "schema_invalid",
  "budget_deferred",
  "killed",
  "policy_blocked",
  "error",
  // outcomes.quality (outcome_anomaly and cycle_update tasks)
  "outcome_over_count",
  "outcome_flagged",
  "outcome_decision_week",
] as const;
/** Reason codes, plus parameterised forms such as `refused:{category}` and `draft_unavailable:{code}`. */
export const ReviewReasonCodeSchema = z.union([
  z.enum(REVIEW_REASON_CODES),
  z.string().regex(/^(refused|draft_unavailable):[a-z_]{1,40}$/),
]);
export type ReviewReasonCode = z.infer<typeof ReviewReasonCodeSchema>;

export const ReviewTaskSchema = z
  .object({
    id: IdSchema,
    kind: ReviewTaskKindSchema,
    subject: z.object({ type: EvidenceEntitySchema, id: IdSchema }).strict(),
    /** `{kind}:{subjectType}:{subjectId}`, unique among live tasks. */
    dedupeKey: z.string().max(200),
    reasonCodes: z.array(ReviewReasonCodeSchema).max(20),
    evidenceIds: z.array(IdSchema).max(50),
    priority: z.number().int().min(0).max(9),
    state: ReviewTaskStateSchema,
    dueAt: IsoDateTimeSchema.nullable(),
    claimedBy: CuratorHandleSchema.nullable(),
    claimExpiresAt: IsoDateTimeSchema.nullable(),
    payload: z.record(z.unknown()),
    resolution: z.string().max(500).nullable(),
    activeSeconds: z.number().int().nonnegative(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type ReviewTask = z.infer<typeof ReviewTaskSchema>;

export const CreateReviewTaskInputSchema = z
  .object({
    kind: ReviewTaskKindSchema,
    subject: z.object({ type: EvidenceEntitySchema, id: IdSchema }).strict(),
    reasonCodes: z.array(ReviewReasonCodeSchema).min(1).max(20),
    evidence: z.array(IdSchema).max(50).default([]),
    priority: z.number().int().min(0).max(9).default(5),
    dueAt: IsoDateTimeSchema.nullable().default(null),
  })
  .strict();
export type CreateReviewTaskInput = z.infer<typeof CreateReviewTaskInputSchema>;

export const ReviewTaskResolveSchema = z
  .object({
    decision: z.enum(["approve", "reject", "snooze", "escalate"]),
    resolution: z.string().max(500),
    /** Version of the subject the Curator reviewed (guards the publish batch). */
    subjectVersion: z.number().int().min(1).nullable(),
  })
  .strict();
export type ReviewTaskResolve = z.infer<typeof ReviewTaskResolveSchema>;
