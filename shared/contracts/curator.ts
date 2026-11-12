import { z } from "zod";
import { ReviewTaskResolveSchema, ReviewTaskSchema } from "./ops";
import { IdSchema, IsoDateSchema, IsoDateTimeSchema, PageInfoSchema, PublishedDateSchema, TimeZoneSchema } from "./common";
import { CycleStatusSchema, DeadlineKindSchema, REVIEW_TASK_KINDS } from "../taxonomy";

/**
 * Request and response shapes of the Curator API (server/api/v1/curator; console v0 in
 * client/src/console). They live in shared/contracts so the route map can reference them without
 * importing server code; server/api/v1/curator/schemas.ts re-exports them. Each request schema
 * is a strict SUPERSET of the original route-map schema (every contract-valid body is accepted
 * unchanged); the extra fields are what console v0 needs (edits, reject reason codes, snooze
 * dates, the console timer).
 */

// ---------------------------------------------------------------------------------------------
// Queue listing
// ---------------------------------------------------------------------------------------------

export const QUEUE_VIEWS = ["queue", "mine", "second_review", "escalated", "snoozed"] as const;
export type QueueView = (typeof QUEUE_VIEWS)[number];

export const QueueQuerySchema = z
  .object({
    cursor: z.string().regex(/^o:\d{1,5}$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    view: z.enum(QUEUE_VIEWS).default("queue"),
    kind: z.enum(REVIEW_TASK_KINDS).optional(),
  })
  .strict();
export type QueueQuery = z.infer<typeof QueueQuerySchema>;

/** Display context per task, so the queue can name the program without one request per row. */
export const TaskContextSchema = z
  .object({
    programName: z.string().nullable(),
    programSlug: z.string().nullable(),
    termLabel: z.string().nullable(),
    isSample: z.boolean(),
    severity: z.number().min(0).max(1),
    overdue: z.boolean(),
    secondReviewOf: z.string().nullable(),
  })
  .strict();
export type TaskContext = z.infer<typeof TaskContextSchema>;

export const QueueResponseSchema = z
  .object({
    items: z.array(ReviewTaskSchema),
    page: PageInfoSchema,
    context: z.record(TaskContextSchema),
    viewer: z.object({ handle: z.string(), roles: z.array(z.string()) }).strict(),
  })
  .strict();
export type QueueResponse = z.infer<typeof QueueResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Evidence attached to an edit
// ---------------------------------------------------------------------------------------------

export const EvidenceEditSchema = z
  .object({
    /** Required for basis `snapshot`; the quote is checked against that Snapshot's stored text. */
    snapshotId: IdSchema.nullable().default(null),
    url: z.string().url().max(2000),
    /** Verbatim from the official page. */
    quote: z.string().trim().min(1).max(1000),
    basis: z.enum(["snapshot", "manual_note"]).default("snapshot"),
    /** For PDFs: the page the quote is on (`#page=N` on the official link). */
    page: z.number().int().min(1).max(5000).nullable().default(null),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.basis === "snapshot" && e.snapshotId === null) ctx.addIssue({ code: "custom", path: ["snapshotId"], message: "snapshot evidence names its Snapshot" });
    if (e.basis !== "snapshot" && e.snapshotId !== null) ctx.addIssue({ code: "custom", path: ["snapshotId"], message: "only snapshot evidence names a Snapshot" });
  });
export type EvidenceEdit = z.infer<typeof EvidenceEditSchema>;

// ---------------------------------------------------------------------------------------------
// Edits a Curator approves
// ---------------------------------------------------------------------------------------------

const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const DeadlineEditSchema = z
  .object({
    kind: DeadlineKindSchema,
    scope: z.enum(["national", "campus"]).default("national"),
    institutionId: IdSchema.nullable().default(null),
    roundLabel: z.string().max(60).default(""),
    basis: z.enum(["official", "attested"]).default("official"),
    precision: z.enum(["exact", "date_only", "month_only", "rolling", "tbd"]),
    tzMode: z.enum(["fixed", "applicant_local"]).default("fixed"),
    localDate: PublishedDateSchema.nullable().default(null),
    localTime: LocalTime.nullable().default(null),
    timeZone: TimeZoneSchema.nullable().default(null),
    tzSource: z.enum(["stated", "org_default"]).nullable().default("stated"),
  })
  .strict();
export type DeadlineEdit = z.infer<typeof DeadlineEditSchema>;

