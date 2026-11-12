import type { Actor } from "@shared/contracts/ops";
import { isSensitiveKey } from "@shared/contracts/sensitive";
import type { Db } from "@server/db/client";
import { audit, type Stmt } from "@server/db/repos";
import type { AccessAuditInput } from "@server/db/repos/audit";
import { canonicalJson } from "@server/db/util";
import type { Budget } from "@server/jobs/budget";
import type { HandlerResult } from "@server/jobs/types";
import { deriveSubkey, hmacSha256Hex, sha256Hex } from "@server/internal/crypto";

/**
 * The AuditLog writer (plan 09 9.11, data model: two tables).
 * - registry_audit: before/after values of public registry fields. Repos already add these rows
 *   to their publish batches; `registryChanges` helps other writers build them the same way.
 * - access_audit: who touched which fields of whose personal data: field NAMES and a
 *   pseudonymous subject key, never values, emails or names.
 * - audit.digest: a daily SHA-256 chain over registry_audit rows, written to R2 `ledger/audit/`,
 *   so a later edit of history (which the append-only trigger already refuses) is detectable.
 */

export const actorForInternalKey = (keyId: string): Actor => ({ kind: "pipeline", ref: `key:${keyId}`.slice(0, 120) });
export const actorForJob = (kind: string): Actor => ({ kind: "system", ref: `system:${kind}`.slice(0, 120) });

/**
 * A stable pseudonym for a user in access_audit: HMAC of the user id under a sub-key of the root
 * secret. The student's own audit view recomputes it; on deletion it becomes a tombstone.
 */
export async function subjectKeyFor(secret: string, userId: string): Promise<string> {
  const key = await deriveSubkey(secret, "audit-subject-v1");
  return `s1:${(await hmacSha256Hex(key, userId)).slice(0, 40)}`;
}

const FIELD_NAME_RE = /^[A-Za-z][A-Za-z0-9_.]{0,79}$/;

export class AuditFieldError extends Error {
  override name = "AuditFieldError";
}

/**
 * Field lists must be names: identifier-shaped, and never a sensitive status or identity key
 * (those never reach the server, so naming one in an audit row would itself be a leak signal).
 */
export function assertFieldNames(fields: readonly string[]): void {
  for (const f of fields) {
    if (!FIELD_NAME_RE.test(f)) throw new AuditFieldError("audit field must be a field name");
    if (isSensitiveKey(f.split(".").pop() ?? f)) throw new AuditFieldError("audit field names a sensitive key");
  }
}

export function accessStatement(db: Db, entry: AccessAuditInput): Stmt {
  assertFieldNames(entry.fields);
  return audit.accessAuditInsert(db, entry);
}

export async function recordAccess(db: Db, entry: AccessAuditInput): Promise<void> {
  assertFieldNames(entry.fields);
  await audit.appendAccessAudit(db, entry);
}

/** Changed fields between two registry records, as before/after pairs (canonical comparison). */
export function registryChanges<T extends Record<string, unknown>>(before: T | null, after: T, fields: readonly (keyof T & string)[]) {
  const out: { field: string; before: unknown; after: unknown }[] = [];
  for (const field of fields) {
    const b = before ? before[field] : undefined;
    const a = after[field];
    if (canonicalJson(b ?? null) !== canonicalJson(a ?? null)) out.push({ field, before: b ?? null, after: a ?? null });
  }
  return out;
}

// =============================================================================================
// Digest chain
// =============================================================================================

export interface DigestHead {
  readonly lastRowId: number;
  readonly hash: string;
  readonly at: string;
}

export interface DigestRecord {
  readonly v: 1;
  readonly fromRowId: number;
  readonly toRowId: number;
  readonly count: number;
  readonly rowsSha256: string;
  readonly prevHash: string;
  readonly hash: string;
  readonly at: string;
}

export const GENESIS_HASH = "0".repeat(64);
export const DIGEST_HEAD_KEY = "ledger/audit/HEAD.json";

/** Hashes rows in rowid order and chains the result to the previous digest. Pure. */
export async function buildDigest(rows: readonly { rowid: number; row: unknown }[], prevHash: string, atIso: string): Promise<DigestRecord> {
  const sorted = [...rows].sort((a, b) => a.rowid - b.rowid);
  const lines = sorted.map((r) => `${r.rowid}\t${canonicalJson(r.row)}`).join("\n");
  const rowsSha256 = await sha256Hex(lines);
  const hash = await sha256Hex(`${prevHash}\n${rowsSha256}\n${sorted.length}`);
  return {
    v: 1,
    fromRowId: sorted[0]?.rowid ?? 0,
    toRowId: sorted[sorted.length - 1]?.rowid ?? 0,
    count: sorted.length,
    rowsSha256,
    prevHash,
    hash,
    at: atIso,
  };
}

/** Recomputes a chain segment; false means rows or the chain were altered. */
export async function verifyDigest(record: DigestRecord, rows: readonly { rowid: number; row: unknown }[]): Promise<boolean> {
  const again = await buildDigest(rows, record.prevHash, record.at);
  return again.hash === record.hash && again.rowsSha256 === record.rowsSha256;
}

const PAGE = 500;

/**
 * `audit.digest`: digests registry_audit rows written since the last head, one R2 object per run,
 * then moves the head. One writer (the daily slot) means no race on the head object.
 */
export async function runAuditDigest(deps: { db: Db; store: R2Bucket | null; now: () => number; budget: Budget }): Promise<HandlerResult> {
  const { db, store, budget } = deps;
  if (!store) return { processed: 0, outcome: "deferred", detail: { reason: "no_store" } };
  const headObj = await store.get(DIGEST_HEAD_KEY);
  const head: DigestHead = headObj ? ((await headObj.json()) as DigestHead) : { lastRowId: 0, hash: GENESIS_HASH, at: "" };
  const rows: { rowid: number; row: unknown }[] = [];
  let after = head.lastRowId;
  let more = true;
  while (more && budget.allows(2)) {
    const page = await audit.registryAuditRowsAfter(db, after, PAGE);
    budget.spend();
    rows.push(...page.map((p) => ({ rowid: Number(p.rowid), row: p.row })));
    more = page.length === PAGE;
    after = rows.length ? rows[rows.length - 1]!.rowid : after;
  }
  if (rows.length === 0) return { processed: 0, outcome: "ok" };
  const at = new Date(deps.now()).toISOString();
  const record = await buildDigest(rows, head.hash, at);
  await store.put(`ledger/audit/${at.slice(0, 10)}-${record.toRowId}.json`, JSON.stringify(record), { httpMetadata: { contentType: "application/json" } });
  await store.put(DIGEST_HEAD_KEY, JSON.stringify({ lastRowId: record.toRowId, hash: record.hash, at } satisfies DigestHead), {
    httpMetadata: { contentType: "application/json" },
  });
  return { processed: rows.length, outcome: more ? "partial" : "ok", detail: { toRowId: record.toRowId } };
}
