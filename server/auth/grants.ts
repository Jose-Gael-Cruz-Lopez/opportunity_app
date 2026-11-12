/**
 * Turns live `user_roles` rows into scoped grants. Every account is a student; other roles come
 * only from rows that have not been revoked.
 */
import { and, eq, isNull } from "drizzle-orm";
import { ROLES, type Role } from "@shared/taxonomy";
import type { Db } from "@server/db/client";
import { userRoles } from "@server/db/schema";
import type { RoleGrant } from "./types";

export interface UserRoleRow {
  role: string;
  workspaceId: string | null;
  organizationId: string | null;
}

const STUDENT_GRANT: RoleGrant = { role: "student", scope: { kind: "global" } };

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * Maps one row to a grant, or null for a row that makes no sense (an unknown role, or a role
 * scoped to a kind of tenant it does not belong to). Ignoring such rows fails closed.
 *
 * Workspace levels: `user_roles` has no level column yet, so an `advisor` row scoped to a
 * workspace is the "advisor" level. Owner and viewer levels need the Phase 3 membership table.
 */
export function grantFromRow(row: UserRoleRow): RoleGrant | null {
  if (!isRole(row.role)) return null;
  if (row.workspaceId && row.organizationId) return null;
  if (row.workspaceId) {
    return row.role === "advisor" ? { role: "advisor", scope: { kind: "workspace", workspaceId: row.workspaceId, level: "advisor" } } : null;
  }
  if (row.organizationId) {
    return row.role === "sponsor_admin"
      ? { role: "sponsor_admin", scope: { kind: "organization", organizationId: row.organizationId, level: "sponsor_admin" } }
      : null;
  }
  return { role: row.role, scope: { kind: "global" } };
}

export function grantsFromRows(rows: readonly UserRoleRow[]): RoleGrant[] {
  const grants: RoleGrant[] = [STUDENT_GRANT];
  const seen = new Set<string>([JSON.stringify(STUDENT_GRANT)]);
  for (const row of rows) {
    const grant = grantFromRow(row);
    if (!grant) continue;
    const key = JSON.stringify(grant);
    if (seen.has(key)) continue;
    seen.add(key);
    grants.push(grant);
  }
  return grants;
}

/** Distinct roles across all scopes, student first. */
export function rolesOf(grants: readonly RoleGrant[]): Role[] {
  return [...new Set<Role>(["student", ...grants.map((g) => g.role)])];
}

export async function loadGrants(db: Db, userId: string): Promise<RoleGrant[]> {
  const rows = await db
    .select({ role: userRoles.role, workspaceId: userRoles.workspaceId, organizationId: userRoles.organizationId })
    .from(userRoles)
    .where(and(eq(userRoles.userId, userId), isNull(userRoles.revokedAt)));
  return grantsFromRows(rows);
}