export const DeadlineOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("upsert"), deadline: DeadlineEditSchema, evidence: EvidenceEditSchema }).strict(),
  z.object({ op: z.literal("withdraw"), deadlineId: IdSchema, evidence: EvidenceEditSchema.nullable().default(null) }).strict(),
]);
export type DeadlineOp = z.infer<typeof DeadlineOpSchema>;

export const CYCLE_EDIT_FIELDS = ["status", "applicationUrl", "applicationFeeCents", "opensOn"] as const;
export type CycleEditField = (typeof CYCLE_EDIT_FIELDS)[number];

export const CycleEditSchema = z
  .object({
    status: CycleStatusSchema.optional(),
    applicationUrl: z.string().url().max(2000).nullable().optional(),
    applicationFeeCents: z.number().int().min(0).max(1_000_000).nullable().optional(),
    opensOn: IsoDateSchema.nullable().optional(),
  })
  .strict();
export type CycleEdit = z.infer<typeof CycleEditSchema>;

export const EditsSchema = z
  .object({
    /** Needed when the task's subject is a program rather than a cycle. */
    cycleId: IdSchema.optional(),
    cycle: CycleEditSchema.default({}),
    /** One evidence entry per changed cycle field (keyed by field name). */
    cycleEvidence: z.record(z.enum(CYCLE_EDIT_FIELDS), EvidenceEditSchema).default({}),
    deadlines: z.array(DeadlineOpSchema).max(20).default([]),
    /** Approval is also the human attestation "verified as of now" (writes last_verified_at). */
    verify: z.boolean().default(true),
  })
  .strict();
export type Edits = z.infer<typeof EditsSchema>;

// ---------------------------------------------------------------------------------------------
// Resolve: the contract body plus console fields
// ---------------------------------------------------------------------------------------------

/** Reject needs one of these (plan 01 F-16: "R reject (a reason code is required)"). */
export const REJECT_REASONS = [
  "no_material_change",
  "not_official_source",
  "quote_not_found",
  "duplicate",
  "out_of_scope",
  "source_unreachable",
  "other",
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const CuratorResolveSchema = ReviewTaskResolveSchema.extend({
  resolution: z.string().max(500).default(""),
  edits: EditsSchema.optional(),
  rejectReason: z.enum(REJECT_REASONS).optional(),
  /** Snooze: when the task comes back (required with a reason, runbook 14.4). */
  snoozeUntil: IsoDateTimeSchema.optional(),
  /** Seconds the console timer counted while the task was in view. */
  activeSeconds: z.number().int().min(0).max(3600).default(0),
})
  .strict()
  .superRefine((b, ctx) => {
    if (b.decision === "reject" && !b.rejectReason) ctx.addIssue({ code: "custom", path: ["rejectReason"], message: "reject needs a reason code" });
    if (b.decision === "reject" && b.rejectReason === "other" && b.resolution.trim().length < 5) {
      ctx.addIssue({ code: "custom", path: ["resolution"], message: "say why when the reason is other" });
    }
    if (b.decision === "snooze" && !b.snoozeUntil) ctx.addIssue({ code: "custom", path: ["snoozeUntil"], message: "snooze needs a date" });
    if (b.decision === "snooze" && b.resolution.trim().length < 3) ctx.addIssue({ code: "custom", path: ["resolution"], message: "snooze needs a reason" });
    if (b.decision === "escalate" && b.resolution.trim().length < 3) ctx.addIssue({ code: "custom", path: ["resolution"], message: "escalation needs a note" });
    if (b.decision !== "approve" && b.edits) ctx.addIssue({ code: "custom", path: ["edits"], message: "edits go with approve only" });
  });
export type CuratorResolve = z.infer<typeof CuratorResolveSchema>;

export const RecheckSchema = z
  .object({
    /** Priority 1 jumps the fetch queue (plan 4.10: urgent_recheck within 4 hours). */
    urgent: z.boolean().default(false),
    note: z.string().max(300).default(""),
  })
  .strict();

export const OfficialOpenedSchema = z
  .object({
    /** Which link was opened: a Snapshot's final URL, the program's official URL or a PDF page. */
    snapshotId: IdSchema.nullable().default(null),
    page: z.number().int().min(1).max(5000).nullable().default(null),
  })
  .strict();

export const JobRetrySchema = z.object({}).strict();

export const RollbackSchema = z.object({ release: z.number().int().nonnegative() }).strict();
