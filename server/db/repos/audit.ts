import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Actor, AuditLogEntry } from "../../../shared/contracts/ops";
import type { EvidenceEntity } from "../../../shared/taxonomy";
import type { Db } from "../client";
import * as s from "../schema";
import { uuidv7 } from "../columns";
import { iso } from "../util";
import type { Stmt } from "./common";

/**
 * Audit logs. `registry_audit` keeps before/after values of public registry fields and is
 * append-only by trigger; its rows join the batch of the change they record. `access_audit`
 * keeps who touched which fields of whose personal data, as field names and a pseudonymous
 * subject key, never values.
 */

export interface RegistryAuditInput {
  at: number;
  actor: Actor;
  entityType: EvidenceEntity;
  entityId: string;
  field: string;
  before: unknown;
  after: unknown;
  taskId?: string | null;
  snapshotIds?: readonly string[];
}

/** A statement to include in the batch of the change it records. */
export function registryAuditInsert(db: Db, entry: RegistryAuditInput): Stmt {
  return db.insert(s.registryAudit).values({
    id: uuidv7(entry.at),
    at: entry.at,
    actorKind: entry.actor.kind,
    actorRef: entry.actor.ref,
    entityType: entry.entityType,
    entityId: entry.entityId,
    field: entry.field,
    // JSON columns store `null` as SQL NULL; wrap so "was null" and "absent" stay distinct.
    before: entry.before === undefined ? null : { v: entry.before },
    after: entry.after === undefined ? null : { v: entry.after },
    taskId: entry.taskId ?? null,
    snapshotIds: [...(entry.snapshotIds ?? [])],
  });
}

function unwrap(value: unknown): unknown {
  return value !== null && typeof value === "object" && "v" in (value as Record<string, unknown>) ? (value as { v: unknown }).v : value;
}

export async function listRegistryAudit(db: Db, entityType: EvidenceEntity, entityId: string, limit = 100): Promise<AuditLogEntry[]> {
  const rows = await db
    .select()
    .from(s.registryAudit)
    .where(and(eq(s.registryAudit.entityType, entityType), eq(s.registryAudit.entityId, entityId)))
    .orderBy(desc(s.registryAudit.at))
    .limit(limit);
  return rows.map((r) => ({
    log: "registry" as const,
    id: r.id,
    at: iso(r.at),
    actor: { kind: r.actorKind as Actor["kind"], ref: r.actorRef },
    entityType: r.entityType as EvidenceEntity,
    entityId: r.entityId,
    field: r.field,
    before: unwrap(r.before),
    after: unwrap(r.after),
    taskId: r.taskId,
    snapshotIds: r.snapshotIds,
  }));
}

export interface AccessAuditInput {
  at: number;
  actor: Actor;
  action: "read" | "export" | "update" | "delete" | "share";
  purpose: string;
  /** Field names only. */
  fields: readonly string[];
  /** Pseudonymous subject key (for example an HMAC of the user id), never an email or name. */
  subjectKey: string;
  requestId?: string | null;
}

export function accessAuditInsert(db: Db, entry: AccessAuditInput): Stmt {
  return db.insert(s.accessAudit).values({
    id: uuidv7(entry.at),
    createdAt: entry.at,
    actorKind: entry.actor.kind,
    actorRef: entry.actor.ref,
    action: entry.action,
    purpose: entry.purpose,
    fields: [...entry.fields],
    subjectKey: entry.subjectKey,
    requestId: entry.requestId ?? null,
  });
}

export async function appendAccessAudit(db: Db, entry: AccessAuditInput): Promise<void> {
  await accessAuditInsert(db, entry);
}

/** What a student can see about who accessed their data. */
export async function listAccessAuditForSubject(db: Db, subjectKey: string, limit = 100): Promise<AuditLogEntry[]> {
  const rows = await db
    .select()
    .from(s.accessAudit)
    .where(eq(s.accessAudit.subjectKey, subjectKey))
    .orderBy(asc(s.accessAudit.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    log: "access" as const,
    id: r.id,
    at: iso(r.createdAt),
    actor: { kind: r.actorKind as Actor["kind"], ref: r.actorRef },
    action: r.action as "read" | "export" | "update" | "delete" | "share",
    purpose: r.purpose,
    fields: r.fields,
    subjectKey: r.subjectKey,
    requestId: r.requestId,
  }));
}

/** On account deletion the subject key becomes a tombstone (the only update the guard allows). */
export async function tombstoneAccessAudit(db: Db, subjectKey: string, tombstoneId: string): Promise<void> {
  await db
    .update(s.accessAudit)
    .set({ subjectKey: `tombstone:${tombstoneId}` })
    .where(eq(s.accessAudit.subjectKey, subjectKey));
}

/** Rows for the daily digest, by rowid range (rowids of an append-only table only grow). */
export async function registryAuditRowsAfter(db: Db, afterRowId: number, limit: number) {
  return db
    .select({ rowid: sql<number>`rowid`, row: s.registryAudit })
    .from(s.registryAudit)
    .where(sql`rowid > ${afterRowId}`)
    .orderBy(sql`rowid`)
    .limit(limit);
}
