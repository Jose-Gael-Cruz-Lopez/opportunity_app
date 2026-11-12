/**
 * The permission matrix (plan 9.11.2) as data, and the one `can(user, action, resource)` every
 * staff, advisor and sponsor route calls.
 *
 * Rules the evaluator enforces, so a matrix row cannot forget them:
 * - An action without a row is denied.
 * - Any grant that comes from a role other than `student` needs a session that passed the
 *   second factor (TOTP), because every non-student role requires it.
 * - Workspace and Organization rows apply only to grants scoped to the resource's workspace or
 *   Organization, so a grant in workspace A never opens workspace B.
 * - "Own" rows compare the resource's owner with the signed-in user; callers must still read
 *   through repositories that filter by owner (this is a second check, not the only one).
 */
import type { Role } from "@shared/taxonomy";
import type { OrganizationLevel, RoleGrant, SessionUser, WorkspaceLevel } from "./types";

/** Public document purposes a Curator may open (s05). */
export const PUBLIC_DOCUMENT_PURPOSES = ["opportunity_source", "opportunity_hint", "sponsor_document", "award_list"] as const;
export type PublicDocumentPurpose = (typeof PUBLIC_DOCUMENT_PURPOSES)[number];
export const DOCUMENT_PURPOSES = [...PUBLIC_DOCUMENT_PURPOSES, "student_letter"] as const;
export type DocumentPurpose = (typeof DOCUMENT_PURPOSES)[number];

/** What a caller knows about the thing being acted on. Every field is optional; rules say which they need. */
export interface PermissionResource {
  /** The user who owns the item (TrackerItem, Alert, CalendarFeed, Outcome, post, account). */
  ownerUserId?: string | null;
  /** The staff user who performed a logged action (audit rows). */
  actorUserId?: string | null;
  /** The subject of an audit row (a student's own history). */
  subjectUserId?: string | null;
  /** The moderator who made the decision under appeal. */
  decidedByUserId?: string | null;
  documentPurpose?: DocumentPurpose | null;
  /** True while a student letter is inside its 24-hour review window (the caller computes it). */
  withinReviewWindow?: boolean;
  workspaceId?: string | null;
  organizationId?: string | null;
}

/**
 * Conditions a cell can carry:
 * - yes: always (still subject to the second factor for non-student roles);
 * - own: resource.ownerUserId is the user, or resource.subjectUserId for audit history;
 * - own_actions: resource.actorUserId is the user;
 * - public_purpose: resource.documentPurpose is a public purpose;
 * - student_letter_window: a student letter inside its 24-hour window;
 * - not_own_decision: resource.decidedByUserId is someone else.
 */
export type Condition = "yes" | "own" | "own_actions" | "public_purpose" | "student_letter_window" | "not_own_decision";

/** Duties the caller must perform when the action is allowed. */
export type Obligation =
  | "access_audit" // write an access_audit row for this view
  | "registry_audit" // the change is written with registry_audit rows
  | "notify_founders" // tell the other founders and review it the next day
  | "second_admin_approval"; // a second, different admin must approve before it applies

type GlobalCells = Partial<Record<Role | "everyone", Condition>>;

interface RowBase {
  action: string;
  /** The matrix line this row comes from, for reviewers and test names. */
  matrix: string;
  /** Plan phase in which the action first ships (data for reviews; not enforced here). */
  phase: 0 | 1 | 2 | 3 | 4;
  obligations?: readonly Obligation[];
}

export type PermissionRow =
  | (RowBase & { scope: "global"; cells: GlobalCells })
  | (RowBase & { scope: "workspace"; cells: Partial<Record<WorkspaceLevel, Condition>> })
  | (RowBase & { scope: "organization"; cells: Partial<Record<OrganizationLevel, Condition>> });

