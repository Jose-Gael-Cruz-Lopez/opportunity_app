import { getDb, getEventsDb } from "@server/db/client";
import { jobs } from "@server/db/repos";
import { randomHex } from "@server/internal/crypto";
import { HANDLERS } from "./handlers";
import { triggerForCron, type WorkerJobKind } from "./registry";
import { runTrigger, type TriggerReport } from "./runner";
import { consoleLogger, errorClassOf, type JobHandler, type Logger, type RunTrigger, type Trigger, type WorkerBindings } from "./types";
import { checkHealth } from "./watchdog";

/**
 * server/jobs: the D1 job table runner behind Worker Cron Triggers (the only clock, ADR-05).
 *
 *   export default { fetch, scheduled: runScheduled }   // server/worker.ts
 *
 * - `*\/5 * * * *` tick: notify.dispatch, alerts.match, sources.enqueue_due, then health checks.
 * - `0 * * * *` hourly and `0 8 * * *` daily: slot kinds, idempotent per hour or day.
 * - `catchUp` (POST /internal/v1/tick/catch-up) re-runs a trigger only when its last start is
 *   older than its period plus a margin, under the same idempotency keys.
 */

export const TRIGGER_HEARTBEAT: Readonly<Record<Trigger, string>> = {
  tick: "worker:tick",
  hourly: "worker:hourly",
  daily: "worker:daily",
};

/** How old a trigger's last start may be before catch-up runs it again. */
export const CATCH_UP_AFTER_MS: Readonly<Record<Trigger, number>> = {
  tick: 10 * 60_000,
  hourly: 70 * 60_000,
  daily: 25 * 3_600_000,
};

export interface InvocationOptions {
  readonly runTrigger?: RunTrigger;
  readonly now?: () => number;
  readonly slotTime?: number;
  readonly log?: Logger;
  readonly handlers?: Partial<Record<WorkerJobKind, JobHandler>>;
  readonly limits?: { ms: number; calls: number };
}

/** Runs one trigger end to end: start heartbeat, kinds, and (on ticks) the health checks. */
export async function runInvocation(trigger: Trigger, env: WorkerBindings, opts: InvocationOptions = {}): Promise<TriggerReport> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? consoleLogger;
  const runTrig = opts.runTrigger ?? trigger;
  const db = getDb(env.DB);
  const edb = env.EVENTS_DB ? getEventsDb(env.EVENTS_DB) : null;
  // `last_{trigger}_started_at`: written first, so catch-up sees a started run even if it dies.
  await jobs.heartbeat(db, TRIGGER_HEARTBEAT[trigger], now(), { runTrigger: runTrig });
  const report = await runTrigger(trigger, runTrig, {
    env,
    db,
    edb,
    now,
    log,
    handlers: opts.handlers ?? HANDLERS,
    owner: `worker:${trigger}:${randomHex(6)}`,
    slotTime: opts.slotTime,
    limits: opts.limits,
  });
  if (trigger === "tick") {
    await checkHealth(db, now(), log).catch((err) => log("error", "ops.health_check_failed", { errorClass: errorClassOf(err) }));
  }
  const failed = report.results.filter((r) => r.status === "failed").length;
  log(failed ? "warn" : "info", "jobs.invocation", { trigger, runTrigger: runTrig, kinds: report.results.length, failed });
  return report;
}

/** The Worker's `scheduled` handler. */
export async function runScheduled(controller: ScheduledController, env: WorkerBindings, ctx: ExecutionContext): Promise<void> {
  void ctx;
  const trigger = triggerForCron(controller.cron);
  if (!trigger) {
    consoleLogger("warn", "jobs.unknown_cron", { cron: controller.cron });
    return;
  }
  await runInvocation(trigger, env, { slotTime: controller.scheduledTime });
}

export interface CatchUpResult {
  readonly ran: Trigger[];
  readonly lastStarted: Partial<Record<Trigger, string | null>>;
  readonly reports: TriggerReport[];
}

/**
 * The catch-up watchdog. Cron Triggers carry no delivery guarantee, so Modal's drain calls this
 * before leasing; a trigger runs only when its last start is stale. Duplicates are harmless:
 * drain kinds write idempotent rows and slot kinds find their slot done.
 */
export async function catchUp(env: WorkerBindings, opts: { now?: () => number; log?: Logger; handlers?: InvocationOptions["handlers"] } = {}): Promise<CatchUpResult> {
  const now = opts.now ?? Date.now;
  const db = getDb(env.DB);
  const ran: Trigger[] = [];
  const reports: TriggerReport[] = [];
  const lastStarted: Partial<Record<Trigger, string | null>> = {};
  for (const trigger of ["tick", "hourly", "daily"] as const) {
    const hb = await jobs.getHeartbeat(db, TRIGGER_HEARTBEAT[trigger]);
    lastStarted[trigger] = hb ? new Date(hb.lastSeenAt).toISOString() : null;
    if (hb && now() - hb.lastSeenAt <= CATCH_UP_AFTER_MS[trigger]) continue;
    ran.push(trigger);
    reports.push(await runInvocation(trigger, env, { runTrigger: "catch_up", now, log: opts.log, handlers: opts.handlers }));
  }
  return { ran, lastStarted, reports };
}

export { Budget, TRIGGER_LIMITS } from "./budget";
export { HANDLERS } from "./handlers";
export { CRON_TRIGGERS, jobsForTrigger, maxLatenessFor, slotFor, triggerForCron, WORKER_JOBS, PIPELINE_MAX_LATENESS_MS, type WorkerJobSpec, type WorkerJobKind } from "./registry";
export { runTrigger, type KindReport, type KindStatus, type TriggerReport } from "./runner";
export { checkHealth, evaluateHealth, PIPELINE_HEARTBEAT, PIPELINE_STALE_MS, type OpsAlert } from "./watchdog";
export type { HandlerResult, JobContext, JobHandler, Logger, RunTrigger, Trigger, WorkerBindings } from "./types";
