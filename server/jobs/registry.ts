import type { PIPELINE_JOB_KINDS, WORKER_JOB_KINDS } from "@shared/contracts/ops";
import type { Trigger } from "./types";

/**
 * Worker job registry (architecture 2.3.7). The plan places this table in shared/jobs/registry.ts;
 * it lives here until that module exists because only the Worker reads it.
 *
 * - `mode: "drain"` kinds run on every invocation of their trigger and work through a backlog
 *   whose rows are idempotent (Alerts, Notifications, fetch jobs), so they need no job row.
 * - `mode: "slot"` kinds run once per hour or day: the runner enqueues `{kind}:{slot}` in the job
 *   table, so a duplicated or catch-up invocation finds the slot already done.
 * - `share` is the fraction of the invocation budget the kind may use.
 * - `maxLatenessMs` feeds the watchdog: a pending run older than this raises an ops alert.
 * - Kinds with `implemented: false` are registered for the watchdog and docs but not run yet.
 */

export type WorkerJobKind = (typeof WORKER_JOB_KINDS)[number];
export type PipelineJobKind = (typeof PIPELINE_JOB_KINDS)[number];

export interface WorkerJobSpec {
  readonly kind: WorkerJobKind;
  readonly trigger: Trigger;
  readonly mode: "drain" | "slot";
  /** Lower runs first within a trigger. */
  readonly priority: number;
  readonly share: number;
  readonly maxLatenessMs: number;
  readonly implemented: boolean;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export const WORKER_JOBS: readonly WorkerJobSpec[] = [
  // Tick: notify.dispatch first (already-queued mail before new fan-out), then alerts and fetches.
  { kind: "notify.dispatch", trigger: "tick", mode: "drain", priority: 0, share: 0.4, maxLatenessMs: 15 * MIN, implemented: true },
  { kind: "alerts.match", trigger: "tick", mode: "drain", priority: 1, share: 0.35, maxLatenessMs: 60 * MIN, implemented: true },
  { kind: "sources.enqueue_due", trigger: "tick", mode: "drain", priority: 2, share: 0.1, maxLatenessMs: 2 * HOUR, implemented: true },
  // Retries or finishes a release build (normally started by the publish request). Resumable, so
  // a small share only delays a large first release by a few ticks.
  { kind: "release.build", trigger: "tick", mode: "drain", priority: 3, share: 0.15, maxLatenessMs: 30 * MIN, implemented: true },
  // Hourly.
  { kind: "sweep", trigger: "hourly", mode: "slot", priority: 0, share: 0.3, maxLatenessMs: 3 * HOUR, implemented: true },
  { kind: "reminders.schedule", trigger: "hourly", mode: "slot", priority: 1, share: 0.3, maxLatenessMs: 2 * HOUR, implemented: true },
  { kind: "pipeline.hourly", trigger: "hourly", mode: "slot", priority: 2, share: 0.2, maxLatenessMs: 3 * HOUR, implemented: false },
  { kind: "cards.render", trigger: "hourly", mode: "slot", priority: 3, share: 0.2, maxLatenessMs: 6 * HOUR, implemented: false },
  { kind: "digest.send", trigger: "hourly", mode: "slot", priority: 4, share: 0.2, maxLatenessMs: 2 * HOUR, implemented: true },
  // Daily slot (08:00 UTC).
  { kind: "audit.digest", trigger: "daily", mode: "slot", priority: 0, share: 0.2, maxLatenessMs: 26 * HOUR, implemented: true },
  { kind: "deletion.process", trigger: "daily", mode: "slot", priority: 1, share: 0.2, maxLatenessMs: 26 * HOUR, implemented: true },
  { kind: "audit.draw", trigger: "daily", mode: "slot", priority: 2, share: 0.1, maxLatenessMs: 26 * HOUR, implemented: false },
  { kind: "eligibility.audience", trigger: "daily", mode: "slot", priority: 3, share: 0.1, maxLatenessMs: 26 * HOUR, implemented: false },
  { kind: "growth.daily", trigger: "daily", mode: "slot", priority: 4, share: 0.1, maxLatenessMs: 26 * HOUR, implemented: false },
  { kind: "growth.weekly", trigger: "daily", mode: "slot", priority: 5, share: 0.1, maxLatenessMs: 8 * 24 * HOUR, implemented: false },
  { kind: "registry.snapshot", trigger: "daily", mode: "slot", priority: 6, share: 0.1, maxLatenessMs: 26 * HOUR, implemented: false },
  { kind: "outcomes.quality", trigger: "daily", mode: "slot", priority: 7, share: 0.05, maxLatenessMs: 26 * HOUR, implemented: true },
  { kind: "aggregates.publish", trigger: "daily", mode: "slot", priority: 8, share: 0.05, maxLatenessMs: 26 * HOUR, implemented: false },
  // Monthly in effect: the handler fits only when the daily slot is the 1st (or on a manual run).
  { kind: "bands.fit", trigger: "daily", mode: "slot", priority: 9, share: 0.1, maxLatenessMs: 35 * 24 * HOUR, implemented: true },
];

/** Pipeline (Modal) kinds: how late a pending job may be before the watchdog alerts. */
export const PIPELINE_MAX_LATENESS_MS: Readonly<Record<PipelineJobKind, number>> = {
  curate_import: 26 * HOUR,
  fetch: 2 * HOUR,
  nsf_sync: 26 * HOUR,
  list_sync: 26 * HOUR,
  rollover: 26 * HOUR,
  predict_cycles: 26 * HOUR,
  llm: 6 * HOUR,
  llm_collect: 26 * HOUR,
  eval_run: 7 * 24 * HOUR,
  docintel_ocr_hint: 26 * HOUR,
  docintel_eval: 7 * 24 * HOUR,
  mirror_export: 26 * HOUR,
  backup_copy: 26 * HOUR,
};

export function jobsForTrigger(trigger: Trigger): WorkerJobSpec[] {
  return WORKER_JOBS.filter((j) => j.trigger === trigger).sort((a, b) => a.priority - b.priority);
}

export function maxLatenessFor(kind: string): number | null {
  const worker = WORKER_JOBS.find((j) => j.kind === kind);
  if (worker) return worker.maxLatenessMs;
  return (PIPELINE_MAX_LATENESS_MS as Record<string, number>)[kind] ?? null;
}

/** The cron strings in infra/wrangler/wrangler.toml, mapped to triggers. */
export const CRON_TRIGGERS: Readonly<Record<string, Trigger>> = {
  "*/5 * * * *": "tick",
  "0 * * * *": "hourly",
  "0 8 * * *": "daily",
};

export function triggerForCron(cron: string): Trigger | null {
  return CRON_TRIGGERS[cron.trim()] ?? null;
}

/** The idempotency slot for a slot-mode kind: the UTC hour or date the invocation belongs to. */
export function slotFor(trigger: Trigger, nowMs: number): string | null {
  const isoText = new Date(nowMs).toISOString();
  if (trigger === "hourly") return isoText.slice(0, 13);
  if (trigger === "daily") return isoText.slice(0, 10);
  return null;
}
