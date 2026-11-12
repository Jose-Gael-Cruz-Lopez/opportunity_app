import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import {
  CampusDeadlineSubmissionSchema,
  ProgramListCreateSchema,
  ProgramListUpdateSchema,
  findSensitiveKeys,
  issuesFromZod,
  problem,
  type AdvisorWorkspace,
  type ApiErrorCode,
  type ProgramList,
  type ProblemDetails,
  type WorkspaceReport,
} from "@shared/contracts";
import { localDateIn } from "@shared/time";
import * as advisorRepo from "@server/db/repos/advisor";
import * as registryRepo from "@server/db/repos/registry";
import * as reviewRepo from "@server/db/repos/review";
import { can, type PermissionAction } from "@server/auth/permissions";
import type { RepoResult } from "@server/db/repos/common";
import type { AppEnv } from "@server/env";
import { buildProgressView } from "./aggregate";
import { exportFileName, toCsv } from "./csv";
import { isFuturePeriod, monthOf, parsePeriod } from "./period";
import type { AdvisorDeps } from "./ports";
import {
  approvedCampusDeadlines,
  campusPayloadKey,
  listedPrograms,
  listPagePaths,
  listViewCount,
  pendingCampusSubmissions,
  trackerStatusCounts,
} from "./queries";

/**
 * Advisor routes, mounted at /api/v1 (plan 10.4.2, Phase 2 concierge pilot kit).
 *
 * - Every workspace route needs the advisor role on a session that passed the staff second
 *   factor (deps.requireAdvisor), the workspace-scoped matrix action (`can()`, which also checks
 *   TOTP) AND live membership of that workspace in D1. A workspace or list the advisor may not
 *   act on answers 404, never 403, so ids cannot be probed.
 * - Nothing here returns an individual student. Progress and reports are aggregate counts passed
 *   through shared/disclosure's advisor thresholds (groups under 5 are withheld).
 * - Bodies carrying a status or identity key are refused before validation and never logged.
 * - Public reads of a list (by slug or unlisted token) need no session; they return only what
 *   the advisor published.
 */

type Ctx = Context<AppEnv>;

/** Matrix rows for the routes below (plan 9.11.2, "Within an AdvisorWorkspace"). */
type WorkspaceAction = Extract<PermissionAction, "workspace.lists.manage" | "workspace.campus_deadlines.submit" | "workspace.aggregates.read">;
const LISTS: WorkspaceAction = "workspace.lists.manage";
const CAMPUS: WorkspaceAction = "workspace.campus_deadlines.submit";
const AGGREGATES: WorkspaceAction = "workspace.aggregates.read";

const MAX_BODY_BYTES = 64 * 1024;
const PROBLEM_HEADERS = { "content-type": "application/problem+json" } as const;

function fail(c: Ctx, code: ApiErrorCode, extra: Partial<Omit<ProblemDetails, "code" | "status">> = {}): Response {
  const body = problem(code, { ...extra, requestId: c.get("requestId") || undefined });
  return c.body(JSON.stringify(body), body.status as 400, PROBLEM_HEADERS);
}

function fromRepo<T>(c: Ctx, result: Extract<RepoResult<T>, { ok: false }>): Response {
  switch (result.error) {
    case "not_found":
      return fail(c, "not_found");
    case "version_conflict":
      return fail(c, "version_conflict");
    case "invalid":
      return fail(c, "validation_failed", { detail: (result.detail ?? "invalid").slice(0, 500) });
    case "consent_required":
      return fail(c, "consent_required");
    default:
      return fail(c, "conflict");
  }
}

/** Parses a JSON body against a strict schema, refusing sensitive keys first. */
async function readBody<S extends z.ZodTypeAny>(c: Ctx, schema: S): Promise<{ ok: true; data: z.output<S> } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: fail(c, "bad_request", { detail: "Body must be JSON." }) };
  }
  if (findSensitiveKeys(raw).length > 0) return { ok: false, response: fail(c, "sensitive_field_rejected") };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, response: fail(c, "validation_failed", { errors: issuesFromZod(parsed.error) }) };
  return { ok: true, data: parsed.data };
}

/** `If-Match: "3"`, `W/"3"` or `3` -> 3. */
export function parseIfMatch(header: string | undefined): number | null {
  if (!header) return null;
  const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(header.trim());
  return m ? Number(m[1]) : null;
}

function csvResponse(c: Ctx, fileName: string, body: string): Response {
  return c.body(body, 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${fileName}"`,
    "cache-control": "no-store",
  });
}