export const PERMISSION_MATRIX = [
  // --- Everyone ---------------------------------------------------------------------------
  { action: "registry.read", scope: "global", matrix: "Everyone reads the registry", phase: 0, cells: { everyone: "yes" } },
  { action: "aggregates.read", scope: "global", matrix: "Everyone reads released aggregates", phase: 1, cells: { everyone: "yes" } },
  { action: "account.export", scope: "global", matrix: "Everyone can export their own account", phase: 1, cells: { student: "own" } },
  { action: "account.delete", scope: "global", matrix: "Everyone can delete their own account", phase: 1, cells: { student: "own" } },

  // --- Students' own items ----------------------------------------------------------------
  { action: "tracker.manage", scope: "global", matrix: "Track, Alerts, CalendarFeed, Outcomes, posts", phase: 1, cells: { student: "own" } },
  { action: "alerts.manage", scope: "global", matrix: "Track, Alerts, CalendarFeed, Outcomes, posts", phase: 1, cells: { student: "own" } },
  { action: "calendar_feed.manage", scope: "global", matrix: "Track, Alerts, CalendarFeed, Outcomes, posts", phase: 1, cells: { student: "own" } },
  { action: "outcomes.manage", scope: "global", matrix: "Track, Alerts, CalendarFeed, Outcomes, posts", phase: 2, cells: { student: "own" } },
  { action: "posts.manage", scope: "global", matrix: "Track, Alerts, CalendarFeed, Outcomes, posts", phase: 3, cells: { student: "own" } },

  // --- Curation ---------------------------------------------------------------------------
  { action: "review_tasks.work", scope: "global", matrix: "ReviewTasks, Resource links, registry approvals", phase: 1, cells: { curator: "yes", admin: "yes" } },
  { action: "resource_links.manage", scope: "global", matrix: "ReviewTasks, Resource links, registry approvals", phase: 1, cells: { curator: "yes", admin: "yes" }, obligations: ["registry_audit"] },
  { action: "registry.approve", scope: "global", matrix: "ReviewTasks, Resource links, registry approvals", phase: 1, cells: { curator: "yes", admin: "yes" }, obligations: ["registry_audit"] },
  { action: "ops.pipeline.read", scope: "global", matrix: "ReviewTasks, Resource links, registry approvals (ops view)", phase: 1, cells: { curator: "yes", admin: "yes" } },
  { action: "registry.release.rollback", scope: "global", matrix: "Kill switches, feature flags (release pointer)", phase: 1, cells: { admin: "yes" }, obligations: ["registry_audit", "notify_founders"] },

  // --- Outcome anomalies ------------------------------------------------------------------
  { action: "outcome_anomaly.review", scope: "global", matrix: "Outcome anomaly review", phase: 2, cells: { moderator: "yes", admin: "yes" }, obligations: ["access_audit"] },

  // --- Documents --------------------------------------------------------------------------
  { action: "documents.open", scope: "global", matrix: "Open documents", phase: 1, cells: { curator: "public_purpose", moderator: "student_letter_window" }, obligations: ["access_audit"] },

  // --- Moderation -------------------------------------------------------------------------
  { action: "moderation.decide", scope: "global", matrix: "Moderation, appeals, sanctions", phase: 3, cells: { moderator: "not_own_decision", admin: "yes" }, obligations: ["access_audit"] },

  // --- Admin ------------------------------------------------------------------------------
  { action: "advisor_workspaces.approve", scope: "global", matrix: "Approve advisor workspaces", phase: 2, cells: { admin: "yes" }, obligations: ["registry_audit"] },
  { action: "console.dashboards.read", scope: "global", matrix: "Dashboards and metrics on curate.", phase: 1, cells: { admin: "yes" } },
  { action: "audit_log.read", scope: "global", matrix: "Audit logs", phase: 1, cells: { student: "own", curator: "own_actions", moderator: "own_actions", admin: "yes" } },
  { action: "curator_identities.read", scope: "global", matrix: "Curator identities", phase: 1, cells: { admin: "yes" }, obligations: ["access_audit"] },
  { action: "flags.change", scope: "global", matrix: "Kill switches, feature flags", phase: 1, cells: { admin: "yes" }, obligations: ["registry_audit", "notify_founders"] },
  { action: "roles.grant", scope: "global", matrix: "Roles", phase: 1, cells: { admin: "yes" }, obligations: ["registry_audit", "second_admin_approval"] },
  { action: "config.thresholds.change", scope: "global", matrix: "Anti-abuse thresholds", phase: 1, cells: { admin: "yes" }, obligations: ["registry_audit", "second_admin_approval"] },

  // --- Within an AdvisorWorkspace (TOTP for all) ------------------------------------------
  { action: "workspace.members.manage", scope: "workspace", matrix: "Members, join codes, exports", phase: 3, cells: { owner: "yes" } },
  { action: "workspace.join_codes.manage", scope: "workspace", matrix: "Members, join codes, exports", phase: 3, cells: { owner: "yes" } },
  { action: "workspace.export", scope: "workspace", matrix: "Members, join codes, exports", phase: 3, cells: { owner: "yes" } },
  { action: "workspace.lists.manage", scope: "workspace", matrix: "Lists, campus deadlines, consented by-name views", phase: 2, cells: { owner: "yes", advisor: "yes" } },
  { action: "workspace.campus_deadlines.submit", scope: "workspace", matrix: "Lists, campus deadlines, consented by-name views", phase: 2, cells: { owner: "yes", advisor: "yes" } },
  { action: "workspace.by_name.read", scope: "workspace", matrix: "Lists, campus deadlines, consented by-name views", phase: 3, cells: { owner: "yes", advisor: "yes" }, obligations: ["access_audit"] },
  { action: "workspace.aggregates.read", scope: "workspace", matrix: "Cohort aggregates and reports", phase: 2, cells: { owner: "yes", advisor: "yes", viewer: "yes" } },

  // --- Within an Organization (Phase 3; TOTP for all) -------------------------------------
  { action: "organization.claims.manage", scope: "organization", matrix: "Claims, submitting owner updates, members, Promotion orders", phase: 3, cells: { sponsor_admin: "yes" } },
  { action: "organization.owner_updates.submit", scope: "organization", matrix: "Claims, submitting owner updates, members, Promotion orders", phase: 3, cells: { sponsor_admin: "yes" }, obligations: ["registry_audit"] },
  { action: "organization.members.manage", scope: "organization", matrix: "Claims, submitting owner updates, members, Promotion orders", phase: 3, cells: { sponsor_admin: "yes" } },
  { action: "organization.promotions.order", scope: "organization", matrix: "Claims, submitting owner updates, members, Promotion orders", phase: 3, cells: { sponsor_admin: "yes" } },
  { action: "organization.owner_updates.draft", scope: "organization", matrix: "Drafting owner updates; sponsor analytics", phase: 3, cells: { sponsor_admin: "yes", sponsor_member: "yes" } },
  { action: "organization.analytics.read", scope: "organization", matrix: "Drafting owner updates; sponsor analytics (cells of 10+)", phase: 3, cells: { sponsor_admin: "yes", sponsor_member: "yes" } },
] as const satisfies readonly PermissionRow[];

