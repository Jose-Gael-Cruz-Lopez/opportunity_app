import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { WORKER_JOB_KINDS, type Actor } from "@shared/contracts/ops";
import type { Db } from "@server/db/client";
import * as s from "@server/db/schema";
import { jobs as jobsRepo, runBatch } from "@server/db/repos";
import { iso, isoOrNull } from "@server/db/util";
import { opsAudit } from "./audit";

/**
 * The ops pipeline view (plan 02 ops page, runbook 14.2): job queue depth and lateness by kind,
 * failures with their error class, the last run of each Worker kind, heartbeats of the clocks,
 * the review queue's SLA state and recent releases. Payload VALUES never leave the server: a job
 * is shown with its kind, ids, attempts and error class, and the names of its payload keys.
 */

export const HEARTBEAT_STALE_MS = 15 * 60_000;
const FAILURE_LIMIT = 50;

export interface OpsPipelineView {
  generatedAt: string;
  queues: { kind: string; pending: number; leased: number; dead: number; oldestPendingRunAfter: string | null; lateMinutes: number }[];
  failures: {
    id: string;
    kind: string;
    status: string;
    attempts: number;
    maxAttempts: number;
    lastError: string | null;
    runAfter: string;
    finishedAt: string | null;
    payloadKeys: string[];
    retryable: boolean;
  }[];
  lastRuns: { kind: string; startedAt: string; finishedAt: string | null; outcome: string | null; processed: number; errorClass: string | null }[];
  heartbeats: { name: string; lastSeenAt: string; stale: boolean }[];
  review: { open: number; overdue: number; secondReview: number; escalated: number; claimed: number; appliedLast24h: number; medianActiveSeconds: number | null };
  releases: { number: number; state: string; createdAt: string; builtAt: string | null; publishedAt: string | null; containsSample: boolean; canRollBackTo: boolean }[];
  currentRelease: number | null;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** A failed job a person may retry: dead, or pending after at least one failed attempt. */
export function isRetryable(job: { status: string; attempts: number; lastError: string | null }): boolean {
  return job.status === "dead" || (job.status === "pending" && job.attempts > 0 && job.lastError !== null);
}

export async function opsPipeline(db: Db, now: number): Promise<OpsPipelineView> {
  const grouped = await db
    .select({ kind: s.jobs.kind, status: s.jobs.status, n: sql<number>`count(*)`, oldest: sql<number | null>`min(${s.jobs.runAfter})` })
    .from(s.jobs)
    .where(inArray(s.jobs.status, ["pending", "leased", "dead"]))
    .groupBy(s.jobs.kind, s.jobs.status);
  const queues = new Map<string, OpsPipelineView["queues"][number]>();
  for (const g of grouped) {
    const q = queues.get(g.kind) ?? { kind: g.kind, pending: 0, leased: 0, dead: 0, oldestPendingRunAfter: null, lateMinutes: 0 };
    const n = Number(g.n);
    if (g.status === "pending") {
      q.pending = n;
      q.oldestPendingRunAfter = isoOrNull(g.oldest === null ? null : Number(g.oldest));
      q.lateMinutes = g.oldest === null ? 0 : Math.max(0, Math.floor((now - Number(g.oldest)) / 60_000));
    } else if (g.status === "leased") q.leased = n;
    else if (g.status === "dead") q.dead = n;
    queues.set(g.kind, q);
  }

  const failed = await db
    .select()
    .from(s.jobs)
    .where(or(eq(s.jobs.status, "dead"), and(eq(s.jobs.status, "pending"), isNotNull(s.jobs.lastError), sql`${s.jobs.attempts} > 0`)))
    .orderBy(desc(s.jobs.updatedAt))
    .limit(FAILURE_LIMIT);

  const runs = await jobsRepo.lastRuns(db, [...WORKER_JOB_KINDS], 1);
  const lastRuns = [...runs.values()].flat().map((r) => ({
    kind: r.kind,
    startedAt: iso(r.startedAt),
    finishedAt: isoOrNull(r.finishedAt),
    outcome: r.outcome,
    processed: r.processed,
    errorClass: r.errorClass,
  }));

  const beats = await db.select().from(s.heartbeats);

  const reviewCounts = await db
    .select({ state: s.reviewTasks.state, n: sql<number>`count(*)`, overdue: sql<number>`sum(CASE WHEN ${s.reviewTasks.dueAt} < ${now} THEN 1 ELSE 0 END)` })
    .from(s.reviewTasks)
    .where(inArray(s.reviewTasks.state, ["open", "claimed", "second_review", "escalated", "snoozed"]))
    .groupBy(s.reviewTasks.state);
  const count = (state: string) => Number(reviewCounts.find((r) => r.state === state)?.n ?? 0);
  const overdue = reviewCounts.reduce((sum, r) => sum + Number(r.overdue ?? 0), 0);
  const applied = await db
    .select({ seconds: s.reviewTasks.activeSeconds })
    .from(s.reviewTasks)
    .where(and(eq(s.reviewTasks.state, "applied"), sql`${s.reviewTasks.resolvedAt} >= ${now - 86_400_000}`));

  const releaseRows = await db.select().from(s.registryReleases).orderBy(desc(s.registryReleases.number)).limit(12);
  const current = releaseRows.find((r) => r.state === "published")?.number ?? null;

  return {
    generatedAt: iso(now),
    queues: [...queues.values()].sort((a, b) => b.lateMinutes - a.lateMinutes || a.kind.localeCompare(b.kind)),
    failures: failed.map((j) => ({
      id: j.id,
      kind: j.kind,
      status: j.status,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      lastError: j.lastError,
      runAfter: iso(j.runAfter),
      finishedAt: isoOrNull(j.finishedAt),
      payloadKeys: Object.keys(j.payload).slice(0, 20),
      retryable: isRetryable(j),
    })),
    lastRuns,
    heartbeats: beats.map((b) => ({ name: b.name, lastSeenAt: iso(b.lastSeenAt), stale: now - b.lastSeenAt > HEARTBEAT_STALE_MS })),
    review: {
      open: count("open"),
      overdue,
      secondReview: count("second_review"),
      escalated: count("escalated"),
      claimed: count("claimed"),
      appliedLast24h: applied.length,
      medianActiveSeconds: median(applied.map((a) => a.seconds)),
    },
    releases: releaseRows.map((r) => ({
      number: r.number,
      state: r.state,
      createdAt: iso(r.createdAt),
      builtAt: isoOrNull(r.builtAt),
      publishedAt: isoOrNull(r.publishedAt),
      containsSample: r.containsSample,
      canRollBackTo: current !== null && r.number < current && r.clientCoreKey !== null && r.sha256 !== null && r.builtAt !== null,
    })),
    currentRelease: current,
  };
}

export type RetryOutcome = { ok: true; status: "pending" } | { ok: false; code: "not_found" | "conflict"; detail: string };

/**
 * Puts a failed job back in the queue now with a fresh attempt budget. Only dead jobs and pending
 * jobs that already failed qualify; a leased job belongs to its worker.
 */
export async function retryJob(db: Db, jobId: string, actor: Actor, requestId: string | null, now: number): Promise<RetryOutcome> {
  const job = await db.query.jobs.findFirst({ where: eq(s.jobs.id, jobId) });
  if (!job) return { ok: false, code: "not_found", detail: "No such job." };
  if (!isRetryable(job)) return { ok: false, code: "conflict", detail: "Only dead jobs, or jobs waiting after a failure, can be retried." };
  const res = await db
    .update(s.jobs)
    .set({ status: "pending", attempts: 0, runAfter: now, finishedAt: null, leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
    .where(and(eq(s.jobs.id, jobId), eq(s.jobs.updatedAt, job.updatedAt)))
    .returning({ id: s.jobs.id });
  if (res.length === 0) return { ok: false, code: "conflict", detail: "The job changed meanwhile. Reload." };
  await runBatch(db, [opsAudit(db, { actor, action: "job_retry", fields: ["status", "attempts", "run_after"], subjectKey: `job:${jobId}`, requestId, now })]);
  return { ok: true, status: "pending" };
}
