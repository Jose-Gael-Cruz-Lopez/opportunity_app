import { Hono, type Context } from "hono";
import type { z } from "zod";
import { IdSchema } from "@shared/contracts/common";
import { ROUTES, relativePath } from "@shared/contracts/routes";
import { decide } from "@server/auth";
import type { Db } from "@server/db/client";
import { LEGACY_OVER_COUNT_REASON, releaseCycleHolds } from "@server/db/repos/bands";
import type { AppEnv } from "@server/env";
import { problemFor } from "@server/lib/problem";
import { parseInput } from "@server/lib/validation";
import { actorFor } from "./audit";
import { buildEvidenceView } from "./evidence";
import { consoleSurface, curatorOf, loadCuratorIdentity, requireAdminRole, requireCuratorIdentity, requireCuratorRole } from "./guard";
import { opsPipeline, retryJob } from "./ops";
import type { CuratorDeps } from "./ports";
import { approveTask } from "./publish";
import { claimable, decodeCursor, encodeCursor, inView, orderQueue } from "./queue";
import { rollbackRelease } from "./rollback";
import {
  CuratorResolveSchema,
  JobRetrySchema,
  OfficialOpenedSchema,
  QueueQuerySchema,
  RecheckSchema,
  RollbackSchema,
  type QueueResponse,
  type TaskContext,
} from "./schemas";
import {
  candidateRows,
  claimTask,
  escalateTask,
  getTask,
  recordOfficialOpened,
  rejectTask,
  releaseTask,
  requestRecheck,
  snoozeTask,
  subjectLinks,
  taskContexts,
  toQueueRow,
  toWire,
  type ActionResult,
  type TaskRow,
} from "./store";

/**
 * The Curator API (plan 04 4.10, 01 F-16), mounted under /api/v1 (route-map mount `registry`).
 *
 *   GET  /review-tasks                  listReviewTasks  queue views, ordered by due time then severity
 *   GET  /review-tasks/:id              task + side-by-side evidence (not in the route map yet)
 *   POST /review-tasks/:id/claim        claimReviewTask  15-minute lease
 *   POST /review-tasks/:id/release      releaseReviewTask
 *   POST /review-tasks/:id/resolve      resolveReviewTask approve (with edits) / reject (reason code) /
 *                                                         snooze (date + reason) / escalate
 *   POST /review-tasks/:id/recheck      request a fresh fetch of the program's Sources (not mapped yet)
 *   POST /review-tasks/:id/official-opened  log the live-official-link click (not mapped yet)
 *   GET  /ops/pipeline                  opsPipeline      jobs, failures, runs, heartbeats, releases
 *   POST /ops/jobs/:id/retry            retry a failed job (not mapped yet)
 *   POST /registry/release/rollback     releaseRollback  admin only
 *
 * Every route: requireRole("curator", "admin") (401, 403, or 403 second-factor-required until
 * TOTP), then the console surface in staging and production. Task routes also need an active
 * Curator handle. Every state change writes its audit row in the same D1 batch (./audit.ts).
 */

type Ctx = Context<AppEnv>;

const path = (id: keyof typeof ROUTES) => relativePath(ROUTES[id]);

async function readBody<S extends z.ZodTypeAny>(c: Ctx, schema: S): Promise<{ ok: true; data: z.output<S> } | { ok: false; res: Response }> {
  let raw: unknown = {};
  const text = await c.req.text();
  if (text.trim().length > 0) {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, res: problemFor(c, "bad_request", { detail: "The body is not valid JSON." }) };
    }
  }
  const parsed = parseInput(schema, raw);
  if (!parsed.ok) return { ok: false, res: problemFor(c, parsed.code, { errors: parsed.errors }) };
  return { ok: true, data: parsed.data };
}

function taskId(c: Ctx): string | null {
  const id = c.req.param("id");
  return id && IdSchema.safeParse(id).success ? id : null;
}

function actionAnswer(c: Ctx, result: ActionResult): Response | null {
  if (result.ok) return null;
  return problemFor(c, "conflict", { detail: result.detail });
}

/**
 * A resolved over-count `outcome_anomaly` task lifts the cycle's over-count hold
 * (outcome_cycle_holds, opened by the outcomes.quality job). Only a decision lifts it
 * (approved, applied or rejected); a snoozed, escalated or second-review task keeps the hold.
 */
const HOLD_LIFTING_STATES: readonly string[] = ["approved", "applied", "rejected"];
async function liftOverCountHold(db: Db, row: TaskRow, now: number): Promise<void> {
  if (row.kind !== "outcome_anomaly" || row.subjectType !== "program_cycle" || !(row.reasonCodes ?? []).includes(LEGACY_OVER_COUNT_REASON)) return;
  const after = await getTask(db, row.id);
  if (!after || !HOLD_LIFTING_STATES.includes(after.state)) return;
  await releaseCycleHolds(db, row.subjectId, now, "over_count");
}

