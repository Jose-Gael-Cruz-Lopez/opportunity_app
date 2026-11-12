/**
 * Permission-matrix tests (plan S09-036): the 9.11.2 table written out by hand, so a change to
 * PERMISSION_MATRIX that disagrees with the plan fails here, plus generated checks over every row.
 */
import { describe, expect, it } from "vitest";
import { ROLES, type Role } from "@shared/taxonomy";
import { can, decide, PERMISSION_ACTIONS, PERMISSION_MATRIX, type PermissionAction, type PermissionResource } from "./permissions";
import type { RoleGrant, SessionUser } from "./types";

const ME = "user-me";
const OTHER = "user-other";

function user(grants: RoleGrant[], verified = true): SessionUser {
  const all: RoleGrant[] = [{ role: "student", scope: { kind: "global" } }, ...grants];
  return {
    id: ME,
    publicId: "pub-me",
    email: "me@example.org",
    displayName: null,
    roles: [...new Set(all.map((g) => g.role))],
    onboarded: true,
    grants: all,
    sessionId: "s1",
    sessionExpiresAt: Date.now() + 3_600_000,
    surface: "app",
    secondFactor: { enrolled: verified, verified },
  };
}

const global = (role: Role): RoleGrant => ({ role, scope: { kind: "global" } });
const as = (role: Role, verified = true) => (role === "student" ? user([], verified) : user([global(role)], verified));

type Who = "student" | "curator" | "moderator" | "admin";
const WHO: Who[] = ["student", "curator", "moderator", "admin"];

/** [action, resource, allowed for student, curator, moderator, admin] from plan 9.11.2. */
const TABLE: [PermissionAction, PermissionResource, [boolean, boolean, boolean, boolean]][] = [
  ["registry.read", {}, [true, true, true, true]],
  ["aggregates.read", {}, [true, true, true, true]],
  ["account.export", { ownerUserId: ME }, [true, true, true, true]],
  ["account.delete", { ownerUserId: OTHER }, [false, false, false, false]],
  ["tracker.manage", { ownerUserId: ME }, [true, true, true, true]],
  ["tracker.manage", { ownerUserId: OTHER }, [false, false, false, false]],
  ["alerts.manage", { ownerUserId: OTHER }, [false, false, false, false]],
  ["calendar_feed.manage", { ownerUserId: ME }, [true, true, true, true]],
  ["outcomes.manage", { ownerUserId: OTHER }, [false, false, false, false]],
  ["review_tasks.work", {}, [false, true, false, true]],
  ["resource_links.manage", {}, [false, true, false, true]],
  ["registry.approve", {}, [false, true, false, true]],
  ["ops.pipeline.read", {}, [false, true, false, true]],
  ["registry.release.rollback", {}, [false, false, false, true]],
  ["outcome_anomaly.review", {}, [false, false, true, true]],
  ["documents.open", { documentPurpose: "opportunity_source" }, [false, true, false, false]],
  ["documents.open", { documentPurpose: "award_list" }, [false, true, false, false]],
  ["documents.open", { documentPurpose: "student_letter", withinReviewWindow: true }, [false, false, true, false]],
  ["documents.open", { documentPurpose: "student_letter", withinReviewWindow: false }, [false, false, false, false]],
  ["moderation.decide", { decidedByUserId: OTHER }, [false, false, true, true]],
  ["moderation.decide", { decidedByUserId: ME }, [false, false, false, true]],
  ["advisor_workspaces.approve", {}, [false, false, false, true]],
  ["console.dashboards.read", {}, [false, false, false, true]],
  ["audit_log.read", { subjectUserId: ME }, [true, true, true, true]],
  ["audit_log.read", { actorUserId: ME }, [false, true, true, true]],
  ["audit_log.read", { actorUserId: OTHER, subjectUserId: OTHER }, [false, false, false, true]],
  ["curator_identities.read", {}, [false, false, false, true]],
  ["flags.change", {}, [false, false, false, true]],
  ["roles.grant", {}, [false, false, false, true]],
  ["config.thresholds.change", {}, [false, false, false, true]],
];

