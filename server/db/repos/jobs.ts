import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Job, JobKind } from "../../../shared/contracts/ops";
import type { Db } from "../client";
import * as s from "../schema";
import { uuidv7 } from "../columns";
import { iso, isoOrNull } from "../util";

/**
 * The database is the queue (architecture 2.3.7). Leasing is one UPDATE ... RETURNING that takes
 * due or lease-expired jobs, at most one live lease per concurrency key, in priority order.
 * Payloads hold opaque ids only, never user-to-program pairs.
 */

type JobRow = typeof s.jobs.$inferSelect;

export function toJob(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind as JobKind,
    payload: row.payload,
    idempotencyKey: row.idempotencyKey,
    concurrencyKey: row.concurrencyKey,
    status: row.status as Job["status"],
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAfter: iso(row.runAfter),
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: isoOrNull(row.leaseExpiresAt),
    lastError: row.lastError,
    finishedAt: isoOrNull(row.finishedAt),
  };
}

export interface EnqueueInput {
  kind: JobKind;
  payload?: Record<string, unknown>;
  idempotencyKey: string;
  concurrencyKey?: string | null;
  priority?: number;
  maxAttempts?: number;
  runAfter?: number;
}

/** Inserts a job unless one with the same idempotency key exists; returns whether it was new. */
export async function enqueueJob(db: Db, input: EnqueueInput, now: number): Promise<{ id: string; created: boolean }> {
  const id = uuidv7(now);
  const inserted = await db
    .insert(s.jobs)
    .values({
      id,
      kind: input.kind,
      payload: input.payload ?? {},
      idempotencyKey: input.idempotencyKey,
      concurrencyKey: input.concurrencyKey ?? null,
      priority: input.priority ?? 5,
      maxAttempts: input.maxAttempts ?? 8,
      runAfter: input.runAfter ?? now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: s.jobs.id });
  if (inserted[0]) return { id: inserted[0].id, created: true };
  const existing = await db.query.jobs.findFirst({ where: eq(s.jobs.idempotencyKey, input.idempotencyKey), columns: { id: true } });
  return { id: existing?.id ?? id, created: false };
}

/**
 * Leases up to `max` jobs of the given kinds. A window function keeps one candidate per
 * concurrency key, and candidates whose key already has a live lease are skipped, so at most one
 * job per host runs at a time. Leasing counts an attempt (a crashed worker's lease expires and the
 * re-lease counts again); `deferJob` gives the attempt back.
 */
export async function leaseJobs(db: Db, opts: { kinds: readonly JobKind[]; max: number; leaseMs: number; owner: string; now: number }): Promise<Job[]> {
  const { kinds, max, leaseMs, owner, now } = opts;
  if (kinds.length === 0 || max < 1) return [];
  const rows = await db.all<Record<string, unknown>>(sql`
    UPDATE jobs SET status = 'leased', lease_owner = ${owner}, lease_expires_at = ${now + leaseMs},
      attempts = attempts + 1, updated_at = ${now}
    WHERE id IN (
      SELECT id FROM (
        SELECT j.id, j.priority, j.run_after,
          ROW_NUMBER() OVER (PARTITION BY coalesce(j.concurrency_key, j.id) ORDER BY j.priority, j.run_after, j.id) AS rn
        FROM jobs j
        WHERE j.kind IN (SELECT value FROM json_each(${JSON.stringify(kinds)}))
          AND ((j.status = 'pending' AND j.run_after <= ${now}) OR (j.status = 'leased' AND j.lease_expires_at <= ${now}))
          AND (j.concurrency_key IS NULL OR NOT EXISTS (
            SELECT 1 FROM jobs o WHERE o.concurrency_key = j.concurrency_key AND o.status = 'leased'
              AND o.lease_expires_at > ${now} AND o.id <> j.id))
      ) WHERE rn = 1
      ORDER BY priority, run_after
      LIMIT ${max}
    )
    RETURNING *`);
  return rows.map((r) => toJob(rowFromSql(r))).sort((a, b) => a.priority - b.priority || a.runAfter.localeCompare(b.runAfter));
}