export type PermissionAction = (typeof PERMISSION_MATRIX)[number]["action"];
export const PERMISSION_ACTIONS: readonly PermissionAction[] = PERMISSION_MATRIX.map((r) => r.action);

const ROWS_BY_ACTION: ReadonlyMap<string, PermissionRow> = new Map(
  (PERMISSION_MATRIX as readonly PermissionRow[]).map((r) => [r.action, r]),
);

export function permissionRow(action: string): PermissionRow | undefined {
  return ROWS_BY_ACTION.get(action);
}

export type DenyReason =
  | "unknown_action" // no matrix row: denied by default
  | "unauthenticated" // the row needs a signed-in user
  | "no_grant" // none of the user's roles has a cell on this row (or in this scope)
  | "condition_failed" // a cell exists but its condition is false for this resource
  | "second_factor_required"; // a cell would allow it, but the session has not passed TOTP

export type Decision =
  | { allowed: true; via: Role | WorkspaceLevel | OrganizationLevel | "everyone"; obligations: readonly Obligation[] }
  | { allowed: false; reason: DenyReason };

/** Roles that need TOTP: every role except student (plan 2.3.10). */
export function requiresSecondFactor(role: Role): boolean {
  return role !== "student";
}

function conditionHolds(condition: Condition, user: SessionUser, resource: PermissionResource): boolean {
  switch (condition) {
    case "yes":
      return true;
    case "own":
      return (resource.ownerUserId ?? resource.subjectUserId ?? null) === user.id;
    case "own_actions":
      return resource.actorUserId === user.id;
    case "public_purpose":
      return (PUBLIC_DOCUMENT_PURPOSES as readonly string[]).includes(resource.documentPurpose ?? "");
    case "student_letter_window":
      return resource.documentPurpose === "student_letter" && resource.withinReviewWindow === true;
    case "not_own_decision":
      return typeof resource.decidedByUserId === "string" && resource.decidedByUserId !== user.id;
  }
}

