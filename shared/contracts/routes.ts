import { z } from "zod";
import {
  AnalyticsBatchSchema,
  ClientErrorBatchSchema,
  DeadlineListQuerySchema,
  DeadlineListResponseSchema,
  ErrorReportRequestSchema,
  InstitutionSearchQuerySchema,
  InstitutionSearchResponseSchema,
  OpportunityTypeListResponseSchema,
  ProgramListQuerySchema,
  ProgramListResponseSchema,
  SearchRequestSchema,
  SearchResponseSchema,
} from "./api";
import {
  AskRequestSchema,
  AskResponseSchema,
  ReadinessExplainRequestSchema,
  ReadinessExplainResponseSchema,
  StatementFeedbackRequestSchema,
  StatementFeedbackResponseSchema,
} from "./ai";
import {
  AdvisorWorkspaceSchema,
  CampusDeadlineSubmissionSchema,
  OutcomeReportCreateSchema,
  OutcomeReportSchema,
  OutcomeReportUpdateSchema,
  ProgramListCreateSchema,
  ProgramListSchema,
  ProgramListUpdateSchema,
  WorkspaceReportSchema,
} from "./advisor";
import { CursorQuerySchema, paginated } from "./common";
import { CuratorResolveSchema, JobRetrySchema, OfficialOpenedSchema, QueueQuerySchema, QueueResponseSchema, RecheckSchema } from "./curator";
import { EligibilityCheckRequestSchema, EligibilityCheckResponseSchema } from "./eligibility";
import { InboxItemSchema, NotificationPrefsSchema } from "./events";
import {
  CurationPatchResultSchema,
  CurationPatchSchema,
  ExtractionIngestSchema,
  HeartbeatSchema,
  SnapshotIngestResultSchema,
  SnapshotIngestSchema,
} from "./internal";
import {
  CreateReviewTaskInputSchema,
  JobCompleteSchema,
  JobFailSchema,
  JobLeaseRequestSchema,
  JobLeaseResponseSchema,
  ReviewTaskSchema,
} from "./ops";
import { ReadinessResponseSchema } from "./readiness";
import { OutcomeSummarySchema } from "../readiness/outcomes/summary-contract";
import { ProgramDetailSchema, ReleasePointerSchema } from "./registry";
import { RoadmapItemActionSchema, RoadmapSchema } from "./roadmap";
import {
  ConsentChangeSchema,
  ConsentRecordSchema,
  MeSessionResponseSchema,
  RemindMeRequestSchema,
  RequirementProgressSchema,
  RequirementProgressUpdateSchema,
  StudentProfileSchema,
  StudentProfileUpdateSchema,
  TrackerItemCreateSchema,
  TrackerItemSchema,
  TrackerItemUpdateSchema,
} from "./student";

/**
 * Route map for phases 0-2. Handlers register only through this map, so paths, auth classes and
 * schemas stay in one place. Paths use Hono syntax (`:param`, `:param{regex}`, `*`); action routes
 * use a trailing segment (`/review-tasks/:id/claim`) because Hono cannot split `:id:claim`.
 */

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "ALL";

/** Which router in server/app.ts owns the route. */
export type RouteMount = "pages" | "spa" | "registry" | "student" | "advisor" | "auth" | "cal" | "internal" | "mcp";

export const MOUNT_BASES: Record<RouteMount, string> = {
  pages: "",
  spa: "",
  registry: "/api/v1",
  student: "/api/v1",
  advisor: "/api/v1",
  auth: "/api/auth",
  cal: "/cal",
  internal: "/internal/v1",
  mcp: "/mcp",
};

/**
 * public: anyone. turnstile: anyone with a Turnstile token. student/advisor/curator/admin: a
 * session with that role. internal: HMAC-signed pipeline call. token: a capability token in the
 * path (calendar feeds, email links, unlisted lists). mcp: public data over MCP.
 */
export type AuthClass = "public" | "turnstile" | "student" | "advisor" | "curator" | "admin" | "internal" | "token" | "mcp";

export type Phase = 0 | 1 | 2;

