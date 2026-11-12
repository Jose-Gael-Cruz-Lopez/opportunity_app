import { ProblemDetailsSchema } from "@shared/contracts/common";
import type { ReviewTask } from "@shared/contracts/ops";
import type { Deadline, ReleasePointer, Requirement } from "@shared/contracts/registry";

/**
 * The console's API client. The Curator routes live on the console's own origin (curate.), so
 * every call is same-origin with the Strict session cookie. A 403 with the second-factor problem
 * type becomes `step_up` so the shell can ask for the authenticator code instead of "forbidden".
 *
 * Shapes mirror server/api/v1/curator (schemas.ts, evidence.ts, ops.ts). The console never sends
 * or receives student data: tasks are about registry records and public official pages.
 */

export const SECOND_FACTOR_PROBLEM_TYPE = "/problems/second-factor-required";
export const API = "/api/v1";
export const SECOND_FACTOR = "/api/auth/novus/second-factor";

export type ConsoleErrorKind = "signed_out" | "step_up" | "enroll" | "forbidden" | "not_found" | "conflict" | "invalid" | "precondition" | "unavailable";

export class ConsoleError extends Error {
  constructor(
    readonly kind: ConsoleErrorKind,
    readonly status: number,
    readonly detail: string,
    readonly fieldErrors: readonly { path: string; message: string }[] = [],
  ) {
    super(detail);
    this.name = "ConsoleError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const FALLBACK: Record<ConsoleErrorKind, string> = {
  signed_out: "Sign in to continue.",
  step_up: "Confirm the code from your authenticator app to continue.",
  enroll: "Set up an authenticator app to continue.",
  forbidden: "This account cannot do that.",
  not_found: "Not found. It may have been resolved already.",
  conflict: "Someone else changed this first. Reload and try again.",
  invalid: "Check the highlighted fields.",
  precondition: "A required step is missing.",
  unavailable: "The console cannot reach the server right now.",
};

/** Maps a failed response to a ConsoleError (pure apart from reading the body). */
export async function errorFor(res: Response): Promise<ConsoleError> {
  let detail = "";
  let type = "";
  let errors: { path: string; message: string }[] = [];
  try {
    const parsed = ProblemDetailsSchema.safeParse(await res.json());
    if (parsed.success) {
      detail = parsed.data.detail ?? "";
      type = parsed.data.type;
      errors = parsed.data.errors ?? [];
    }
  } catch {
    // Not JSON: the status decides.
  }
  let kind: ConsoleErrorKind;
  if (res.status === 401) kind = "signed_out";
  else if (res.status === 403 && type === SECOND_FACTOR_PROBLEM_TYPE) kind = /set up/i.test(detail) ? "enroll" : "step_up";
  else if (res.status === 403) kind = "forbidden";
  else if (res.status === 404) kind = "not_found";
  else if (res.status === 409) kind = "conflict";
  else if (res.status === 412) kind = "precondition";
  else if (res.status === 400 || res.status === 422) kind = "invalid";
  else kind = "unavailable";
  return new ConsoleError(kind, res.status, detail || FALLBACK[kind], errors);
}

export async function request<T>(path: string, init: { method?: string; body?: unknown } = {}, fetcher: FetchLike = (i, r) => fetch(i, r)): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(path, {
      method: init.method ?? "GET",
      credentials: "same-origin",
      // Keeps the Origin header on writes whatever the document's referrer policy says
      // (a no-referrer policy turns it into "Origin: null", which the CSRF checks refuse).
      referrerPolicy: "same-origin",
      headers: init.body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ConsoleError("unavailable", 0, FALLBACK.unavailable);
  }
  if (!res.ok) throw await errorFor(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------------------------
// Shapes (mirrors of server/api/v1/curator)
// ---------------------------------------------------------------------------------------------

export const QUEUE_VIEWS = ["queue", "mine", "second_review", "escalated", "snoozed"] as const;
export type QueueView = (typeof QUEUE_VIEWS)[number];

export interface TaskContext {
  programName: string | null;
  programSlug: string | null;
  termLabel: string | null;
  isSample: boolean;
  severity: number;
  overdue: boolean;
  secondReviewOf: string | null;
}

export interface QueueResponse {
  items: ReviewTask[];
  page: { nextCursor: string | null; limit: number };
  context: Record<string, TaskContext>;
  viewer: { handle: string; roles: string[] };
}

export interface QuoteMark {
  start: number;
  end: number;
  ref: string;
  kind: "verified" | "proposed";
}

export interface SnapshotView {
  id: string;
  sourceId: string;
  role: "latest" | "baseline" | "task";
  finalUrl: string;
  officialLink: string;
  fetchedAt: string;
  contentType: string;
  isPdf: boolean;
  changeClass: string | null;
  httpStatus: number;
  text: string | null;
  textTruncated: boolean;
  textUnavailable: "no_text_layer" | "store_unavailable" | "missing" | null;
  highlights: QuoteMark[];
  missingQuotes: string[];
}

export interface EvidenceQuoteView {
  id: string;
  entityType: string;
  entityId: string;
  fieldPath: string;
  quote: string;
  url: string;
  snapshotId: string | null;
  basis: string;
  match: string;
  page: number | null;
}

export interface HistoryEntry {
  id: string;
  at: string;
  actor: { kind: string; ref: string };
  field?: string;
  before?: unknown;
  after?: unknown;
}

export interface EvidenceView {
  task: ReviewTask;
  program: { id: string; name: string; slug: string; officialUrl: string; isSample: boolean } | null;
  cycle: {
    id: string;
    cycleKey: string;
    termLabel: string;
    status: string;
    version: number;
    applicationUrl: string | null;
    applicationFeeCents: number | null;
    opensOn: string | null;
    verificationState: string;
    lastVerifiedAt: string | null;
    verifiedBy: string | null;
  } | null;
  verified: { deadlines: Deadline[]; requirements: Requirement[]; evidence: EvidenceQuoteView[] };
  snapshots: SnapshotView[];
  diffs: { sourceId: string; baselineSnapshotId: string; latestSnapshotId: string; hunks: { op: "same" | "add" | "del"; line: string }[]; truncated: boolean }[];
  proposals: { ref: string; field: string; value: string; quote: string; status: string }[];
  findings: { path: string; code: string; blocked: boolean; flags: string[] }[];
  riskSignals: string[];
  firstApproval: { by: string | null; at: string | null; reasons: string[]; edits: unknown } | null;
  officialOpenedByMe: boolean;
  history: HistoryEntry[];
}

export interface EvidenceEdit {
  snapshotId: string | null;
  url: string;
  quote: string;
  basis?: "snapshot" | "manual_note";
  page?: number | null;
}

export interface DeadlineEdit {
  kind: string;
  scope?: "national" | "campus";
  institutionId?: string | null;
  roundLabel?: string;
  basis?: "official" | "attested";
  precision: "exact" | "date_only" | "month_only" | "rolling" | "tbd";
  tzMode?: "fixed" | "applicant_local";
  localDate: string | null;
  localTime: string | null;
  timeZone: string | null;
}

export type DeadlineOp = { op: "upsert"; deadline: DeadlineEdit; evidence: EvidenceEdit } | { op: "withdraw"; deadlineId: string; evidence?: EvidenceEdit | null };

export interface Edits {
  cycleId?: string;
  cycle?: { status?: string; applicationUrl?: string | null; applicationFeeCents?: number | null; opensOn?: string | null };
  cycleEvidence?: Partial<Record<"status" | "applicationUrl" | "applicationFeeCents" | "opensOn", EvidenceEdit>>;
  deadlines?: DeadlineOp[];
  verify?: boolean;
}

export const REJECT_REASONS = ["no_material_change", "not_official_source", "quote_not_found", "duplicate", "out_of_scope", "source_unreachable", "other"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export type ResolveBody =
  | { decision: "approve"; resolution: string; subjectVersion: number | null; edits?: Edits; activeSeconds: number }
  | { decision: "reject"; resolution: string; subjectVersion: null; rejectReason: RejectReason; activeSeconds: number }
  | { decision: "snooze"; resolution: string; subjectVersion: null; snoozeUntil: string; activeSeconds: number }
  | { decision: "escalate"; resolution: string; subjectVersion: null; activeSeconds: number };

export type ResolveResult = ReviewTask & { outcome?: "applied" | "second_review"; secondReviewReasons?: string[] };

export interface OpsPipelineView {
  generatedAt: string;
  queues: { kind: string; pending: number; leased: number; dead: number; oldestPendingRunAfter: string | null; lateMinutes: number }[];
  failures: { id: string; kind: string; status: string; attempts: number; maxAttempts: number; lastError: string | null; runAfter: string; finishedAt: string | null; payloadKeys: string[]; retryable: boolean }[];
  lastRuns: { kind: string; startedAt: string; finishedAt: string | null; outcome: string | null; processed: number; errorClass: string | null }[];
  heartbeats: { name: string; lastSeenAt: string; stale: boolean }[];
  review: { open: number; overdue: number; secondReview: number; escalated: number; claimed: number; appliedLast24h: number; medianActiveSeconds: number | null };
  releases: { number: number; state: string; createdAt: string; builtAt: string | null; publishedAt: string | null; containsSample: boolean; canRollBackTo: boolean }[];
  currentRelease: number | null;
}

// ---------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------

export function createConsoleApi(fetcher: FetchLike = (i, r) => fetch(i, r)) {
  const call = <T>(path: string, init?: { method?: string; body?: unknown }) => request<T>(path, init, fetcher);
  const task = (id: string) => `${API}/review-tasks/${encodeURIComponent(id)}`;
  return {
    queue(view: QueueView, cursor?: string | null) {
      const q = new URLSearchParams({ view, limit: "50" });
      if (cursor) q.set("cursor", cursor);
      return call<QueueResponse>(`${API}/review-tasks?${q.toString()}`);
    },
    evidence: (id: string) => call<EvidenceView>(task(id)),
    claim: (id: string) => call<ReviewTask>(`${task(id)}/claim`, { method: "POST", body: {} }),
    release: (id: string) => call<ReviewTask>(`${task(id)}/release`, { method: "POST", body: {} }),
    resolve: (id: string, body: ResolveBody) => call<ResolveResult>(`${task(id)}/resolve`, { method: "POST", body }),
    recheck: (id: string, urgent: boolean) => call<{ requested: boolean; jobsCreated: number }>(`${task(id)}/recheck`, { method: "POST", body: { urgent } }),
    officialOpened: (id: string, snapshotId: string | null, page: number | null) =>
      call<void>(`${task(id)}/official-opened`, { method: "POST", body: { snapshotId, page } }),
    ops: () => call<OpsPipelineView>(`${API}/ops/pipeline`),
    retryJob: (id: string) => call<{ id: string; status: string }>(`${API}/ops/jobs/${encodeURIComponent(id)}/retry`, { method: "POST", body: {} }),
    rollback: (release: number) => call<ReleasePointer>(`${API}/registry/release/rollback`, { method: "POST", body: { release } }),
    secondFactorVerify: (code: string) => call<unknown>(`${SECOND_FACTOR}/verify`, { method: "POST", body: { code: code.replace(/\s/g, "") } }),
    secondFactorRecovery: (code: string) => call<unknown>(`${SECOND_FACTOR}/recovery`, { method: "POST", body: { code: code.trim() } }),
  };
}

export type ConsoleApi = ReturnType<typeof createConsoleApi>;
export const consoleApi = createConsoleApi();