/** A candidate path to an allow: which cell, and whether it needs the second factor. */
interface Candidate {
  via: Role | WorkspaceLevel | OrganizationLevel | "everyone";
  condition: Condition;
  needsSecondFactor: boolean;
}

function globalRoles(grants: readonly RoleGrant[]): Set<Role> {
  const roles = new Set<Role>(["student"]);
  for (const g of grants) if (g.scope.kind === "global") roles.add(g.role);
  return roles;
}

function candidatesFor(row: PermissionRow, user: SessionUser, resource: PermissionResource): Candidate[] {
  if (row.scope === "global") {
    const out: Candidate[] = [];
    for (const role of globalRoles(user.grants)) {
      const condition = row.cells[role];
      if (condition) out.push({ via: role, condition, needsSecondFactor: requiresSecondFactor(role) });
    }
    return out;
  }
  if (row.scope === "workspace") {
    if (!resource.workspaceId) return [];
    return user.grants.flatMap((g): Candidate[] => {
      if (g.scope.kind !== "workspace" || g.scope.workspaceId !== resource.workspaceId) return [];
      const condition = row.cells[g.scope.level];
      return condition ? [{ via: g.scope.level, condition, needsSecondFactor: true }] : [];
    });
  }
  if (!resource.organizationId) return [];
  return user.grants.flatMap((g): Candidate[] => {
    if (g.scope.kind !== "organization" || g.scope.organizationId !== resource.organizationId) return [];
    const condition = row.cells[g.scope.level];
    return condition ? [{ via: g.scope.level, condition, needsSecondFactor: true }] : [];
  });
}

/**
 * The full decision, with the reason for a denial and the duties attached to an allow. Use it
 * when the caller needs to tell "sign in" from "verify your authenticator" from "not allowed".
 */
export function decide(user: SessionUser | null | undefined, action: string, resource: PermissionResource = {}): Decision {
  const row = permissionRow(action);
  if (!row) return { allowed: false, reason: "unknown_action" };
  const obligations = row.obligations ?? [];

  if (row.scope === "global" && row.cells.everyone === "yes") return { allowed: true, via: "everyone", obligations };
  if (!user) return { allowed: false, reason: "unauthenticated" };

  const candidates = candidatesFor(row, user, resource);
  if (candidates.length === 0) return { allowed: false, reason: "no_grant" };

  const satisfied = candidates.filter((c) => conditionHolds(c.condition, user, resource));
  if (satisfied.length === 0) return { allowed: false, reason: "condition_failed" };

  // Prefer a path that needs no second factor (a student acting on their own items).
  const usable = satisfied.find((c) => !c.needsSecondFactor || user.secondFactor.verified);
  if (!usable) return { allowed: false, reason: "second_factor_required" };
  return { allowed: true, via: usable.via, obligations };
}

/** One boolean check for routes: `if (!can(user, "review_tasks.work")) return forbidden`. */
export function can(user: SessionUser | null | undefined, action: PermissionAction, resource: PermissionResource = {}): boolean {
  return decide(user, action, resource).allowed;
}
