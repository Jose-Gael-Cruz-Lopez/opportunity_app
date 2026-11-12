import type { Db, EventsDb } from "@server/db/client";
import { jobs } from "@server/db/repos";
import { Budget, TRIGGER_LIMITS } from "./budget";
import { jobsForTrigger, slotFor, type WorkerJobKind, type WorkerJobSpec } from "./registry";
import { errorClassOf, type JobHandler, type Logger, type RunTrigger, type Trigger, type WorkerBindings } from "./types";

/**
 * Runs one trigger's kinds in priority order inside the invocation budget. A failing kind is
 * recorded and the next kind still runs; nothing here throws to the caller.
 */

export type KindStatus = "ok" | "partial" | "deferred" | "failed" | "skipped_budget" | "skipped_done" | "not_implemented";

export interface KindReport {
  readonly kind: WorkerJobKind;
  readonly status: KindStatus;
  readonly processed: number;
}

export interface TriggerReport {
  readonly trigger: Trigger;
  readonly runTrigger: RunTrigger;
  readonly results: KindReport[];
}

export interface RunnerDeps {
  readonly env: WorkerBindings;
  readonly db: Db;
  readonly edb: EventsDb | null;
  readonly now: () => number;
  readonly log: Logger;
  readonly handlers: Partial<Record<WorkerJobKind, JobHandler>>;
  /** Lease owner for slot jobs, unique per invocation. */
  readonly owner: string;
  /** Instant that decides the hour/day slot (the cron's scheduled time when known). */
  readonly slotTime?: number;
  readonly limits?: { ms: number; calls: number };
}

const SLOT_LEASE_MS = 15 * 60_000;

async function runDrain(spec: WorkerJobSpec, handler: JobHandler, budget: Budget, runTrigger: RunTrigger, deps: RunnerDeps): Promise<KindReport> {
  const runId = await jobs.startJobRun(deps.db, { kind: spec.kind, trigger: runTrigger }, deps.now());
  budget.spend();
  try {
    const res = await handler({ env: deps.env, db: deps.db, edb: deps.edb, now: deps.now, budget, log: deps.log, trigger: runTrigger, slot: null });
    await jobs.finishJobRun(deps.db, runId, res.outcome, res.processed, deps.now());
    if (res.outcome !== "ok") deps.log("info", "job.carry_over", { kind: spec.kind, outcome: res.outcome, processed: res.processed });
    return { kind: spec.kind, status: res.outcome, processed: res.processed };
  } catch (err) {
    const errorClass = errorClassOf(err);
    deps.log("error", "job.failed", { kind: spec.kind, errorClass });
    await jobs.finishJobRun(deps.db, runId, "failed", 0, deps.now(), errorClass).catch(() => undefined);
    return { kind: spec.kind, status: "failed", processed: 0 };
  }
}

async function runSlot(spec: WorkerJobSpec, handler: JobHandler, budget: Budget, trigger: Trigger, runTrigger: RunTrigger, deps: RunnerDeps): Promise<KindReport> {
  const now = deps.now();
  const slot = slotFor(trigger, deps.slotTime ?? now) as string;
  // The slot row is the idempotency record: a duplicate or catch-up invocation finds it done.
  await jobs.enqueueJob(deps.db, { kind: spec.kind, idempotencyKey: `${spec.kind}:${slot}`, payload: { slot }, priority: spec.priority, maxAttempts: 5 }, now);
  const [job] = await jobs.leaseJobs(deps.db, { kinds: [spec.kind], max: 1, leaseMs: SLOT_LEASE_MS, owner: deps.owner, now });
  budget.spend(2);
  if (!job) return { kind: spec.kind, status: "skipped_done", processed: 0 };
  const jobSlot = typeof job.payload.slot === "string" ? job.payload.slot : slot;
  const runId = await jobs.startJobRun(deps.db, { kind: spec.kind, trigger: runTrigger, jobId: job.id }, now);
  try {
    const res = await handler({ env: deps.env, db: deps.db, edb: deps.edb, now: deps.now, budget, log: deps.log, trigger: runTrigger, slot: jobSlot });
    if (res.outcome === "deferred") await jobs.failJob(deps.db, job.id, deps.owner, "deferred", "defer", deps.now());
    else await jobs.completeJob(deps.db, job.id, deps.owner, deps.now());
    await jobs.finishJobRun(deps.db, runId, res.outcome, res.processed, deps.now());
    return { kind: spec.kind, status: res.outcome, processed: res.processed };
  } catch (err) {
    const errorClass = errorClassOf(err);
    const disposition = await jobs.failJob(deps.db, job.id, deps.owner, errorClass, "retry", deps.now()).catch(() => "not_leased" as const);
    deps.log(disposition === "dead" ? "alert" : "error", "job.failed", { kind: spec.kind, errorClass, disposition });
    await jobs.finishJobRun(deps.db, runId, "failed", 0, deps.now(), errorClass).catch(() => undefined);
    return { kind: spec.kind, status: "failed", processed: 0 };
  }
}

export async function runTrigger(trigger: Trigger, runTrigger: RunTrigger, deps: RunnerDeps): Promise<TriggerReport> {
  const budget = new Budget(deps.limits ?? TRIGGER_LIMITS[trigger], deps.now);
  const results: KindReport[] = [];
  for (const spec of jobsForTrigger(trigger)) {
    const handler = deps.handlers[spec.kind];
    if (!spec.implemented || !handler) {
      results.push({ kind: spec.kind, status: "not_implemented", processed: 0 });
      continue;
    }
    if (!budget.allows(3)) {
      results.push({ kind: spec.kind, status: "skipped_budget", processed: 0 });
      continue;
    }
    const share = budget.share(spec.share);
    try {
      results.push(spec.mode === "drain" ? await runDrain(spec, handler, share, runTrigger, deps) : await runSlot(spec, handler, share, trigger, runTrigger, deps));
    } catch (err) {
      // Bookkeeping itself failed (D1 down): record and move on to the next kind.
      deps.log("error", "job.runner_error", { kind: spec.kind, errorClass: errorClassOf(err) });
      results.push({ kind: spec.kind, status: "failed", processed: 0 });
    }
  }
  return { trigger, runTrigger, results };
}
