import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  ProgramListCreateSchema,
  ProgramListUpdateSchema,
  type AdvisorWorkspace,
  type ProgramList,
  type ProgramListCreate,
  type ProgramListUpdate,
  type WorkspaceReport,
} from "../../../shared/contracts/advisor";
import type { Db } from "../client";
import * as s from "../schema";
import { uuidv7 } from "../columns";
import { iso } from "../util";
import { classifyWriteError, fail, jsonIds, ok, runBatch, versionGuard, type RepoResult, type Stmt } from "./common";

/**
 * Advisor pilot kit: workspaces (the tenant), public or unlisted program lists, and aggregate
 * reports. Every read and write takes the workspace id, so a list of one workspace is never
 * visible through another. Nothing here names or counts an individual student.
 */

type WorkspaceRow = typeof s.advisorWorkspaces.$inferSelect;
type ListRow = typeof s.programLists.$inferSelect;

/** Requests from one tenant. Repositories never accept a list id without it. */
export interface TenantContext {
  workspaceId: string;
}

export function toWorkspace(row: WorkspaceRow): AdvisorWorkspace {
  return {
    id: row.id,
    name: row.name,
    institutionId: row.institutionId,
    kind: row.kind as AdvisorWorkspace["kind"],
    createdAt: iso(row.createdAt),
    isSample: row.isSample,
  };
}

export async function createWorkspace(
  db: Db,
  input: { name: string; institutionId?: string | null; kind?: "concierge_pilot" | "self_service"; approvedBy?: string | null; isSample?: boolean },
  now: number,
): Promise<string> {
  const id = uuidv7(now);
  await db.insert(s.advisorWorkspaces).values({
    id,
    name: input.name,
    institutionId: input.institutionId ?? null,
    kind: input.kind ?? "concierge_pilot",
    approvedBy: input.approvedBy ?? null,
    approvedAt: input.approvedBy ? now : null,
    isSample: input.isSample ?? false,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function getWorkspace(db: Db, workspaceId: string): Promise<AdvisorWorkspace | null> {
  const row = await db.query.advisorWorkspaces.findFirst({ where: and(eq(s.advisorWorkspaces.id, workspaceId), isNull(s.advisorWorkspaces.deletedAt)) });
  return row ? toWorkspace(row) : null;
}

/** Workspaces where the user holds the advisor role. */
export async function workspacesForUser(db: Db, userId: string): Promise<AdvisorWorkspace[]> {
  const rows = await db
    .select({ ws: s.advisorWorkspaces })
    .from(s.userRoles)
    .innerJoin(s.advisorWorkspaces, eq(s.advisorWorkspaces.id, s.userRoles.workspaceId))
    .where(and(eq(s.userRoles.userId, userId), eq(s.userRoles.role, "advisor"), isNull(s.userRoles.revokedAt), isNull(s.advisorWorkspaces.deletedAt)));
  return rows.map((r) => toWorkspace(r.ws));
}

// =============================================================================================
// Program lists
// =============================================================================================

/** 128 random bits, base62-ish alphanumerics (unlisted list tokens). */
export function newListToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(22, "0");
}

export function slugifyTitle(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return base || "list";
}

async function resolveItems(db: Db, items: readonly { programSlug: string; cycleKey: string | null; note: string | null }[]) {
  if (items.length === 0) return { rows: [] as { programId: string; cycleKey: string | null; note: string | null; position: number }[], restricted: false, missing: [] as string[] };
  const programs = await db
    .select({ id: s.programs.id, slug: s.programs.slug, sensitive: s.programs.sensitiveAudience, identity: s.programs.identityAudience })
    .from(s.programs)
    .where(sql`${s.programs.slug} IN ${jsonIds(items.map((i) => i.programSlug))}`);
  const bySlug = new Map(programs.map((p) => [p.slug, p]));
  const missing = items.filter((i) => !bySlug.has(i.programSlug)).map((i) => i.programSlug);
  const rows = items
    .filter((i) => bySlug.has(i.programSlug))
    .map((i, position) => ({ programId: (bySlug.get(i.programSlug) as { id: string }).id, cycleKey: i.cycleKey, note: i.note, position }));
  // A list naming a status- or identity-defined program is restricted: daily counts only, no attribution.
  const restricted = programs.some((p) => p.sensitive || p.identity.length > 0);
  return { rows, restricted, missing };
}

async function loadList(db: Db, where: ReturnType<typeof and>): Promise<ProgramList | null> {
  const list = await db.query.programLists.findFirst({ where: and(where, isNull(s.programLists.deletedAt)) });
  if (!list) return null;
  return toProgramList(db, list);
}

async function toProgramList(db: Db, list: ListRow): Promise<ProgramList> {
  const items = await db
    .select({ slug: s.programs.slug, cycleKey: s.programListItems.cycleKey, note: s.programListItems.note, position: s.programListItems.position })
    .from(s.programListItems)
    .innerJoin(s.programs, eq(s.programs.id, s.programListItems.programId))
    .where(eq(s.programListItems.listId, list.id))
    .orderBy(asc(s.programListItems.position));
  return {
    id: list.id,
    workspaceId: list.workspaceId ?? "",
    title: list.title,
    description: list.description,
    visibility: list.visibility as ProgramList["visibility"],
    slug: list.slug,
    token: list.token,
    restricted: list.restricted,
    items: items.map((i) => ({ programSlug: i.slug, cycleKey: i.cycleKey, note: i.note, position: i.position })),
    updatedAt: iso(list.updatedAt),
  };
}

export async function createProgramList(db: Db, tenant: TenantContext, input: ProgramListCreate, now: number): Promise<RepoResult<ProgramList>> {
  const parsed = ProgramListCreateSchema.safeParse(input);
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => i.message).join("; "));
  const data = parsed.data;
  const { rows, restricted, missing } = await resolveItems(db, data.items);
  if (missing.length > 0) return fail("invalid", `unknown programs: ${missing.join(", ")}`);
  const id = uuidv7(now);
  const slug = data.visibility === "public" ? `${slugifyTitle(data.title)}-${id.slice(-6)}` : null;
  const token = data.visibility === "unlisted" ? newListToken() : null;
  const stmts: Stmt[] = [
    db.insert(s.programLists).values({
      id,
      ownerKind: "workspace",
      workspaceId: tenant.workspaceId,
      title: data.title,
      description: data.description,
      visibility: data.visibility,
      slug,
      token,
      restricted,
      createdAt: now,
      updatedAt: now,
    }),
  ];
  if (rows.length) stmts.push(db.insert(s.programListItems).values(rows.map((r) => ({ ...r, listId: id, createdAt: now }))));
  try {
    await runBatch(db, stmts);
  } catch (err) {
    // The workspace approval trigger refuses lists of unapproved workspaces.
    if (/workspace is not approved/.test(String((err as Error)?.message ?? err) + String((err as { cause?: Error })?.cause?.message ?? ""))) {
      return fail("invalid", "workspace is not approved");
    }
    return classifyWriteError(err);
  }
  const list = await getProgramList(db, tenant, id);
  return list ? ok(list) : fail("not_found");
}