/** Maps a raw snake_case row (from `RETURNING *`) to the Drizzle row shape. */
function rowFromSql(r: Record<string, unknown>): JobRow {
  const payload = typeof r.payload === "string" ? (JSON.parse(r.payload) as Record<string, unknown>) : ((r.payload as Record<string, unknown>) ?? {});
  return {
    id: r.id as string,
    kind: r.kind as string,
    payload,
    idempotencyKey: r.idempotency_key as string,
    concurrencyKey: (r.concurrency_key as string | null) ?? null,
    status: r.status as string,
    priority: Number(r.priority),
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    runAfter: Number(r.run_after),
    leaseOwner: (r.lease_owner as string | null) ?? null,
    leaseExpiresAt: r.lease_expires_at === null ? null : Number(r.lease_expires_at),
    lastError: (r.last_error as string | null) ?? null,
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const leasedBy = (id: string, owner: string) => and(eq(s.jobs.id, id), eq(s.jobs.status, "leased"), eq(s.jobs.leaseOwner, owner));

export async function completeJob(db: Db, id: string, owner: string, now: number): Promise<boolean> {
  const rows = await db
    .update(s.jobs)
    .set({ status: "done", finishedAt: now, leaseOwner: null, leaseExpiresAt: null, lastError: null, updatedAt: now })
    .where(leasedBy(id, owner))
    .returning({ id: s.jobs.id });
  return rows.length > 0;
}

/** min(60 s * 2^attempts, 24 h), jittered by +/-20% (`rand` in [0, 1)). */
export function retryDelayMs(attempts: number, rand: number): number {
  const base = Math.min(60_000 * 2 ** Math.max(0, attempts), 24 * 3_600_000);
  return Math.round(base * (0.8 + 0.4 * rand));
}

/**
 * retry: back off, or go dead after max attempts. defer: a dependency is down; try again in five
 * minutes without spending an attempt. dead: stop now.
 */
export async function failJob(
  db: Db,
  id: string,
  owner: string,
  errorClass: string,
  disposition: "retry" | "defer" | "dead",
  now: number,
  rand: number = Math.random(),
): Promise<"retrying" | "deferred" | "dead" | "not_leased"> {
  const job = await db.query.jobs.findFirst({ where: leasedBy(id, owner) });
  if (!job) return "not_leased";
  const lastError = errorClass.slice(0, 200);
  if (disposition === "defer") {
    await db
      .update(s.jobs)
      .set({ status: "pending", runAfter: now + 5 * 60_000, attempts: Math.max(0, job.attempts - 1), leaseOwner: null, leaseExpiresAt: null, lastError, updatedAt: now })
      .where(leasedBy(id, owner));
    return "deferred";
  }
  if (disposition === "dead" || job.attempts >= job.maxAttempts) {
    await db.update(s.jobs).set({ status: "dead", finishedAt: now, leaseOwner: null, leaseExpiresAt: null, lastError, updatedAt: now }).where(leasedBy(id, owner));
    return "dead";
  }
  await db
    .update(s.jobs)
    .set({ status: "pending", runAfter: now + retryDelayMs(job.attempts, rand), leaseOwner: null, leaseExpiresAt: null, lastError, updatedAt: now })
    .where(leasedBy(id, owner));
  return "retrying";
}

export async function getJob(db: Db, id: string): Promise<Job | null> {
  const row = await db.query.jobs.findFirst({ where: eq(s.jobs.id, id) });
  return row ? toJob(row) : null;
}

/** Oldest pending run per kind (the tick alerts when it exceeds the kind's max lateness). */
export async function oldestPendingByKind(db: Db) {
  return db
    .select({ kind: s.jobs.kind, oldestRunAfter: sql<number>`min(${s.jobs.runAfter})`, pending: sql<number>`count(*)` })
    .from(s.jobs)
    .where(eq(s.jobs.status, "pending"))
    .groupBy(s.jobs.kind);
}

/** Done jobs go after 14 days and dead jobs after 30. */
export async function sweepJobs(db: Db, now: number): Promise<void> {
  await db.batch([
    db.delete(s.jobRuns).where(sql`${s.jobRuns.jobId} IN (SELECT id FROM jobs WHERE (status = 'done' AND finished_at < ${now - 14 * 86_400_000}) OR (status = 'dead' AND finished_at < ${now - 30 * 86_400_000}))`),
    db.delete(s.jobs).where(and(eq(s.jobs.status, "done"), sql`${s.jobs.finishedAt} < ${now - 14 * 86_400_000}`)),
    db.delete(s.jobs).where(and(eq(s.jobs.status, "dead"), sql`${s.jobs.finishedAt} < ${now - 30 * 86_400_000}`)),
  ]);
}

// =============================================================================================
// Runs and heartbeats
// =============================================================================================

export async function startJobRun(
  db: Db,
  input: { kind: string; trigger: "tick" | "hourly" | "daily" | "lease" | "request" | "catch_up" | "manual"; jobId?: string | null },
  now: number,
): Promise<string> {
  const id = uuidv7(now);
  await db.insert(s.jobRuns).values({ id, kind: input.kind, trigger: input.trigger, jobId: input.jobId ?? null, startedAt: now });
  return id;
}

export async function finishJobRun(db: Db, runId: string, outcome: "ok" | "partial" | "failed" | "deferred", processed: number, now: number, errorClass?: string): Promise<void> {
  await db
    .update(s.jobRuns)
    .set({ outcome, processed, finishedAt: now, errorClass: errorClass ? errorClass.slice(0, 200) : null })
    .where(eq(s.jobRuns.id, runId));
}

export async function lastRuns(db: Db, kinds: readonly string[], limitPerKind = 1) {
  const rows = await db
    .select()
    .from(s.jobRuns)
    .where(inArray(s.jobRuns.kind, [...kinds]))
    .orderBy(asc(s.jobRuns.kind), desc(s.jobRuns.startedAt));
  const out = new Map<string, (typeof rows)[number][]>();
  for (const r of rows) {
    const list = out.get(r.kind) ?? [];
    if (list.length < limitPerKind) list.push(r);
    out.set(r.kind, list);
  }
  return out;
}

export async function heartbeat(db: Db, name: string, now: number, detail: Record<string, unknown> | null = null): Promise<void> {
  await db
    .insert(s.heartbeats)
    .values({ name, lastSeenAt: now, detail })
    .onConflictDoUpdate({ target: s.heartbeats.name, set: { lastSeenAt: now, detail } });
}

export async function getHeartbeat(db: Db, name: string) {
  return (await db.query.heartbeats.findFirst({ where: eq(s.heartbeats.name, name) })) ?? null;
}

// =============================================================================================
// Nonces and flags
// =============================================================================================

/** Records a request nonce; false means it was seen before (a replay). */
export async function useNonce(db: Db, nonce: string, keyId: string, expiresAt: number): Promise<boolean> {
  const rows = await db.insert(s.internalNonces).values({ nonce, keyId, expiresAt }).onConflictDoNothing().returning({ nonce: s.internalNonces.nonce });
  return rows.length > 0;
}

export async function sweepNonces(db: Db, now: number): Promise<void> {
  await db.delete(s.internalNonces).where(sql`${s.internalNonces.expiresAt} < ${now}`);
}

export async function getFlags(db: Db): Promise<Record<string, boolean>> {
  const rows = await db.select({ key: s.flags.key, enabled: s.flags.enabled }).from(s.flags);
  return Object.fromEntries(rows.map((r) => [r.key, r.enabled]));
}

export async function setFlag(db: Db, key: string, enabled: boolean, now: number, note?: string): Promise<void> {
  await db
    .insert(s.flags)
    .values({ key, enabled, note: note ?? null, updatedAt: now })
    .onConflictDoUpdate({ target: s.flags.key, set: { enabled, note: note ?? null, updatedAt: now } });
}