export function createAdvisorRoutes(deps: AdvisorDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const guard = deps.requireAdvisor;
  const limit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c as Ctx, "payload_too_large") });

  // Advisor responses describe a tenant; never let a shared cache keep them.
  app.use("/workspaces/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
  });

  /**
   * The workspace if the signed-in advisor may perform `action` in it, else null (answered as
   * 404). Two checks, both required: the permission matrix on the session's grants (scope and
   * second factor), and a fresh membership read, so a role revoked after sign-in stops at once.
   */
  async function memberWorkspace(c: Ctx, workspaceId: string, action: WorkspaceAction): Promise<AdvisorWorkspace | null> {
    const user = deps.user(c);
    if (!user || !can(user, action, { workspaceId })) return null;
    const mine = await advisorRepo.workspacesForUser(deps.db(c), user.id);
    return mine.find((w) => w.id === workspaceId) ?? null;
  }

  // ---- Workspaces and lists -----------------------------------------------------------------

  app.get("/workspaces", guard, async (c) => {
    const user = deps.user(c);
    if (!user) return fail(c, "unauthenticated");
    const items = await advisorRepo.workspacesForUser(deps.db(c), user.id);
    return c.json({ items });
  });

  app.get("/workspaces/:workspaceId/lists", guard, async (c) => {
    const ws = await memberWorkspace(c, c.req.param("workspaceId"), LISTS);
    if (!ws) return fail(c, "not_found");
    return c.json({ items: await advisorRepo.listWorkspaceLists(deps.db(c), { workspaceId: ws.id }) });
  });

  app.post("/workspaces/:workspaceId/lists", guard, limit, async (c) => {
    const ws = await memberWorkspace(c, c.req.param("workspaceId"), LISTS);
    if (!ws) return fail(c, "not_found");
    const body = await readBody(c, ProgramListCreateSchema);
    if (!body.ok) return body.response;
    const result = await advisorRepo.createProgramList(deps.db(c), { workspaceId: ws.id }, body.data, deps.now());
    if (!result.ok) return fromRepo(c, result);
    c.header("etag", `"1"`);
    return c.json(result.value, 201);
  });

  app.get("/workspaces/:workspaceId/lists/:listId", guard, async (c) => {
    const ws = await memberWorkspace(c, c.req.param("workspaceId"), LISTS);
    if (!ws) return fail(c, "not_found");
    const tenant = { workspaceId: ws.id };
    const db = deps.db(c);
    const list = await advisorRepo.getProgramList(db, tenant, c.req.param("listId"));
    if (!list) return fail(c, "not_found");
    const version = await advisorRepo.getProgramListVersion(db, tenant, list.id);
    if (version !== null) c.header("etag", `"${version}"`);
    return c.json(list);
  });

  /**
   * The route map's PATCH has no workspace in the path, so the list's workspace is found among the
   * advisor's own. If-Match carries the version the editor saw; without it the current version is
   * used (last write wins), which the single-advisor pilot tolerates.
   */
  app.patch("/lists/:listId", guard, limit, async (c) => {
    const user = deps.user(c);
    if (!user) return fail(c, "unauthenticated");
    const db = deps.db(c);
    const listId = c.req.param("listId");
    const ifMatch = c.req.header("if-match");
    const expected = parseIfMatch(ifMatch);
    if (ifMatch !== undefined && expected === null) return fail(c, "bad_request", { detail: "If-Match must be a list version." });

    let tenant: advisorRepo.TenantContext | null = null;
    let current: number | null = null;
    for (const ws of await advisorRepo.workspacesForUser(db, user.id)) {
      if (!can(user, LISTS, { workspaceId: ws.id })) continue;
      current = await advisorRepo.getProgramListVersion(db, { workspaceId: ws.id }, listId);
      if (current !== null) {
        tenant = { workspaceId: ws.id };
        break;
      }
    }
    if (!tenant || current === null) return fail(c, "not_found");

    const body = await readBody(c, ProgramListUpdateSchema);
    if (!body.ok) return body.response;
    const result = await advisorRepo.updateProgramList(db, tenant, listId, body.data, expected ?? current, deps.now());
    if (!result.ok) return fromRepo(c, result);
    c.header("etag", `"${(expected ?? current) + 1}"`);
    return c.json(result.value);
  });

  app.delete("/workspaces/:workspaceId/lists/:listId", guard, async (c) => {
    const ws = await memberWorkspace(c, c.req.param("workspaceId"), LISTS);
    if (!ws) return fail(c, "not_found");
    const deleted = await advisorRepo.deleteProgramList(deps.db(c), { workspaceId: ws.id }, c.req.param("listId"), deps.now());
    return deleted ? c.body(null, 204) : fail(c, "not_found");
  });

  /** One list as CSV: its programs with national deadlines and any approved campus deadline. */
  app.get("/workspaces/:workspaceId/lists/:listId/export.csv", guard, async (c) => {
    const ws = await memberWorkspace(c, c.req.param("workspaceId"), LISTS);
    if (!ws) return fail(c, "not_found");
    const db = deps.db(c);
    const now = deps.now();
    const list = await advisorRepo.getProgramList(db, { workspaceId: ws.id }, c.req.param("listId"));
    if (!list) return fail(c, "not_found");
    return csvResponse(c, exportFileName(list.title, "list"), await listCsv(db, ws, list, now));
  });

  // ---- Campus deadlines ---------------------------------------------------------------------

  /**
   * An advisor submits a campus deadline; a Curator confirms it with the office's published
   * contact before anything displays. Submissions for the same cycle from several workspaces
   * share one review task, each under its own payload key.
   */
  app.post("/workspaces/:workspaceId/campus-deadlines", guard, limit, async (c) => {
    const ws = await memberWorkspace(c, c.req.param("workspaceId"), CAMPUS);
    if (!ws) return fail(c, "not_found");
    if (!ws.institutionId) return fail(c, "conflict", { detail: "Campus deadlines need a workspace linked to an institution." });
    const body = await readBody(c, CampusDeadlineSubmissionSchema);
    if (!body.ok) return body.response;
    const sub = body.data;
    const db = deps.db(c);
    const now = deps.now();

    if (sub.localDate < localDateIn(now, sub.timeZone)) {
      return fail(c, "validation_failed", { errors: [{ path: "localDate", message: "Campus deadlines must be today or later." }] });
    }
    const program = await registryRepo.getProgramBySlug(db, sub.programSlug);
    if (!program || !program.isPublished) return fail(c, "validation_failed", { errors: [{ path: "programSlug", message: "Unknown program." }] });
    const cycle = await registryRepo.getCycleByKey(db, program.id, sub.cycleKey);
    if (!cycle) return fail(c, "validation_failed", { errors: [{ path: "cycleKey", message: "Unknown cycle for this program." }] });

    const user = deps.user(c);
    const created = await reviewRepo.createReviewTask(
      db,
      // No reason code is specific to campus submissions yet; value_changed is the closest.
      { kind: "campus_deadline", subject: { type: "program_cycle", id: cycle.id }, reasonCodes: ["value_changed"], evidence: [], priority: 4, dueAt: null },
      now,
      {
        [campusPayloadKey(ws.id)]: {
          ...sub,
          workspaceId: ws.id,
          institutionId: ws.institutionId,
          submittedBy: user?.id ?? null,
          submittedAt: new Date(now).toISOString(),
        },
      },
    );
    if (!created.ok) return fromRepo(c, created);
    return c.json({ status: "pending_review" as const }, 202);
  });

  app.get("/workspaces/:workspaceId/campus-deadlines", guard, async (c) => {
    const ws = await memberWorkspace(c, c.req.param("workspaceId"), CAMPUS);
    if (!ws) return fail(c, "not_found");
    const db = deps.db(c);
    const programs = await listedPrograms(db, ws.id);
    const approved = ws.institutionId ? await approvedCampusDeadlines(db, ws.institutionId, programs.map((p) => p.id)) : [];
    return c.json({
      institutionLinked: ws.institutionId !== null,
      pending: await pendingCampusSubmissions(db, ws.id),
      approved: approved.map((d) => ({
        programSlug: d.programSlug,
        programName: d.programName,
        cycleKey: d.cycleKey,
        kind: d.kind,
        localDate: d.localDate,
        localTime: d.localTime,
        timeZone: d.timeZone,
        confirmedOn: new Date(d.confirmedAt).toISOString().slice(0, 10),
      })),
    });
  });

  // ---- Aggregate progress and reports -------------------------------------------------------

  /** Current saves and application stages for the listed programs, across Novus, k >= 5. */
  app.get("/workspaces/:workspaceId/progress", guard, async (c) => {
    const ws = await memberWorkspace(c, c.req.param("workspaceId"), AGGREGATES);
    if (!ws) return fail(c, "not_found");
    const db = deps.db(c);
    const programs = await listedPrograms(db, ws.id);
    const counts = await trackerStatusCounts(db, programs.filter((p) => !p.restricted).map((p) => p.id));
    return c.json(buildProgressView(monthOf(deps.now()), programs, counts));
  });

  app.get("/workspaces/:workspaceId/reports/:period", guard, async (c) => {
    const ws = await memberWorkspace(c, c.req.param("workspaceId"), AGGREGATES);
    if (!ws) return fail(c, "not_found");
    const report = await loadReport(c, ws.id, c.req.param("period"));
    return "response" in report ? report.response : c.json(report.value);
  });

  app.get("/workspaces/:workspaceId/reports/:period/export.csv", guard, async (c) => {
    const ws = await memberWorkspace(c, c.req.param("workspaceId"), AGGREGATES);
    if (!ws) return fail(c, "not_found");
    const report = await loadReport(c, ws.id, c.req.param("period"));
    if ("response" in report) return report.response;
    const r = report.value;
    const csv = toCsv(
      ["section", "program", "value"],
      [["list views", "", r.listViews], ["trackers on listed programs", "", r.trackedPrograms], ...r.rows.map((row) => ["trackers", row.programSlug, row.trackers])],
    );
    return csvResponse(c, exportFileName(ws.name, `report-${r.period}`), csv);
  });

  async function loadReport(c: Ctx, workspaceId: string, period: string): Promise<{ value: WorkspaceReport } | { response: Response }> {
    const range = parsePeriod(period);
    if (!range) return { response: fail(c, "validation_failed", { errors: [{ path: "period", message: "Use YYYY-MM or YYYY-Qn." }] }) };
    if (isFuturePeriod(range, deps.now())) return { response: fail(c, "validation_failed", { errors: [{ path: "period", message: "That period has not started." }] }) };
    const db = deps.db(c);
    const views = await listViewCount(deps.eventsDb(c), await listPagePaths(db, workspaceId), range.startMs, range.endMs);
    const report = await advisorRepo.workspaceReport(db, { workspaceId }, period, views ?? 0);
    // Without the events database the count is unknown, which must not read as "fewer than 10".
    return { value: views === null ? { ...report, listViews: "not available" } : report };
  }

  // ---- Public list reads (no session) -------------------------------------------------------

  app.get("/lists/by-slug/:slug", async (c) => {
    const list = await advisorRepo.getPublicProgramList(deps.db(c), { slug: c.req.param("slug") });
    if (!list) return fail(c, "not_found");
    c.header("cache-control", "public, max-age=60");
    return c.json(publicView(list));
  });

  app.get("/lists/u/:token", async (c) => {
    const token = c.req.param("token");
    if (!/^[0-9A-Za-z]{20,32}$/.test(token)) return fail(c, "not_found");
    const list = await advisorRepo.getPublicProgramList(deps.db(c), { token });
    if (!list) return fail(c, "not_found");
    // Unlisted: the token is the capability, so keep it out of caches and search engines.
    c.header("cache-control", "private, no-store");
    c.header("x-robots-tag", "noindex");
    c.header("referrer-policy", "no-referrer");
    return c.json(publicView(list));
  });

  return app;
}

