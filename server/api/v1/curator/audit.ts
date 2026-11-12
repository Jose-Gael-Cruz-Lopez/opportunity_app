import { eq, sql, type SQL } from "drizzle-orm";
import type { Actor } from "@shared/contracts/ops";
import type { EvidenceEntity } from "@shared/taxonomy";
import type { Db } from "@server/db/client";
import { reviewTasks } from "@server/db/schema";
import { audit, type Stmt } from "@server/db/repos";
import { accessStatement } from "@server/services/audit";

/**
 * Every Curator action goes through the AuditLog service (server/services/audit, plan 09 9.11):
 *
 * - Task actions (claim, release, approve, second approval, reject, snooze, escalate, recheck,
 *   official link opened) are registry_audit rows on the task's subject, field
 *   `review_task.{action}`, with the task id. They join the batch of the change they record, so
 *   an action and its audit row commit or roll back together, and the daily digest chain covers
 *   them. Field changes a publish makes are separate registry_audit rows with before and after.
 * - Ops actions (job retry, release rollback) touch no registry entity, so they are access_audit
 *   rows: action `update`, purpose `console.{action}`, field names only, and a subject key that
 *   names the job or release (`job:{id}`, `release:{n}`), never a person.
 */

export type TaskAction =
  | "claim"
  | "release"
  | "approve"
  | "first_approval"
  | "reject"
  | "snooze"
  | "escalate"
  | "recheck"
  | "official_link_opened"
  | "apply_failed";

export function actorFor(handle: string, isAdmin: boolean): Actor {
  return { kind: isAdmin ? "admin" : "curator", ref: handle.slice(0, 120) };
}

export interface TaskRef {
  id: string;
  subjectType: string;
  subjectId: string;
}

export function taskAudit(
  db: Db,
  input: { task: TaskRef; actor: Actor; action: TaskAction; before: unknown; after: unknown; now: number; snapshotIds?: readonly string[] },
): Stmt {
  return audit.registryAuditInsert(db, {
    at: input.now,
    actor: input.actor,
    entityType: input.task.subjectType as EvidenceEntity,
    entityId: input.task.subjectId,
    field: `review_task.${input.action}`,
    before: input.before,
    after: input.after,
    taskId: input.task.id,
    snapshotIds: input.snapshotIds ?? [],
  });
}

export function opsAudit(
  db: Db,
  input: { actor: Actor; action: "job_retry" | "release_rollback"; fields: readonly string[]; subjectKey: string; requestId: string | null; now: number },
): Stmt {
  return accessStatement(db, {
    at: input.now,
    actor: input.actor,
    action: "update",
    purpose: `console.${input.action}`,
    fields: input.fields,
    subjectKey: input.subjectKey,
    requestId: input.requestId,
  });
}

/** Error text the batch assertions raise (SQLite's json() on a non-JSON string). */
const ASSERTION_RE = /malformed JSON/i;

/**
 * A statement that throws, rolling its whole batch back, unless `condition` holds for the task
 * row. D1 has no interactive transactions and an UPDATE that matches nothing does not throw, so
 * without this an audit row (or a publish) could commit for a claim that expired a moment
 * earlier. `json('assertion_failed')` is the throw: SQLite raises "malformed JSON" for it, and
 * RAISE() works only inside triggers. It is a SELECT over the task's own row (which always
 * exists), built with the query builder because drizzle's D1 batch cannot bind raw `db.run` SQL.
 */
function assertion(db: Db, taskId: string, condition: SQL): Stmt {
  return db
    .select({ ok: sql<string>`json(CASE WHEN ${condition} THEN '1' ELSE 'assertion_failed' END)` })
    .from(reviewTasks)
    .where(eq(reviewTasks.id, taskId));
}

/** First statement of every task-changing batch: `curatorId` holds a live claim on the task. */
export function assertClaimHeld(db: Db, taskId: string, curatorId: string, now: number): Stmt {
  return assertion(db, taskId, sql`${reviewTasks.state} = 'claimed' AND ${reviewTasks.claimedBy} = ${curatorId} AND ${reviewTasks.claimExpiresAt} > ${now}`);
}

/** Optimistic lock for a claim: the task row is exactly as it was read (same `updated_at`). */
export function assertTaskUnchanged(db: Db, taskId: string, updatedAt: number): Stmt {
  return assertion(db, taskId, sql`${reviewTasks.updatedAt} = ${updatedAt}`);
}

/** True when a batch failed on one of the assertions above (the task moved underneath). */
export function isAssertionFailure(err: unknown): boolean {
  const parts: string[] = [];
  let e: unknown = err;
  for (let i = 0; i < 3 && e; i++) {
    parts.push(e instanceof Error ? e.message : String(e));
    e = e instanceof Error ? (e as Error & { cause?: unknown }).cause : undefined;
  }
  return ASSERTION_RE.test(parts.join(" "));
}
