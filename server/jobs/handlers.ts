import { events, jobs, notifications, registry, students } from "@server/db/repos";
import { runAuditDigest } from "@server/services/audit";
import { fanOutChangeEvents } from "@server/services/alerts";
import { dispatchNotifications, providerFor } from "@server/services/email";
import { buildRelease, releaseToBuild } from "@server/services/release";
import { bandsFit } from "./kinds/bands-fit";
import { digestSend } from "./kinds/digest-send";
import { outcomesQuality } from "./kinds/outcomes-quality";
import { remindersSchedule } from "./kinds/reminders-schedule";
import type { WorkerJobKind } from "./registry";
import type { HandlerResult, JobContext, JobHandler } from "./types";

/**
 * Worker job handlers. Each one does a bounded slice of work inside its budget share and returns;
 * leftover work waits for the next invocation. Kinds without a handler are registered but not run.
 */

const HOUR = 3_600_000;
/** Fallback re-check if a leased fetch never completes; a completed fetch sets the real time. */
export const FETCH_FALLBACK_RECHECK_MS = 6 * HOUR;
const SOURCES_PER_TICK = 25;

export async function notifyDispatch(ctx: JobContext): Promise<HandlerResult> {
  return dispatchNotifications({
    db: ctx.db,
    edb: ctx.edb,
    provider: providerFor(ctx.env, ctx.log),
    appOrigin: ctx.env.APP_ORIGIN ?? "http://localhost:8787",
    secret: ctx.env.BETTER_AUTH_SECRET ?? null,
    now: ctx.now,
    budget: ctx.budget,
    log: ctx.log,
  });
}

export async function alertsMatch(ctx: JobContext): Promise<HandlerResult> {
  return fanOutChangeEvents({ db: ctx.db, now: ctx.now, budget: ctx.budget, log: ctx.log });
}

/**
 * `sources.enqueue_due`: one `fetch` job per due Source, keyed `fetch:{sourceId}:{slot}` with the
 * host as concurrency key (one live lease per host). The payload carries public Source facts only.
 */
export async function enqueueDueSources(ctx: JobContext): Promise<HandlerResult> {
  const { db, budget } = ctx;
  if (!budget.allows(2)) return { processed: 0, outcome: "partial" };
  const now = ctx.now();
  const due = await registry.listDueSources(db, now, SOURCES_PER_TICK);
  budget.spend();
  let processed = 0;
  for (const src of due) {
    if (!budget.allows(2)) return { processed, outcome: "partial" };
    const slot = src.nextCheckAt ?? now;
    await jobs.enqueueJob(
      db,
      {
        kind: "fetch",
        idempotencyKey: `fetch:${src.id}:${slot}`,
        concurrencyKey: `host:${src.host}`,
        priority: 5,
        payload: { sourceId: src.id, url: src.url, kind: src.kind, approval: src.approval, programCycleId: null },
      },
      now,
    );
    // Push the due time forward so the same Sources do not fill every tick while the job waits.
    await registry.setSourceSchedule(db, src.id, now + FETCH_FALLBACK_RECHECK_MS, now);
    budget.spend(2);
    processed++;
  }
  return { processed, outcome: due.length === SOURCES_PER_TICK ? "partial" : "ok" };
}

/**
 * `sweep`: nonces, finished jobs, expired Notifications, unconfirmed Remind-me contacts and, on
 * `novus-events`, client crash counters older than 90 days.
 */
export async function sweep(ctx: JobContext): Promise<HandlerResult> {
  const now = ctx.now();
  await jobs.sweepNonces(ctx.db, now);
  await jobs.sweepJobs(ctx.db, now);
  await notifications.expireNotifications(ctx.db, now);
  await notifications.sweepExpiredContacts(ctx.db, now);
  let processed = 4;
  if (ctx.edb) {
    await events.sweepClientErrorDaily(ctx.edb, now);
    processed++;
  }
  ctx.budget.spend(processed);
  return { processed, outcome: "ok" };
}

export async function auditDigest(ctx: JobContext): Promise<HandlerResult> {
  return runAuditDigest({ db: ctx.db, store: ctx.env.STORE ?? null, now: ctx.now, budget: ctx.budget });
}

/**
 * `release.build` on the tick: builds the newest unpublished RegistryRelease (or the first one in
 * a fresh environment). The publish request is meant to start the build with waitUntil; the tick
 * finishes or retries it. Without the STORE binding there is nowhere to publish, so it defers.
 */
export async function releaseBuild(ctx: JobContext): Promise<HandlerResult> {
  const bucket = ctx.env.STORE;
  if (!bucket) return { processed: 0, outcome: "deferred" };
  if (!ctx.budget.allows(4)) return { processed: 0, outcome: "partial" };
  const n = await releaseToBuild(ctx.db, ctx.now(), ctx.log);
  ctx.budget.spend(2);
  if (n === null) return { processed: 0, outcome: "ok" };
  const result = await buildRelease(
    { db: ctx.db, bucket, now: ctx.now, origin: ctx.env.APP_ORIGIN ?? "http://localhost:8787", budget: ctx.budget, log: ctx.log },
    n,
  );
  if (result.status === "partial") return { processed: result.written, outcome: "partial", detail: { release: n, remaining: result.remaining } };
  return { processed: 1, outcome: "ok", detail: { release: n, status: result.status } };
}

/**
 * How long a deleted account can still be restored (the Settings page promises 48 hours). The
 * daily slot runs at 08:00 UTC, so every account is purged between 48 and 72 hours after the
 * request, inside the 72-hour promise in server/db/repos/students.ts.
 */
export const ACCOUNT_UNDO_WINDOW_MS = 48 * HOUR;
const PURGES_PER_RUN = 50;

/**
 * `deletion.process`: hard-deletes accounts soft-deleted before the undo window. Each purge is
 * one D1 batch, so a run stopped by the budget leaves whole accounts, never half-deleted ones.
 */
export async function deletionProcess(ctx: JobContext): Promise<HandlerResult> {
  if (!ctx.budget.allows(2)) return { processed: 0, outcome: "partial" };
  const due = await students.usersPendingPurge(ctx.db, ctx.now() - ACCOUNT_UNDO_WINDOW_MS, PURGES_PER_RUN);
  ctx.budget.spend();
  let processed = 0;
  for (const { id } of due) {
    if (!ctx.budget.allows(1)) return { processed, outcome: "partial" };
    await students.purgeUser(ctx.db, id);
    ctx.budget.spend();
    processed++;
  }
  // Counts only: the log never names an account.
  if (processed > 0) ctx.log("info", "accounts_purged", { count: processed });
  return { processed, outcome: due.length === PURGES_PER_RUN ? "partial" : "ok" };
}

export const HANDLERS: Partial<Record<WorkerJobKind, JobHandler>> = {
  "notify.dispatch": notifyDispatch,
  "alerts.match": alertsMatch,
  "sources.enqueue_due": enqueueDueSources,
  sweep,
  "audit.digest": auditDigest,
  "release.build": releaseBuild,
  "deletion.process": deletionProcess,
  "reminders.schedule": remindersSchedule,
  "digest.send": digestSend,
  "outcomes.quality": outcomesQuality,
  "bands.fit": bandsFit,
};