export function createCuratorRoutes(deps: CuratorDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const staff = [requireCuratorRole, consoleSurface(deps)] as const;
  const curator = [...staff, requireCuratorIdentity(deps)] as const;

  async function loadTask(c: Ctx): Promise<{ row: TaskRow } | { res: Response }> {
    const id = taskId(c);
    if (!id) return { res: problemFor(c, "not_found") };
    const row = await getTask(deps.db(c), id);
    return row ? { row } : { res: problemFor(c, "not_found") };
  }

  async function wire(c: Ctx, id: string) {
    const db = deps.db(c);
    const row = await getTask(db, id);
    return row ? (await toWire(db, [row]))[0]! : null;
  }

  // ---- Queue ------------------------------------------------------------------------------------
  app.get(path("listReviewTasks"), ...curator, async (c) => {
    const parsed = parseInput(QueueQuerySchema, Object.fromEntries(new URL(c.req.url).searchParams));
    if (!parsed.ok) return problemFor(c, parsed.code, { errors: parsed.errors });
    const q = parsed.data;
    const db = deps.db(c);
    const now = deps.now();
    const who = curatorOf(c);
    const rows = (await candidateRows(db, q.view, q.kind)).filter((r) => inView(toQueueRow(r), q.view, who.id, now));
    const contexts = await taskContexts(db, rows, now);
    const ordered = orderQueue(rows.map((r) => ({ ...toQueueRow(r), wedge: contexts.get(r.id)?.wedge ?? false, row: r })));
    const offset = decodeCursor(q.cursor);
    const pageRows = ordered.slice(offset, offset + q.limit).map((o) => o.row);
    const items = await toWire(db, pageRows);
    const context: Record<string, TaskContext> = {};
    for (const r of pageRows) {
      const { wedge: _w, ...ctx } = contexts.get(r.id)!;
      context[r.id] = ctx;
    }
    const user = deps.user(c)!;
    const body: QueueResponse = {
      items,
      page: { nextCursor: encodeCursor(offset + q.limit, ordered.length), limit: q.limit },
      context,
      viewer: { handle: who.handle, roles: user.roles.filter((r) => r !== "student") },
    };
    return c.json(body);
  });

  // ---- Task detail with evidence -------------------------------------------------------------
  app.get("/review-tasks/:id", ...curator, async (c) => {
    const found = await loadTask(c);
    if ("res" in found) return found.res;
    return c.json(await buildEvidenceView(deps.db(c), deps.bucket(c), found.row, curatorOf(c).id));
  });

  // ---- Claim and release ----------------------------------------------------------------------
  app.post(path("claimReviewTask"), ...curator, async (c) => {
    const body = await readBody(c, JobRetrySchema);
    if (!body.ok) return body.res;
    const found = await loadTask(c);
    if ("res" in found) return found.res;
    const who = curatorOf(c);
    const now = deps.now();
    const can = claimable(toQueueRow(found.row), who.id, now, who.isAdmin);
    if (!can.ok) return problemFor(c, "conflict", { detail: can.reason });
    const res = await claimTask(deps.db(c), found.row, who, now);
    return actionAnswer(c, res) ?? c.json(await wire(c, found.row.id));
  });

  app.post(path("releaseReviewTask"), ...curator, async (c) => {
    const body = await readBody(c, JobRetrySchema);
    if (!body.ok) return body.res;
    const found = await loadTask(c);
    if ("res" in found) return found.res;
    const res = await releaseTask(deps.db(c), found.row, curatorOf(c), deps.now(), 0);
    return actionAnswer(c, res) ?? c.json(await wire(c, found.row.id));
  });

  // ---- Resolve ---------------------------------------------------------------------------------
  app.post(path("resolveReviewTask"), ...curator, async (c) => {
    const body = await readBody(c, CuratorResolveSchema);
    if (!body.ok) return body.res;
    const found = await loadTask(c);
    if ("res" in found) return found.res;
    const b = body.data;
    const db = deps.db(c);
    const who = curatorOf(c);
    const now = deps.now();
    const row = found.row;

    if (b.decision === "approve") {
      const outcome = await approveTask(db, deps.bucket(c), row, who, { edits: b.edits, resolution: b.resolution, subjectVersion: b.subjectVersion, activeSeconds: b.activeSeconds }, now);
      if (outcome.status === "error") {
        return problemFor(c, outcome.code, outcome.path ? { detail: outcome.detail, errors: [{ path: outcome.path, message: outcome.detail.slice(0, 200) }] } : { detail: outcome.detail });
      }
      if (outcome.status === "applied") {
        deps.log("info", "curator_publish", { changes: outcome.changes, changeEvents: outcome.changeEvents, kind: row.kind });
      }
      await liftOverCountHold(db, row, now);
      const task = await wire(c, row.id);
      return c.json({ ...task!, outcome: outcome.status, ...(outcome.status === "second_review" ? { secondReviewReasons: outcome.reasons } : {}) });
    }

    let res: ActionResult;
    if (b.decision === "reject") res = await rejectTask(db, row, who, { reason: b.rejectReason!, note: b.resolution, activeSeconds: b.activeSeconds }, now);
    else if (b.decision === "snooze") {
      const until = Date.parse(b.snoozeUntil!);
      if (until <= now) return problemFor(c, "validation_failed", { errors: [{ path: "snoozeUntil", message: "Pick a time in the future" }] });
      if (row.dueAt !== null && row.dueAt - now < 24 * 3_600_000) {
        // Runbook 14.4: never push a task due within 24 hours out of sight silently.
        if (b.resolution.trim().length < 10) return problemFor(c, "validation_failed", { errors: [{ path: "resolution", message: "This task is due within 24 hours; say why it waits" }] });
      }
      res = await snoozeTask(db, row, who, { until, note: b.resolution, activeSeconds: b.activeSeconds }, now);
    } else res = await escalateTask(db, row, who, { note: b.resolution, activeSeconds: b.activeSeconds }, now);
    if (res.ok) await liftOverCountHold(db, row, now);
    return actionAnswer(c, res) ?? c.json(await wire(c, row.id));
  });

  // ---- Recheck and the official-link log --------------------------------------------------------
  app.post("/review-tasks/:id/recheck", ...curator, async (c) => {
    const body = await readBody(c, RecheckSchema);
    if (!body.ok) return body.res;
    const found = await loadTask(c);
    if ("res" in found) return found.res;
    const db = deps.db(c);
    const link = (await subjectLinks(db, [found.row])).get(found.row.id);
    const res = await requestRecheck(db, found.row, curatorOf(c), { programId: link?.programId ?? null, cycleId: link?.cycleId ?? null, urgent: body.data.urgent, note: body.data.note }, deps.now());
    if (!res.ok) return problemFor(c, "conflict", { detail: res.detail });
    return c.json({ requested: true, jobsCreated: res.jobs ?? 0 }, 202);
  });

  app.post("/review-tasks/:id/official-opened", ...curator, async (c) => {
    const body = await readBody(c, OfficialOpenedSchema);
    if (!body.ok) return body.res;
    const found = await loadTask(c);
    if ("res" in found) return found.res;
    const res = await recordOfficialOpened(deps.db(c), found.row, curatorOf(c), body.data, deps.now());
    return actionAnswer(c, res) ?? c.body(null, 204);
  });

  // ---- Ops ---------------------------------------------------------------------------------------
  app.get(path("opsPipeline"), ...staff, async (c) => {
    if (!decide(deps.user(c), "ops.pipeline.read").allowed) return problemFor(c, "forbidden");
    return c.json(await opsPipeline(deps.db(c), deps.now()));
  });

  app.post("/ops/jobs/:id/retry", ...staff, async (c) => {
    const body = await readBody(c, JobRetrySchema);
    if (!body.ok) return body.res;
    const id = taskId(c);
    if (!id) return problemFor(c, "not_found");
    const db = deps.db(c);
    const user = deps.user(c)!;
    const identity = await loadCuratorIdentity(db, user);
    const actor = identity ? actorFor(identity.handle, identity.isAdmin) : { kind: "admin" as const, ref: `admin:${user.publicId}` };
    const res = await retryJob(db, id, actor, c.get("requestId") ?? null, deps.now());
    if (!res.ok) return problemFor(c, res.code, { detail: res.detail });
    return c.json({ id, status: res.status });
  });

  app.post(path("releaseRollback"), requireAdminRole, consoleSurface(deps), async (c) => {
    const user = deps.user(c)!;
    const decision = decide(user, "registry.release.rollback");
    if (!decision.allowed) return problemFor(c, "forbidden");
    const body = await readBody(c, RollbackSchema);
    if (!body.ok) return body.res;
    const db = deps.db(c);
    const identity = await loadCuratorIdentity(db, user);
    const actor = identity ? actorFor(identity.handle, true) : { kind: "admin" as const, ref: `admin:${user.publicId}` };
    const res = await rollbackRelease(db, deps.bucket(c), body.data.release, actor, c.get("requestId") ?? null, deps.now(), deps.log);
    if (!res.ok) return problemFor(c, res.code, { detail: res.detail });
    return c.json(res.pointer);
  });

  return app;
}