describe("permission matrix (9.11.2)", () => {
  for (const [action, resource, expected] of TABLE) {
    WHO.forEach((who, i) => {
      it(`${who} ${expected[i] ? "may" : "may not"} ${action} ${JSON.stringify(resource)}`, () => {
        expect(can(as(who), action, resource)).toBe(expected[i]);
      });
    });
  }

  it("covers every global action in the hand-written table", () => {
    const tested = new Set(TABLE.map(([a]) => a));
    const globalActions = PERMISSION_MATRIX.filter((r) => r.scope === "global").map((r) => r.action);
    const missing = globalActions.filter((a) => !tested.has(a));
    // posts.manage is Phase 3; the rest must be listed above.
    expect(missing).toEqual(["posts.manage"]);
  });

  it("has unique action names", () => {
    expect(new Set(PERMISSION_ACTIONS).size).toBe(PERMISSION_ACTIONS.length);
  });

  it("denies an action without a row", () => {
    expect(decide(as("admin"), "registry.delete_everything")).toEqual({ allowed: false, reason: "unknown_action" });
  });

  it("lets signed-out visitors read the registry only", () => {
    expect(can(null, "registry.read")).toBe(true);
    expect(decide(null, "tracker.manage", { ownerUserId: ME })).toEqual({ allowed: false, reason: "unauthenticated" });
  });

  it("attaches duties to allowed actions", () => {
    const grant = decide(as("admin"), "roles.grant");
    expect(grant.allowed && grant.obligations).toContain("second_admin_approval");
    const anomaly = decide(as("moderator"), "outcome_anomaly.review");
    expect(anomaly.allowed && anomaly.obligations).toContain("access_audit");
    const flag = decide(as("admin"), "flags.change");
    expect(flag.allowed && flag.obligations).toContain("notify_founders");
  });

  it("explains a curator's denials", () => {
    expect(decide(as("curator"), "outcome_anomaly.review")).toEqual({ allowed: false, reason: "no_grant" });
    expect(decide(as("curator"), "documents.open", { documentPurpose: "student_letter", withinReviewWindow: true })).toEqual({
      allowed: false,
      reason: "condition_failed",
    });
  });
});

describe("second factor", () => {
  it("is required for every grant that comes from a non-student role", () => {
    for (const row of PERMISSION_MATRIX) {
      if (row.scope !== "global") continue;
      for (const role of ROLES) {
        if (role === "student" || !(role in row.cells)) continue;
        const resource: PermissionResource = {
          ownerUserId: OTHER,
          subjectUserId: OTHER,
          actorUserId: ME,
          decidedByUserId: OTHER,
          documentPurpose: role === "moderator" ? "student_letter" : "opportunity_source",
          withinReviewWindow: true,
        };
        const verified = decide(as(role, true), row.action, resource);
        if (!verified.allowed || verified.via === "everyone") continue;
        expect(decide(as(role, false), row.action, resource), `${role} ${row.action}`).toEqual({
          allowed: false,
          reason: "second_factor_required",
        });
      }
    }
  });

  it("does not block a staff member's own student items", () => {
    expect(can(as("curator", false), "tracker.manage", { ownerUserId: ME })).toBe(true);
    expect(can(as("admin", false), "audit_log.read", { subjectUserId: ME })).toBe(true);
  });
});

describe("workspace scope", () => {
  const advisorIn = (workspaceId: string, verified = true) =>
    user([{ role: "advisor", scope: { kind: "workspace", workspaceId, level: "advisor" } }], verified);

  it("opens only the advisor's own workspace", () => {
    expect(can(advisorIn("w1"), "workspace.lists.manage", { workspaceId: "w1" })).toBe(true);
    expect(decide(advisorIn("w1"), "workspace.lists.manage", { workspaceId: "w2" })).toEqual({ allowed: false, reason: "no_grant" });
    expect(can(advisorIn("w1"), "workspace.lists.manage", {})).toBe(false);
  });

  it("keeps owner-only actions from advisors", () => {
    expect(can(advisorIn("w1"), "workspace.members.manage", { workspaceId: "w1" })).toBe(false);
    expect(can(advisorIn("w1"), "workspace.export", { workspaceId: "w1" })).toBe(false);
    const owner = user([{ role: "advisor", scope: { kind: "workspace", workspaceId: "w1", level: "owner" } }]);
    expect(can(owner, "workspace.members.manage", { workspaceId: "w1" })).toBe(true);
  });

  it("lets viewers read aggregates only", () => {
    const viewer = user([{ role: "advisor", scope: { kind: "workspace", workspaceId: "w1", level: "viewer" } }]);
    expect(can(viewer, "workspace.aggregates.read", { workspaceId: "w1" })).toBe(true);
    expect(can(viewer, "workspace.lists.manage", { workspaceId: "w1" })).toBe(false);
  });

  it("needs TOTP for every workspace action", () => {
    expect(decide(advisorIn("w1", false), "workspace.aggregates.read", { workspaceId: "w1" })).toEqual({
      allowed: false,
      reason: "second_factor_required",
    });
  });

  it("does not let a global admin into a workspace's tenant actions", () => {
    expect(can(as("admin"), "workspace.lists.manage", { workspaceId: "w1" })).toBe(false);
  });
});

describe("organization scope", () => {
  const sponsorAdmin = user([{ role: "sponsor_admin", scope: { kind: "organization", organizationId: "o1", level: "sponsor_admin" } }]);
  const member = user([{ role: "sponsor_admin", scope: { kind: "organization", organizationId: "o1", level: "sponsor_member" } }]);

  it("opens only the sponsor's own Organization", () => {
    expect(can(sponsorAdmin, "organization.claims.manage", { organizationId: "o1" })).toBe(true);
    expect(can(sponsorAdmin, "organization.claims.manage", { organizationId: "o2" })).toBe(false);
  });

  it("lets members draft and read analytics but not submit", () => {
    expect(can(member, "organization.owner_updates.draft", { organizationId: "o1" })).toBe(true);
    expect(can(member, "organization.analytics.read", { organizationId: "o1" })).toBe(true);
    expect(can(member, "organization.owner_updates.submit", { organizationId: "o1" })).toBe(false);
  });
});
