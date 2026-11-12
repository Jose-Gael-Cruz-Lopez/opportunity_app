/**
 * Types shared by the auth module and its callers. server/env.ts should type the `user` context
 * variable as this `SessionUser` (import type from "@server/auth"): it is a superset of the public
 * `SessionUser` contract in shared/contracts/student.ts, so it is also assignable to that type,
 * and `toPublicSessionUser` produces the strict wire shape.
 */
import type { Role } from "@shared/taxonomy";

/** Which origin a session belongs to: the student app or the staff console on `curate.`. */
export type AuthSurface = "app" | "console";

export const WORKSPACE_LEVELS = ["owner", "advisor", "viewer"] as const;
export type WorkspaceLevel = (typeof WORKSPACE_LEVELS)[number];

export const ORGANIZATION_LEVELS = ["sponsor_admin", "sponsor_member"] as const;
export type OrganizationLevel = (typeof ORGANIZATION_LEVELS)[number];

export type GrantScope =
  | { kind: "global" }
  | { kind: "workspace"; workspaceId: string; level: WorkspaceLevel }
  | { kind: "organization"; organizationId: string; level: OrganizationLevel };

/** One live row of `user_roles` (or the implicit global student grant). */
export interface RoleGrant {
  role: Role;
  scope: GrantScope;
}

export interface SecondFactorState {
  /** A confirmed authenticator exists for this user. */
  enrolled: boolean;
  /** This session passed the second factor and the proof has not expired. */
  verified: boolean;
}

export interface SessionUser {
  /** Internal id; never put it in a URL or a response (use publicId). */
  id: string;
  publicId: string;
  email: string;
  displayName: string | null;
  /** Distinct roles across all scopes; always contains "student". */
  roles: Role[];
  onboarded: boolean;
  grants: readonly RoleGrant[];
  sessionId: string;
  sessionExpiresAt: number;
  surface: AuthSurface;
  secondFactor: SecondFactorState;
}

/** The bindings this module reads. server/env.ts's `Env` is a superset. */
export interface AuthBindings {
  DB: D1Database;
  APP_ORIGIN: string;
  ENVIRONMENT?: string;
  BETTER_AUTH_SECRET: string;
  EMAIL?: SendEmail;
  /** Per-IP limit on mail-sending endpoints (send-guard.ts); absent locally. */
  RATE_LIMIT_SEND?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** Turnstile server secret; when set, every code send needs a valid token (send-guard.ts). */
  TURNSTILE_SECRET_KEY?: string;
  /** Public Turnstile site key (not a secret). */
  readonly TURNSTILE_SITE_KEY?: string;
}

export interface AuthVariables {
  user?: SessionUser;
  requestId?: string;
}

/** The Hono env the auth middleware and routes are written against. */
export type AuthEnv = { Bindings: AuthBindings; Variables: AuthVariables };
