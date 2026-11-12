import { PIPELINE_JOB_KINDS } from "@shared/contracts/ops";
import type { Db } from "@server/db/client";
import { jobs } from "@server/db/repos";
import { maxLatenessFor } from "./registry";
import type { Logger } from "./types";

/**
 * Tick health checks (architecture 2.3.7): alert when the pipeline's heartbeat is 30 minutes
 * stale while its jobs wait, or when any kind's oldest pending run exceeds its max lateness.
 * Alerts are structured `alert` log lines for Workers observability (and Sentry once wired).
 */

export const PIPELINE_HEARTBEAT = "pipeline";
export const PIPELINE_STALE_MS = 30 * 60_000;

export interface PendingKind {
  readonly kind: string;
  readonly oldestRunAfter: number;
  readonly pending: number;
}

export interface OpsAlert {
  readonly code: "job_late" | "pipeline_heartbeat_stale";
  readonly kind: string | null;
  readonly lateByMs: number;
}

/** Pure evaluation, so the thresholds are testable without a database. */
export function evaluateHealth(input: { pending: readonly PendingKind[]; pipelineSeenAt: number | null; now: number }): OpsAlert[] {
  const alerts: OpsAlert[] = [];
  let pipelineWaiting = false;
  for (const p of input.pending) {
    if ((PIPELINE_JOB_KINDS as readonly string[]).includes(p.kind) && p.oldestRunAfter <= input.now) pipelineWaiting = true;
    const max = maxLatenessFor(p.kind);
    const late = input.now - p.oldestRunAfter;
    if (max !== null && late > max) alerts.push({ code: "job_late", kind: p.kind, lateByMs: late - max });
  }
  if (pipelineWaiting) {
    const age = input.pipelineSeenAt === null ? Infinity : input.now - input.pipelineSeenAt;
    if (age > PIPELINE_STALE_MS) alerts.push({ code: "pipeline_heartbeat_stale", kind: null, lateByMs: Number.isFinite(age) ? age - PIPELINE_STALE_MS : -1 });
  }
  return alerts;
}

export async function checkHealth(db: Db, now: number, log: Logger): Promise<OpsAlert[]> {
  const pending = await jobs.oldestPendingByKind(db);
  const hb = await jobs.getHeartbeat(db, PIPELINE_HEARTBEAT);
  const alerts = evaluateHealth({
    pending: pending.map((p) => ({ kind: p.kind, oldestRunAfter: Number(p.oldestRunAfter), pending: Number(p.pending) })),
    pipelineSeenAt: hb?.lastSeenAt ?? null,
    now,
  });
  for (const a of alerts) log("alert", `ops.${a.code}`, { kind: a.kind, lateByMs: a.lateByMs });
  return alerts;
}