export interface RouteDef {
  readonly method: HttpMethod;
  /** Full path including the mount base. */
  readonly path: string;
  readonly mount: RouteMount;
  readonly phase: Phase;
  readonly auth: AuthClass;
  readonly summary: string;
  readonly query?: z.ZodTypeAny;
  readonly body?: z.ZodTypeAny;
  readonly response?: z.ZodTypeAny;
  /** Cache-Control for GETs, when it differs from `no-store`. */
  readonly cache?: string;
}

const r = <const T extends RouteDef>(def: T): T => def;
const empty = z.object({}).strict();

export const ROUTES = {
  // ---- Public pages (Hono JSX) -------------------------------------------------------------
  home: r({ method: "GET", path: "/", mount: "pages", phase: 0, auth: "public", summary: "Explore page", cache: "public, max-age=60" }),
  programPage: r({ method: "GET", path: "/programs/:slug", mount: "pages", phase: 0, auth: "public", summary: "Program page", cache: "public, max-age=60" }),
  programsIndex: r({ method: "GET", path: "/programs", mount: "pages", phase: 0, auth: "public", summary: "301 to /" }),
  deadlinesPage: r({ method: "GET", path: "/deadlines", mount: "pages", phase: 0, auth: "public", summary: "Upcoming deadlines", cache: "public, max-age=60" }),
  methodsPage: r({ method: "GET", path: "/methods", mount: "pages", phase: 0, auth: "public", summary: "How Novus verifies records" }),
  botPage: r({ method: "GET", path: "/bot", mount: "pages", phase: 0, auth: "public", summary: "NovusBot contact page" }),
  sitemap: r({ method: "GET", path: "/sitemap.xml", mount: "pages", phase: 0, auth: "public", summary: "Sitemap" }),
  robots: r({ method: "GET", path: "/robots.txt", mount: "pages", phase: 0, auth: "public", summary: "robots.txt" }),
  llmsTxt: r({ method: "GET", path: "/llms.txt", mount: "pages", phase: 0, auth: "public", summary: "llms.txt" }),
  securityTxt: r({ method: "GET", path: "/.well-known/security.txt", mount: "pages", phase: 0, auth: "public", summary: "security.txt" }),
  orgPage: r({ method: "GET", path: "/orgs/:slug", mount: "pages", phase: 1, auth: "public", summary: "Organization page" }),
  typePage: r({ method: "GET", path: "/types/:type", mount: "pages", phase: 1, auth: "public", summary: "Opportunity type page" }),
  pledgePage: r({ method: "GET", path: "/pledge", mount: "pages", phase: 1, auth: "public", summary: "Data pledge" }),
  listPage: r({ method: "GET", path: "/lists/:slug", mount: "pages", phase: 2, auth: "public", summary: "Public advisor list" }),
  auditPage: r({ method: "GET", path: "/research/ai-deadline-audit", mount: "pages", phase: 2, auth: "public", summary: "AI deadline-accuracy audit" }),
  auditRedirect: r({ method: "GET", path: "/audit", mount: "pages", phase: 2, auth: "public", summary: "301 to the audit" }),

  // ---- Data, cards, redirects and email links (served by the pages router) ------------------
  releasePointer: r({ method: "GET", path: "/data/release.json", mount: "pages", phase: 0, auth: "public", summary: "Current release pointer", response: ReleasePointerSchema, cache: "public, max-age=60" }),
  clientCore: r({ method: "GET", path: "/data/client-core/:file{[0-9]+\\.json}", mount: "pages", phase: 0, auth: "public", summary: "Immutable release artifact ({n}.json)", cache: "public, max-age=31536000, immutable" }),
  card: r({ method: "GET", path: "/cards/:programCycleId/:hash/:format", mount: "pages", phase: 1, auth: "public", summary: "Share card image", cache: "public, max-age=31536000, immutable" }),
  applyOut: r({ method: "GET", path: "/out/:programCycleId", mount: "pages", phase: 0, auth: "public", summary: "Apply click redirect to the official application" }),
  shortLink: r({ method: "GET", path: "/go/:slug", mount: "pages", phase: 1, auth: "public", summary: "Campaign short link" }),
  referral: r({ method: "GET", path: "/r/:code", mount: "pages", phase: 1, auth: "public", summary: "Attribution code redirect" }),
  emailClick: r({ method: "GET", path: "/e/c/:token", mount: "pages", phase: 1, auth: "token", summary: "Tracked email click" }),
  emailActionView: r({ method: "GET", path: "/e/a/:token", mount: "pages", phase: 1, auth: "token", summary: "Confirm an email action" }),
  emailActionConfirm: r({ method: "POST", path: "/e/a/:token", mount: "pages", phase: 1, auth: "token", summary: "Apply an email action" }),
  emailUnsubscribe: r({ method: "POST", path: "/e/u/:token", mount: "pages", phase: 1, auth: "token", summary: "RFC 8058 one-click unsubscribe" }),
  remindConfirmView: r({ method: "GET", path: "/e/rc/:token", mount: "pages", phase: 0, auth: "token", summary: "Remind me: confirmation page (changes nothing)" }),
  remindConfirm: r({ method: "POST", path: "/e/rc/:token", mount: "pages", phase: 0, auth: "token", summary: "Remind me: confirm the address (same-origin form)" }),

  // ---- SPA shell (served from ASSETS with no-store) -----------------------------------------
  spa: r({ method: "GET", path: "/app/*", mount: "spa", phase: 1, auth: "public", summary: "SPA shell for /app, /app/onboarding, /app/tracker, /app/explore, /app/roadmap, /app/settings/*, /app/advisor/*" }),

  // ---- Calendar ------------------------------------------------------------------------------
  programCalendar: r({ method: "GET", path: "/cal/p/:file{[a-z0-9-]+\\.ics}", mount: "cal", phase: 1, auth: "public", summary: "Program deadlines ICS ({slug}.ics)", cache: "public, max-age=3600" }),
  userCalendar: r({ method: "GET", path: "/cal/u/:file{[A-Za-z0-9_-]+\\.ics}", mount: "cal", phase: 1, auth: "token", summary: "Private tracker ICS ({token}.ics)", cache: "private, no-cache" }),

  // ---- Public REST (registry) -----------------------------------------------------------------
  listPrograms: r({ method: "GET", path: "/api/v1/programs", mount: "registry", phase: 0, auth: "public", summary: "Program cards", query: ProgramListQuerySchema, response: ProgramListResponseSchema }),
  getProgram: r({ method: "GET", path: "/api/v1/programs/:slug", mount: "registry", phase: 0, auth: "public", summary: "Program detail (lazy)", response: ProgramDetailSchema }),
  listDeadlines: r({ method: "GET", path: "/api/v1/deadlines", mount: "registry", phase: 0, auth: "public", summary: "Upcoming deadlines", query: DeadlineListQuerySchema, response: DeadlineListResponseSchema }),
  listOpportunityTypes: r({ method: "GET", path: "/api/v1/opportunity-types", mount: "registry", phase: 0, auth: "public", summary: "Opportunity types with counts", response: OpportunityTypeListResponseSchema }),
  searchInstitutions: r({ method: "GET", path: "/api/v1/institutions", mount: "registry", phase: 1, auth: "public", summary: "Institution lookup", query: InstitutionSearchQuerySchema, response: InstitutionSearchResponseSchema }),
  turnstileConfig: r({ method: "GET", path: "/api/v1/turnstile", mount: "registry", phase: 0, auth: "public", summary: "Turnstile widget config (?action=send-code|remind-me|error-report)", response: z.object({ enabled: z.boolean(), siteKey: z.string().nullable(), header: z.string(), action: z.enum(["send-code", "remind-me", "error-report"]) }).strict() }),
  remindMe: r({ method: "POST", path: "/api/v1/remind-me", mount: "registry", phase: 0, auth: "turnstile", summary: "Email-only deadline reminder", body: RemindMeRequestSchema, response: z.object({ status: z.enum(["pending_confirmation", "confirmed"]) }).strict() }),
  postEvents: r({ method: "POST", path: "/api/v1/events", mount: "registry", phase: 1, auth: "public", summary: "Allowlisted analytics events", body: AnalyticsBatchSchema, response: z.object({ accepted: z.number().int() }).strict() }),
  clientErrors: r({ method: "POST", path: "/api/v1/error-reports", mount: "registry", phase: 1, auth: "public", summary: "Client crash reports (shape only, stored as day counters)", body: ClientErrorBatchSchema, response: z.object({ received: z.number().int().nonnegative() }).strict() }),
  checkEligibility: r({ method: "POST", path: "/api/v1/eligibility/check", mount: "registry", phase: 1, auth: "public", summary: "Non-sensitive eligibility check", body: EligibilityCheckRequestSchema, response: EligibilityCheckResponseSchema }),
  reportError: r({ method: "POST", path: "/api/v1/programs/:slug/error-reports", mount: "registry", phase: 1, auth: "turnstile", summary: "Report an error on a program", body: ErrorReportRequestSchema, response: z.object({ received: z.literal(true) }).strict() }),
  search: r({ method: "POST", path: "/api/v1/search", mount: "registry", phase: 2, auth: "public", summary: "Program search (same index as the browser)", body: SearchRequestSchema, response: SearchResponseSchema }),
  outcomeSummary: r({ method: "GET", path: "/api/v1/programs/:slug/outcomes/summary", mount: "registry", phase: 2, auth: "public", summary: "Disclosure-safe outcome summary", response: OutcomeSummarySchema }),

  // ---- Staff (curators and admins; hosted by the registry router) ----------------------------
  listReviewTasks: r({ method: "GET", path: "/api/v1/review-tasks", mount: "registry", phase: 1, auth: "curator", summary: "Review queue", query: QueueQuerySchema, response: QueueResponseSchema }),
  getReviewTask: r({ method: "GET", path: "/api/v1/review-tasks/:id", mount: "registry", phase: 1, auth: "curator", summary: "Task detail with evidence" }),
  claimReviewTask: r({ method: "POST", path: "/api/v1/review-tasks/:id/claim", mount: "registry", phase: 1, auth: "curator", summary: "Claim a task (15-minute lease)", body: empty, response: ReviewTaskSchema }),
  resolveReviewTask: r({ method: "POST", path: "/api/v1/review-tasks/:id/resolve", mount: "registry", phase: 1, auth: "curator", summary: "Approve, reject, snooze or escalate", body: CuratorResolveSchema, response: ReviewTaskSchema.passthrough() }),
  releaseReviewTask: r({ method: "POST", path: "/api/v1/review-tasks/:id/release", mount: "registry", phase: 1, auth: "curator", summary: "Release a claimed task", body: empty, response: ReviewTaskSchema }),
  recheckReviewTask: r({ method: "POST", path: "/api/v1/review-tasks/:id/recheck", mount: "registry", phase: 1, auth: "curator", summary: "Ask the pipeline to re-fetch the task's sources", body: RecheckSchema, response: z.object({ requested: z.literal(true), jobsCreated: z.number().int().nonnegative() }).strict() }),
  reviewTaskOfficialOpened: r({ method: "POST", path: "/api/v1/review-tasks/:id/official-opened", mount: "registry", phase: 1, auth: "curator", summary: "Log that the Curator opened the official source", body: OfficialOpenedSchema }),
  opsPipeline: r({ method: "GET", path: "/api/v1/ops/pipeline", mount: "registry", phase: 1, auth: "curator", summary: "Pipeline health" }),
  retryJob: r({ method: "POST", path: "/api/v1/ops/jobs/:id/retry", mount: "registry", phase: 1, auth: "curator", summary: "Retry a dead or stuck job", body: JobRetrySchema, response: z.object({ id: z.string(), status: z.string() }).strict() }),
  curatorImport: r({ method: "POST", path: "/api/v1/curator/import", mount: "registry", phase: 0, auth: "curator", summary: "Import researcher candidates as unpublished draft programs" }),
  adminMetrics: r({ method: "GET", path: "/api/v1/admin/metrics", mount: "registry", phase: 1, auth: "admin", summary: "Founders' metrics: aggregates, counts under 5 hidden" }),
  releaseRollback: r({ method: "POST", path: "/api/v1/registry/release/rollback", mount: "registry", phase: 1, auth: "admin", summary: "Point the release pointer at an earlier artifact", body: z.object({ release: z.number().int().nonnegative() }).strict(), response: ReleasePointerSchema }),

  // ---- Auth (Better Auth handler) ---------------------------------------------------------------
  auth: r({ method: "ALL", path: "/api/auth/*", mount: "auth", phase: 1, auth: "public", summary: "Better Auth endpoints (email code sign-in, session)" }),

  // ---- Student REST ---------------------------------------------------------------------------
  meSession: r({ method: "GET", path: "/api/v1/me/session", mount: "student", phase: 1, auth: "public", summary: "Current session and profile (user null when signed out)", response: MeSessionResponseSchema }),
  getProfile: r({ method: "GET", path: "/api/v1/me/profile", mount: "student", phase: 1, auth: "student", summary: "Non-sensitive profile", response: StudentProfileSchema }),
  updateProfile: r({ method: "PATCH", path: "/api/v1/me/profile", mount: "student", phase: 1, auth: "student", summary: "Update profile (strict: status or identity keys answer 400)", body: StudentProfileUpdateSchema, response: StudentProfileSchema }),
  listTracker: r({ method: "GET", path: "/api/v1/me/tracker", mount: "student", phase: 1, auth: "student", summary: "Tracked cycles", response: z.object({ items: z.array(TrackerItemSchema) }).strict() }),
  addTracker: r({ method: "POST", path: "/api/v1/me/tracker", mount: "student", phase: 1, auth: "student", summary: "Track a cycle (409 consent_required for status- or identity-defined programs)", body: TrackerItemCreateSchema, response: TrackerItemSchema }),
  updateTracker: r({ method: "PATCH", path: "/api/v1/me/tracker/:id", mount: "student", phase: 1, auth: "student", summary: "Update a tracked cycle", body: TrackerItemUpdateSchema, response: TrackerItemSchema }),
  removeTracker: r({ method: "DELETE", path: "/api/v1/me/tracker/:id", mount: "student", phase: 1, auth: "student", summary: "Stop tracking" }),
  getNotificationPrefs: r({ method: "GET", path: "/api/v1/me/notification-prefs", mount: "student", phase: 1, auth: "student", summary: "Notification preferences", response: NotificationPrefsSchema }),
  putNotificationPrefs: r({ method: "PUT", path: "/api/v1/me/notification-prefs", mount: "student", phase: 1, auth: "student", summary: "Replace notification preferences", body: NotificationPrefsSchema, response: NotificationPrefsSchema }),
  rotateCalendarFeed: r({ method: "POST", path: "/api/v1/me/calendar-feed/rotate", mount: "student", phase: 1, auth: "student", summary: "Issue a new private calendar URL", body: empty, response: z.object({ url: z.string().url() }).strict() }),
  listConsents: r({ method: "GET", path: "/api/v1/me/consents", mount: "student", phase: 1, auth: "student", summary: "Consents", response: z.object({ items: z.array(ConsentRecordSchema) }).strict() }),
  changeConsent: r({ method: "POST", path: "/api/v1/me/consents", mount: "student", phase: 1, auth: "student", summary: "Grant or revoke a consent", body: ConsentChangeSchema, response: ConsentRecordSchema }),
  getReadiness: r({ method: "GET", path: "/api/v1/me/readiness/:programCycleId", mount: "student", phase: 1, auth: "student", summary: "Four-part readiness report (404 for status-defined programs)", response: ReadinessResponseSchema }),
  exportData: r({ method: "POST", path: "/api/v1/me/export", mount: "student", phase: 1, auth: "student", summary: "Request a data export", body: empty, response: z.object({ status: z.literal("queued") }).strict() }),
  deleteAccount: r({ method: "DELETE", path: "/api/v1/me", mount: "student", phase: 1, auth: "student", summary: "Delete the account and its data" }),
  inbox: r({ method: "GET", path: "/api/v1/me/activity", mount: "student", phase: 2, auth: "student", summary: "In-app notifications", query: CursorQuerySchema, response: paginated(InboxItemSchema) }),
  markInboxRead: r({ method: "POST", path: "/api/v1/me/activity/:id/read", mount: "student", phase: 2, auth: "student", summary: "Mark a notification read", body: empty }),
  listOutcomes: r({ method: "GET", path: "/api/v1/me/outcomes", mount: "student", phase: 2, auth: "student", summary: "My outcome reports", response: z.object({ items: z.array(OutcomeReportSchema) }).strict() }),
  createOutcome: r({ method: "POST", path: "/api/v1/me/outcomes", mount: "student", phase: 2, auth: "student", summary: "Report an outcome", body: OutcomeReportCreateSchema, response: OutcomeReportSchema }),
  updateOutcome: r({ method: "PATCH", path: "/api/v1/me/outcomes/:publicId", mount: "student", phase: 2, auth: "student", summary: "Update an outcome", body: OutcomeReportUpdateSchema, response: OutcomeReportSchema }),
  getRoadmap: r({ method: "GET", path: "/api/v1/me/roadmap", mount: "student", phase: 2, auth: "student", summary: "Term-by-term plan (computed on read)", response: RoadmapSchema }),
  updateRoadmapItem: r({ method: "PATCH", path: "/api/v1/me/roadmap/items/:itemKey", mount: "student", phase: 2, auth: "student", summary: "Pin, dismiss or complete a roadmap item", body: RoadmapItemActionSchema }),
  listRequirementProgress: r({ method: "GET", path: "/api/v1/me/requirement-progress", mount: "student", phase: 2, auth: "student", summary: "Checklist progress", response: z.object({ items: z.array(RequirementProgressSchema) }).strict() }),
  putRequirementProgress: r({ method: "PUT", path: "/api/v1/me/requirement-progress", mount: "student", phase: 2, auth: "student", summary: "Set checklist progress for one item", body: RequirementProgressUpdateSchema, response: RequirementProgressSchema }),

  // ---- AI assistant (Gemini through server/ai; degrades to deterministic text without a key) ---
  explainReadiness: r({ method: "POST", path: "/api/v1/me/readiness/:programCycleId/explain", mount: "student", phase: 2, auth: "student", summary: "Plain-language explanation of a readiness report, with citations", body: ReadinessExplainRequestSchema, response: ReadinessExplainResponseSchema }),
  statementFeedback: r({ method: "POST", path: "/api/v1/me/statement-feedback", mount: "student", phase: 2, auth: "student", summary: "Feedback on an essay or statement (no grade)", body: StatementFeedbackRequestSchema, response: StatementFeedbackResponseSchema }),
  ask: r({ method: "POST", path: "/api/v1/me/ask", mount: "student", phase: 2, auth: "student", summary: "Question answered from Novus records and official sources, with citations", body: AskRequestSchema, response: AskResponseSchema }),

  // ---- Advisor REST ---------------------------------------------------------------------------
  myWorkspaces: r({ method: "GET", path: "/api/v1/workspaces", mount: "advisor", phase: 2, auth: "advisor", summary: "Workspaces I belong to", response: z.object({ items: z.array(AdvisorWorkspaceSchema) }).strict() }),
  listWorkspaceLists: r({ method: "GET", path: "/api/v1/workspaces/:workspaceId/lists", mount: "advisor", phase: 2, auth: "advisor", summary: "Program lists in a workspace", response: z.object({ items: z.array(ProgramListSchema) }).strict() }),
  createWorkspaceList: r({ method: "POST", path: "/api/v1/workspaces/:workspaceId/lists", mount: "advisor", phase: 2, auth: "advisor", summary: "Create a program list", body: ProgramListCreateSchema, response: ProgramListSchema }),
  updateList: r({ method: "PATCH", path: "/api/v1/lists/:listId", mount: "advisor", phase: 2, auth: "advisor", summary: "Edit a program list", body: ProgramListUpdateSchema, response: ProgramListSchema }),
  submitCampusDeadline: r({ method: "POST", path: "/api/v1/workspaces/:workspaceId/campus-deadlines", mount: "advisor", phase: 2, auth: "advisor", summary: "Submit a campus deadline for Curator confirmation", body: CampusDeadlineSubmissionSchema, response: z.object({ status: z.literal("pending_review") }).strict() }),
  workspaceReport: r({ method: "GET", path: "/api/v1/workspaces/:workspaceId/reports/:period", mount: "advisor", phase: 2, auth: "advisor", summary: "Aggregate report (disclosure thresholds applied)", response: WorkspaceReportSchema }),

  // ---- MCP --------------------------------------------------------------------------------------
  mcp: r({ method: "ALL", path: "/mcp", mount: "mcp", phase: 2, auth: "mcp", summary: "MCP server over Streamable HTTP (public registry data only)" }),

  // ---- Internal (HMAC-signed pipeline calls) ---------------------------------------------------
  ingestCurationPatch: r({ method: "POST", path: "/internal/v1/curation-patches", mount: "internal", phase: 0, auth: "internal", summary: "Apply a Curator-verified patch", body: CurationPatchSchema, response: CurationPatchResultSchema }),
  ingestSnapshot: r({ method: "POST", path: "/internal/v1/snapshots", mount: "internal", phase: 0, auth: "internal", summary: "Store a fetched Snapshot (host policy enforced)", body: SnapshotIngestSchema, response: SnapshotIngestResultSchema }),
  leaseJobs: r({ method: "POST", path: "/internal/v1/jobs/lease", mount: "internal", phase: 1, auth: "internal", summary: "Lease pipeline jobs", body: JobLeaseRequestSchema, response: JobLeaseResponseSchema }),
  completeJob: r({ method: "POST", path: "/internal/v1/jobs/:id/complete", mount: "internal", phase: 1, auth: "internal", summary: "Complete a leased job", body: JobCompleteSchema }),
  failJob: r({ method: "POST", path: "/internal/v1/jobs/:id/fail", mount: "internal", phase: 1, auth: "internal", summary: "Fail, defer or kill a leased job", body: JobFailSchema }),
  tickCatchUp: r({ method: "POST", path: "/internal/v1/tick/catch-up", mount: "internal", phase: 1, auth: "internal", summary: "Run the tick if the last one is over 10 minutes old", body: empty }),
  ingestExtraction: r({ method: "POST", path: "/internal/v1/extractions", mount: "internal", phase: 1, auth: "internal", summary: "Attach an extraction draft to a review task", body: ExtractionIngestSchema }),
  createReviewTask: r({ method: "POST", path: "/internal/v1/review-tasks", mount: "internal", phase: 1, auth: "internal", summary: "Create or merge a review task", body: CreateReviewTaskInputSchema, response: ReviewTaskSchema }),
  heartbeat: r({ method: "POST", path: "/internal/v1/heartbeats", mount: "internal", phase: 1, auth: "internal", summary: "Pipeline worker heartbeat", body: HeartbeatSchema }),
  llmCalls: r({ method: "POST", path: "/internal/v1/llm-calls", mount: "internal", phase: 2, auth: "internal", summary: "Record an LLM call (no prompt or output text)" }),
  cyclesRollover: r({ method: "POST", path: "/internal/v1/cycles/rollover", mount: "internal", phase: 2, auth: "internal", summary: "Create successor cycles" }),
} as const satisfies Record<string, RouteDef>;

