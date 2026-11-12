import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "../client";
import { publishGuards } from "../schema";

/**
 * Helpers every repository uses. D1 has no interactive transactions: a multi-statement change is
 * one `batch()`, which rolls back as a unit only when a statement fails. Version checks therefore
 * go through a guard insert that fails (NOT NULL) when the version is stale (data model 3.2).
 */

export type Stmt = BatchItem<"sqlite">;

/** Runs statements as one D1 batch (one transaction); a no-op for an empty list. */
export async function runBatch(db: Db, statements: readonly Stmt[]): Promise<void> {
  if (statements.length === 0) return;
  await db.batch(statements as unknown as [Stmt, ...Stmt[]]);
}

export type VersionedTable = "program_cycles" | "programs" | "organizations" | "tracker_items" | "program_lists" | "student_profiles" | "outcomes";

const VERSIONED_KEY: Record<VersionedTable, string> = {
  program_cycles: "id",
  programs: "id",
  organizations: "id",
  tracker_items: "id",
  program_lists: "id",
  student_profiles: "user_id",
  outcomes: "id",
};

/**
 * The first statement of a guarded batch. A stale `version` makes `ok` NULL, the NOT NULL
 * constraint throws and the whole batch rolls back; a repeated `guardKey` fails on the primary
 * key, which callers report as "already applied".
 */
export function versionGuard(db: Db, guardKey: string, table: VersionedTable, id: string, version: number, now: number): Stmt {
  const keyColumn = VERSIONED_KEY[table];
  return db.insert(publishGuards).values({
    taskId: guardKey,
    ok: sql`(SELECT 1 FROM ${sql.identifier(table)} WHERE ${sql.identifier(keyColumn)} = ${id} AND version = ${version})`,
    appliedAt: now,
  });
}

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return `${err.message} ${cause instanceof Error ? cause.message : ""}`;
  }
  return String(err);
}

/** The guard's NOT NULL failure: the versioned row changed (or vanished) since it was read. */
export function isStaleVersion(err: unknown): boolean {
  return /NOT NULL constraint failed: publish_guards\.ok/i.test(messageOf(err));
}

/** The guard key was already used: this request or task was applied before. */
export function isAlreadyApplied(err: unknown): boolean {
  return /UNIQUE constraint failed: publish_guards\.task_id/i.test(messageOf(err));
}

export function isUniqueViolation(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(messageOf(err));
}

/** A guard trigger refused the row because no live consent covers the program. */
export function isConsentRequired(err: unknown): boolean {
  return /audience consent required/i.test(messageOf(err));
}

export type RepoError = "not_found" | "version_conflict" | "already_applied" | "conflict" | "consent_required" | "invalid";

export type RepoResult<T> = { ok: true; value: T } | { ok: false; error: RepoError; detail?: string };

export const ok = <T>(value: T): RepoResult<T> => ({ ok: true, value });
export const fail = <T = never>(error: RepoError, detail?: string): RepoResult<T> => ({ ok: false, error, detail });

/** Maps the expected database failures of a guarded write to a RepoResult; rethrows anything else. */
export function classifyWriteError<T>(err: unknown): RepoResult<T> {
  if (isStaleVersion(err)) return fail("version_conflict");
  if (isAlreadyApplied(err)) return fail("already_applied");
  if (isConsentRequired(err)) return fail("consent_required");
  if (isUniqueViolation(err)) return fail("conflict");
  throw err;
}

/** `WHERE id IN (SELECT value FROM json_each(?))`: one bound parameter for any number of ids. */
export function jsonIds(ids: readonly string[]) {
  return sql`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;
}
