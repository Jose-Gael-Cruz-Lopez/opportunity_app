import { z } from "zod";
import {
  ClassYearSchema,
  CycleStatusSchema,
  DeadlineScopeSchema,
  MajorFamilySchema,
  OpportunityCategorySchema,
  OpportunityTypeSlugSchema,
} from "../taxonomy";
import { CursorQuerySchema, IdSchema, IsoDateSchema, IsoDateTimeSchema, paginated, SlugSchema } from "./common";
import { InstitutionSchema, ProgramCardSchema } from "./registry";

/** Query and response shapes for the public registry REST API. */

/** Repeated query params arrive as a string or a string array; normalise to an array. */
const listParam = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => (v === undefined ? undefined : Array.isArray(v) ? v : String(v).split(",")), z.array(item).max(40)).optional();

export const ProgramListQuerySchema = CursorQuerySchema.extend({
  q: z.string().max(200).optional(),
  type: listParam(OpportunityTypeSlugSchema),
  category: listParam(OpportunityCategorySchema),
  classYear: listParam(ClassYearSchema),
  majorFamily: listParam(MajorFamilySchema),
  status: listParam(CycleStatusSchema),
  deadlineAfter: IsoDateSchema.optional(),
  deadlineBefore: IsoDateSchema.optional(),
  openToCommunityCollege: z.enum(["true", "false"]).optional(),
}).strict();
export type ProgramListQuery = z.infer<typeof ProgramListQuerySchema>;

export const ProgramListResponseSchema = paginated(ProgramCardSchema).extend({ release: z.number().int().nonnegative() }).strict();
export type ProgramListResponse = z.infer<typeof ProgramListResponseSchema>;

export const DeadlineListQuerySchema = CursorQuerySchema.extend({
  withinDays: z.coerce.number().int().min(1).max(365).default(30),
  scope: DeadlineScopeSchema.optional(),
  type: listParam(OpportunityTypeSlugSchema),
  classYear: listParam(ClassYearSchema),
}).strict();
export type DeadlineListQuery = z.infer<typeof DeadlineListQuerySchema>;

export const DeadlineListItemSchema = z
  .object({
    deadlineId: IdSchema.nullable(),
    programSlug: SlugSchema,
    programName: z.string().max(200),
    cycleKey: z.string().max(20),
    kind: z.string().max(40),
    basis: z.enum(["official", "attested", "predicted", "estimated"]),
    localDate: z.string().max(10).nullable(),
    localTime: z.string().max(8).nullable(),
    timeZone: z.string().max(64).nullable(),
    applicantLocal: z.boolean(),
    sortAt: IsoDateTimeSchema.nullable(),
    nominationRequired: z.boolean(),
  })
  .strict();
export type DeadlineListItem = z.infer<typeof DeadlineListItemSchema>;
export const DeadlineListResponseSchema = paginated(DeadlineListItemSchema);

