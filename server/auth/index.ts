/**
 * server/auth: Better Auth (email one-time codes, D1 sessions), roles and scoped grants, the
 * staff TOTP step-up, and the permission matrix behind `can()`.
 *
 * Wiring (server/app.ts):
 *   app.use("*", sessionMiddleware);          // resolves c.var.user when a session cookie exists
 *   app.route("/api/auth", authRoutes);       // code sign-in, sign-out, staff second factor
 *   registry.get("/review-tasks", requireRole("curator", "admin"), handler);
 *   if (!can(c.var.user, "workspace.lists.manage", { workspaceId })) return forbidden;
 */
export { authRoutes, createAuthRoutes, BETTER_AUTH_ALLOWLIST } from "./routes";
export {
  sessionMiddleware,
  createSessionMiddleware,
  requireUser,
  requireRole,
  requirePermission,
  loadSessionUser,
  toPublicSessionUser,
  SECOND_FACTOR_PROBLEM_TYPE,
  type AuthRuntime,
  type LoadedSession,
} from "./session";
export {
  can,
  decide,
  permissionRow,
  requiresSecondFactor,
  PERMISSION_MATRIX,
  PERMISSION_ACTIONS,
  PUBLIC_DOCUMENT_PURPOSES,
  DOCUMENT_PURPOSES,
  type PermissionAction,
  type PermissionResource,
  type PermissionRow,
  type Decision,
  type DenyReason,
  type Obligation,
  type Condition,
} from "./permissions";
export { getAuth, buildAuth, type NovusAuth } from "./better-auth";
export { mailerFromEnv, renderSignInCode, type AuthMailer, type SignInCodeMessage } from "./mailer";
export { guardCodeSend, SEND_CODE_LIMITS, TURNSTILE_HEADER, type SendGuardResult } from "./send-guard";
export { loadGrants, grantsFromRows, rolesOf } from "./grants";
export { resetSecondFactor, sweepSecondFactorProofs } from "./second-factor";
export { secondFactorSchema, staffSecondFactors, sessionSecondFactors } from "./schema";
export * from "./config";
export type {
  SessionUser,
  RoleGrant,
  GrantScope,
  AuthSurface,
  AuthBindings,
  AuthEnv,
  AuthVariables,
  WorkspaceLevel,
  OrganizationLevel,
  SecondFactorState,
} from "./types";
