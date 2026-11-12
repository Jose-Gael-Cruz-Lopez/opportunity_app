import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { CreateReviewTaskInputSchema, type CreateReviewTaskInput, type ReviewTask } from "../../../shared/contracts/ops";
import type { Db } from "../client";
import * as s from "../schema";
import { LIVE_REVIEW_STATES } from "../schema";
import { uuidv7 } from "../columns";
import { isoOrNull, iso, msOrNull } from "../util";
import { fail, isUniqueViolation, ok, type RepoResult } from "./common";

/**
 * ReviewTasks: one call creates every task. It upserts on `{kind}:{subjectType}:{subjectId}`
 * among live tasks, merging reason codes and evidence and keeping the higher priority and the
 * earlier due time (data model 3.8).
 */

type TaskRow = typeof s.reviewTasks.$inferSelect;

export function dedupeKey(input: Pick<CreateReviewTaskInput, "kind" | "subject">): string {
  return `${input.kind}:${input.subject.type}:${input.subject.id}`;
}

function union(a: readonly string[], b: readonly string[], max: number): string[] {
  return [...new Set([...a, ...b])].slice(0, max);
}

/** Pure merge of a new request into a live task. Lower number = higher priority. */
export function mergeTask(
  existing: Pick<TaskRow, "reasonCodes" | "evidenceIds" | "priority" | "dueAt">,
  input: { reasonCodes: readonly string[]; evidence: readonly string[]; priority: number; dueAt: number | null },
) {
  const dueAt = existing.dueAt === null ? input.dueAt : input.dueAt === null ? existing.dueAt : Math.min(existing.dueAt, input.dueAt);
  return {
    reasonCodes: union(existing.reasonCodes, input.reasonCodes, 20),
    evidenceIds: union(existing.evidenceIds, input.evidence, 50),
    priority: Math.min(existing.priority, input.priority),
    dueAt,
  };
}

export function toReviewTask(row: TaskRow, handles: ReadonlyMap<string, string>): ReviewTask {
  return {
    id: row.id,
    kind: row.kind as ReviewTask["kind"],
    subject: { type: row.subjectType as ReviewTask["subject"]["type"], id: row.subjectId },
    dedupeKey: row.dedupeKey,
    reasonCodes: row.reasonCodes as ReviewTask["reasonCodes"],
    evidenceIds: row.evidenceIds,
    priority: row.priority,
    state: row.state as ReviewTask["state"],
    dueAt: isoOrNull(row.dueAt),
    claimedBy: row.claimedBy ? (handles.get(row.claimedBy) ?? null) : null,
    claimExpiresAt: isoOrNull(row.claimExpiresAt),
    payload: row.payload,
    resolution: row.resolution,
    activeSeconds: row.activeSeconds,
    createdAt: iso(row.createdAt),
  };
}

async function findLive(db: Db, key: string): Promise<TaskRow | undefined> {
  return db.query.reviewTasks.findFirst({
    where: and(eq(s.reviewTasks.dedupeKey, key), inArray(s.reviewTasks.state, [...LIVE_REVIEW_STATES])),
  });
}

export async function createReviewTask(
  db: Db,
  rawInput: CreateReviewTaskInput,
  now: number,
  payload: Record<string, unknown> = {},
): Promise<RepoResult<{ id: string; created: boolean }>> {
  const parsed = CreateReviewTaskInputSchema.safeParse(rawInput);
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const input = parsed.data;
  const key = dedupeKey(input);
  const incoming = { reasonCodes: input.reasonCodes, evidence: input.evidence, priority: input.priority, dueAt: msOrNull(input.dueAt) };

  // Two attempts: a concurrent insert of the same live key loses on the partial unique index.
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await findLive(db, key);
    if (existing) {
      const merged = mergeTask(existing, incoming);
      await db
        .update(s.reviewTasks)
        .set({ ...merged, payload: { ...existing.payload, ...payload }, updatedAt: now })
        .where(eq(s.reviewTasks.id, existing.id));
      return ok({ id: existing.id, created: false });
    }
    try {
      const id = uuidv7(now);
      await db.insert(s.reviewTasks).values({
        id,
        kind: input.kind,
        subjectType: input.subject.type,
        subjectId: input.subject.id,
        dedupeKey: key,
        reasonCodes: [...input.reasonCodes],
        evidenceIds: [...input.evidence],
        priority: input.priority,
        dueAt: incoming.dueAt,
        payload,
        createdAt: now,
        updatedAt: now,
      });
      return ok({ id, created: true });
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === 1) throw err;
    }
  }
  return fail("conflict");
}