/** Public list readers never need the owning workspace's internal id. */
export function publicView(list: ProgramList): Omit<ProgramList, "workspaceId"> {
  const { workspaceId: _omit, ...rest } = list;
  return rest;
}

async function listCsv(db: Parameters<typeof registryRepo.listProgramCards>[0], ws: AdvisorWorkspace, list: ProgramList, now: number): Promise<string> {
  const listed = await listedPrograms(db, ws.id);
  const onList = new Set(list.items.map((i) => i.programSlug));
  const ids = listed.filter((p) => onList.has(p.slug)).map((p) => p.id);
  const cards = new Map((await registryRepo.listProgramCards(db, now, { programIds: ids })).map((card) => [card.slug, card]));
  const campus = ws.institutionId ? await approvedCampusDeadlines(db, ws.institutionId, ids) : [];

  const rows = list.items.map((item) => {
    const card = cards.get(item.programSlug);
    const national = card?.deadlines.find((d) => d.scope === "national" && d.localDate !== null) ?? null;
    const own = campus.find((d) => d.programSlug === item.programSlug && (item.cycleKey === null || d.cycleKey === item.cycleKey));
    return [
      item.position + 1,
      card?.name ?? item.programSlug,
      card?.organizationName ?? "",
      item.cycleKey ?? card?.cycleKey ?? "",
      national?.localDate ?? "",
      national?.timeZone ?? "",
      own?.localDate ?? "",
      card?.status ?? "",
      card?.verification.verifiedOn ?? "",
      item.note ?? "",
      card?.officialUrl ?? "",
      card?.isSample ? "sample" : "",
    ];
  });
  return toCsv(
    ["position", "program", "organization", "cycle", "national deadline", "deadline time zone", "campus deadline", "status", "verified on", "advisor note", "official page", "sample data"],
    rows,
  );
}