export async function getProgramList(db: Db, tenant: TenantContext, listId: string): Promise<ProgramList | null> {
  return loadList(db, and(eq(s.programLists.id, listId), eq(s.programLists.workspaceId, tenant.workspaceId)));
}

export async function listWorkspaceLists(db: Db, tenant: TenantContext): Promise<ProgramList[]> {
  const rows = await db
    .select()
    .from(s.programLists)
    .where(and(eq(s.programLists.workspaceId, tenant.workspaceId), isNull(s.programLists.deletedAt)))
    .orderBy(asc(s.programLists.createdAt));
  return Promise.all(rows.map((r) => toProgramList(db, r)));
}

/** Public read by slug (public lists) or token (unlisted lists). */
export async function getPublicProgramList(db: Db, ref: { slug?: string; token?: string }): Promise<ProgramList | null> {
  if (ref.slug) return loadList(db, and(eq(s.programLists.slug, ref.slug), eq(s.programLists.visibility, "public")));
  if (ref.token) return loadList(db, and(eq(s.programLists.token, ref.token), eq(s.programLists.visibility, "unlisted")));
  return null;
}

/** Replaces the given fields; `expectedVersion` guards concurrent edits by two advisors. */
export async function updateProgramList(
  db: Db,
  tenant: TenantContext,
  listId: string,
  update: ProgramListUpdate,
  expectedVersion: number,
  now: number,
): Promise<RepoResult<ProgramList>> {
  const parsed = ProgramListUpdateSchema.safeParse(update);
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => i.message).join("; "));
  const current = await db.query.programLists.findFirst({
    where: and(eq(s.programLists.id, listId), eq(s.programLists.workspaceId, tenant.workspaceId), isNull(s.programLists.deletedAt)),
  });
  if (!current) return fail("not_found");
  const data = parsed.data;
  const set: Partial<typeof s.programLists.$inferInsert> = { updatedAt: now };
  if (data.title !== undefined) set.title = data.title;
  if (data.description !== undefined) set.description = data.description;
  if (data.visibility !== undefined && data.visibility !== current.visibility) {
    set.visibility = data.visibility;
    set.slug = data.visibility === "public" ? (current.slug ?? `${slugifyTitle(data.title ?? current.title)}-${listId.slice(-6)}`) : null;
    set.token = data.visibility === "unlisted" ? (current.token ?? newListToken()) : null;
  }
  const stmts: Stmt[] = [versionGuard(db, `list:${listId}:v${expectedVersion}:${now}`, "program_lists", listId, expectedVersion, now)];
  if (data.items !== undefined) {
    const { rows, restricted, missing } = await resolveItems(db, data.items);
    if (missing.length > 0) return fail("invalid", `unknown programs: ${missing.join(", ")}`);
    set.restricted = restricted;
    stmts.push(db.delete(s.programListItems).where(eq(s.programListItems.listId, listId)));
    if (rows.length) stmts.push(db.insert(s.programListItems).values(rows.map((r) => ({ ...r, listId, createdAt: now }))));
  }
  stmts.push(
    db
      .update(s.programLists)
      .set({ ...set, version: sql`${s.programLists.version} + 1` })
      .where(and(eq(s.programLists.id, listId), eq(s.programLists.workspaceId, tenant.workspaceId))),
  );
  try {
    await runBatch(db, stmts);
  } catch (err) {
    return classifyWriteError(err);
  }
  const list = await getProgramList(db, tenant, listId);
  return list ? ok(list) : fail("not_found");
}