/** Open tasks in priority order, then due time (claimable now: open, or claimed with an expired lease). */
export async function listReviewQueue(db: Db, now: number, limit = 50, kinds?: readonly string[]) {
  return db
    .select()
    .from(s.reviewTasks)
    .where(
      and(
        sql`(${s.reviewTasks.state} IN ('open', 'second_review') OR (${s.reviewTasks.state} = 'claimed' AND ${s.reviewTasks.claimExpiresAt} <= ${now}))`,
        kinds && kinds.length ? inArray(s.reviewTasks.kind, [...kinds]) : sql`1 = 1`,
      ),
    )
    .orderBy(asc(s.reviewTasks.priority), sql`${s.reviewTasks.dueAt} IS NULL`, asc(s.reviewTasks.dueAt), asc(s.reviewTasks.createdAt))
    .limit(limit);
}

/** Claims a task under a 15-minute lease; fails when someone else holds a live claim. */
export async function claimReviewTask(db: Db, taskId: string, curatorId: string, now: number, leaseMs = 15 * 60_000): Promise<RepoResult<true>> {
  const rows = await db
    .update(s.reviewTasks)
    .set({ state: "claimed", claimedBy: curatorId, claimExpiresAt: now + leaseMs, updatedAt: now })
    .where(
      and(
        eq(s.reviewTasks.id, taskId),
        sql`(${s.reviewTasks.state} IN ('open', 'second_review', 'snoozed') OR (${s.reviewTasks.state} = 'claimed' AND (${s.reviewTasks.claimExpiresAt} <= ${now} OR ${s.reviewTasks.claimedBy} = ${curatorId})))`,
      ),
    )
    .returning({ id: s.reviewTasks.id });
  return rows.length > 0 ? ok(true) : fail("conflict");
}

const DECISION_STATE = { approve: "approved", reject: "rejected", snooze: "snoozed", escalate: "escalated" } as const;

export async function resolveReviewTask(
  db: Db,
  taskId: string,
  curatorId: string,
  decision: keyof typeof DECISION_STATE,
  resolution: string,
  now: number,
  activeSeconds = 0,
): Promise<RepoResult<true>> {
  const state = DECISION_STATE[decision];
  const rows = await db
    .update(s.reviewTasks)
    .set({
      state,
      resolution: resolution.slice(0, 500),
      resolvedAt: decision === "approve" || decision === "reject" ? now : null,
      claimExpiresAt: null,
      activeSeconds: sql`${s.reviewTasks.activeSeconds} + ${Math.max(0, Math.round(activeSeconds))}`,
      updatedAt: now,
    })
    .where(and(eq(s.reviewTasks.id, taskId), eq(s.reviewTasks.state, "claimed"), eq(s.reviewTasks.claimedBy, curatorId)))
    .returning({ id: s.reviewTasks.id });
  return rows.length > 0 ? ok(true) : fail("conflict", "task is not claimed by this curator");
}

/** After a publish batch: approved -> applied, or apply_failed (stale version). */
export async function markTaskApplied(db: Db, taskId: string, applied: boolean, now: number): Promise<void> {
  await db
    .update(s.reviewTasks)
    .set({ state: applied ? "applied" : "apply_failed", updatedAt: now })
    .where(and(eq(s.reviewTasks.id, taskId), eq(s.reviewTasks.state, "approved")));
}