export type RouteId = keyof typeof ROUTES;
export const ROUTE_LIST: readonly (RouteDef & { id: RouteId })[] = (Object.keys(ROUTES) as RouteId[]).map((id) => ({
  id,
  ...ROUTES[id],
}));

/** The path a router registers, relative to its mount base (`/api/v1/programs/:slug` -> `/programs/:slug`). */
export function relativePath(route: RouteDef): string {
  const base = MOUNT_BASES[route.mount];
  if (!base) return route.path;
  const rest = route.path.slice(base.length);
  return rest === "" ? "/" : rest;
}

export function routesForMount(mount: RouteMount, maxPhase: Phase = 2): (RouteDef & { id: RouteId })[] {
  return ROUTE_LIST.filter((rt) => rt.mount === mount && rt.phase <= maxPhase);
}

/** Names of the `:params` in a path. */
export function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)(\{[^}]*\})?/g)].map((m) => m[1] as string);
}

/**
 * Fills a route's params and appends a query string. Throws when a param is missing, so a typo
 * fails in development instead of producing a broken link.
 */
export function buildPath(
  route: RouteDef,
  params: Record<string, string | number> = {},
  query: Record<string, string | number | boolean | readonly (string | number)[] | undefined> = {},
): string {
  const path = route.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)(\{[^}]*\})?/g, (_m, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`missing path param ${name} for ${route.path}`);
    return encodeURIComponent(String(value));
  });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) v.forEach((item) => qs.append(k, String(item)));
    else qs.append(k, String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}