export async function deleteProgramList(db: Db, tenant: TenantContext, listId: string, now: number): Promise<boolean> {
  const rows = await db
    .update(s.programLists)
    .set({ deletedAt: now, updatedAt: now })
    .where(and(eq(s.programLists.id, listId), eq(s.programLists.workspaceId, tenant.workspaceId), isNull(s.programLists.deletedAt)))
    .returning({ id: s.programLists.id });
  return rows.length > 0;
}

export async function getProgramListVersion(db: Db, tenant: TenantContext, listId: string): Promise<number | null> {
  const row = await db.query.programLists.findFirst({
    where: and(eq(s.programLists.id, listId), eq(s.programLists.workspaceId, tenant.workspaceId)),
    columns: { version: true },
  });
  return row?.version ?? null;
}

// =============================================================================================
// Aggregate report (counts only, banded; no student is named or countable)
// =============================================================================================

/** Bands small counts so no single student can be inferred. */
export function bandCount(n: number): string {
  if (n < 10) return "fewer than 10";
  if (n < 25) return "10-24";
  if (n < 50) return "25-49";
  if (n < 100) return "50-99";
  return `${Math.floor(n / 100) * 100}+`;
}

/**
 * Tracker totals (across all Novus students, not the workspace's) for the programs on the
 * workspace's lists, skipping restricted programs entirely. Pilot reports carry no per-student data.
 */
export async function workspaceReport(db: Db, tenant: TenantContext, period: string, listViews: number): Promise<WorkspaceReport> {
  const programIds = db
    .select({ id: s.programListItems.programId })
    .from(s.programListItems)
    .innerJoin(s.programLists, eq(s.programLists.id, s.programListItems.listId))
    .where(and(eq(s.programLists.workspaceId, tenant.workspaceId), isNull(s.programLists.deletedAt)));
  const rows = await db
    .select({
      slug: s.programs.slug,
      // Raw qualified names: a lone Drizzle column renders unqualified and would rebind inside the subquery.
      trackers: sql<number>`(SELECT count(*) FROM tracker_items t JOIN program_cycles c ON c.id = t.program_cycle_id WHERE c.program_id = programs.id AND t.deleted_at IS NULL)`,
    })
    .from(s.programs)
    .where(
      and(
        inArray(s.programs.id, programIds),
        eq(s.programs.sensitiveAudience, false),
        sql`json_array_length(${s.programs.identityAudience}) = 0`,
      ),
    )
    .orderBy(asc(s.programs.slug));
  const total = rows.reduce((sum, r) => sum + Number(r.trackers), 0);
  return {
    workspaceId: tenant.workspaceId,
    period,
    listViews: bandCount(listViews),
    trackedPrograms: bandCount(total),
    rows: rows.map((r) => ({ programSlug: r.slug, trackers: bandCount(Number(r.trackers)) })),
  };
}