export const OpportunityTypeListResponseSchema = z
  .object({
    items: z.array(
      z
        .object({
          slug: OpportunityTypeSlugSchema,
          ordinal: z.number().int(),
          label: z.string(),
          group: z.string(),
          inScope: z.boolean(),
          programCount: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();

export const InstitutionSearchQuerySchema = CursorQuerySchema.extend({ q: z.string().min(2).max(120) }).strict();
export const InstitutionSearchResponseSchema = paginated(
  InstitutionSchema.pick({ id: true, name: true, level: true, state: true, calendar: true }),
);

export const SearchRequestSchema = z
  .object({
    query: z.string().min(1).max(200),
    filters: z
      .object({
        types: z.array(OpportunityTypeSlugSchema).max(33).optional(),
        classYears: z.array(ClassYearSchema).max(8).optional(),
        majorFamilies: z.array(MajorFamilySchema).max(16).optional(),
        statuses: z.array(CycleStatusSchema).max(6).optional(),
      })
      .strict()
      .default({}),
    limit: z.number().int().min(1).max(25).default(10),
    cursor: z.string().max(512).optional(),
  })
  .strict();
export type SearchRequest = z.infer<typeof SearchRequestSchema>;

export const SearchHitSchema = z
  .object({
    card: ProgramCardSchema,
    /** Integer rank key and why-shown codes only; no relevance or match number. */
    rank: z.number().int().nonnegative(),
    whyShown: z.array(z.string().max(60)).max(6),
    matchedTerms: z.array(z.string().max(60)).max(10),
  })
  .strict();
export type SearchHit = z.infer<typeof SearchHitSchema>;
export const SearchResponseSchema = paginated(SearchHitSchema).extend({ release: z.number().int().nonnegative() }).strict();
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const ErrorReportRequestSchema = z
  .object({
    field: z.enum(["deadline", "eligibility", "status", "link", "requirements", "other"]),
    note: z.string().max(280),
    turnstileToken: z.string().min(1).max(4096),
  })
  .strict();
export type ErrorReportRequest = z.infer<typeof ErrorReportRequestSchema>;

/**
 * Client crash reports (POST /api/v1/error-reports, plan s02 2.3.12, S02-074): the shape of a
 * crash, never its content. A report carries the error class, the route template, the release,
 * a browser family and the first-party file and line. It has no message text, no stack, no URL,
 * no query string and no identifier; the server stores day counters only. Not the program-page
 * "Report an error" form (ErrorReportRequestSchema above).
 */
export const ERROR_KINDS = ["error", "unhandledrejection", "boundary", "island"] as const;
export const ERROR_SURFACES = ["spa", "island", "console"] as const;
export const BROWSER_FAMILIES = ["chrome", "safari", "firefox", "edge", "samsung", "in_app", "other"] as const;

/** `TypeError`, `ChunkLoadError`, `DOMException.AbortError`; never a message. */
const CLIENT_ERROR_CLASS = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/;
/** Build ids and versions: `2026.11.11-ab12cd3`, `dev`. */
const CLIENT_RELEASE = /^[0-9A-Za-z._-]{1,40}$/;
/** A first-party bundle file name only (`index-BX12ab.js`), never a path or URL. */
const CLIENT_FILE = /^[A-Za-z0-9._-]{1,80}\.m?js$/;

export const ClientErrorReportSchema = z
  .object({
    kind: z.enum(ERROR_KINDS),
    surface: z.enum(ERROR_SURFACES),
    errorClass: z.string().regex(CLIENT_ERROR_CLASS),
    route: z.string().max(120),
    release: z.string().regex(CLIENT_RELEASE),
    browser: z.enum(BROWSER_FAMILIES),
    file: z.string().regex(CLIENT_FILE).nullable(),
    line: z.number().int().min(0).max(10_000_000).nullable(),
    column: z.number().int().min(0).max(10_000_000).nullable(),
  })
  .strict();
export type ClientErrorReport = z.infer<typeof ClientErrorReportSchema>;

/** At most 5 reports per request; the client caps per page and per session too. */
export const ClientErrorBatchSchema = z.object({ reports: z.array(ClientErrorReportSchema).min(1).max(5) }).strict();
export type ClientErrorBatch = z.infer<typeof ClientErrorBatchSchema>;


/** Allowlisted client analytics events; properties never name a sensitive- or identity-audience program. */
export const ANALYTICS_EVENT_NAMES = [
  "page_view",
  "program_view",
  "apply_click",
  "remind_me_submit",
  "tracker_add",
  "onboarding_step",
  "search",
  "filter_change",
  "readiness_open",
  "ai_explain_open",
] as const;
export const AnalyticsEventSchema = z
  .object({
    name: z.enum(ANALYTICS_EVENT_NAMES),
    deviceId: z.string().regex(/^[0-9A-Za-z_-]{16,64}$/),
    at: IsoDateTimeSchema,
    path: z.string().max(300),
    props: z.record(z.union([z.string().max(120), z.number(), z.boolean()])).default({}),
  })
  .strict();
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;
export const AnalyticsBatchSchema = z.object({ events: z.array(AnalyticsEventSchema).min(1).max(50) }).strict();
