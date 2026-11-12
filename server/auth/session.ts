/**
 * Session loading and the route guards: sessionMiddleware, requireUser, requireRole and
 * requirePermission.
 */
import { createMiddleware } from "hono/factory";
import { and, eq, isNull } from "drizzle-orm";
import type { Role } from "@shared/taxonomy";
import type { SessionUser as PublicSessionUser } from "@shared/contracts/student";
import { getDb } from "@server/db/client";
import { users } from "@server/db/schema";
import { getAuth } from "./better-auth";
import { SESSION_COOKIE_NAME, SHARED_DEVICE_COOKIE_NAME, surfaceForUrl } from "./config";
import { loadGrants, rolesOf } from "./grants";
import { NO_STORE, problemFor, readCookie, rewriteForSharedDevice } from "./http";
import type { AuthMailer } from "./mailer";
import { decide, requiresSecondFactor, type PermissionAction, type PermissionResource } from "./permissions";
import { secondFactorState } from "./second-factor";
import type { AuthBindings, AuthEnv, SessionUser } from "./types";

/** Test and wiring hooks; production uses the defaults. */
export interface AuthRuntime {
  mailer?: AuthMailer;
  rateLimit?: boolean;
  now?: () => number;
}

export interface LoadedSession {
  user: SessionUser | null;
  /** Set-Cookie values from a rolling refresh, to pass on to the client. */
  setCookies: string[];
}

const ANONYMOUS: LoadedSession = { user: null, setCookies: [] };

/** The `type` URI a client checks to start the TOTP step-up instead of showing "forbidden". */
export const SECOND_FACTOR_PROBLEM_TYPE = "/problems/second-factor-required";

function hasSessionCookie(request: Request): boolean {
  const header = request.headers.get("cookie");
  return !!header && header.includes(SESSION_COOKIE_NAME);
}

/** Resolves the signed-in user for a request, or null. Never throws: failures read as signed out. */
export async function loadSessionUser(env: AuthBindings, request: Request, runtime: AuthRuntime = {}): Promise<LoadedSession> {
  // Most requests (public pages, crawlers) carry no session cookie; skip D1 entirely for them.
  if (!hasSessionCookie(request)) return ANONYMOUS;
  const now = runtime.now?.() ?? Date.now();
  const surface = surfaceForUrl(request.url);
  try {
    const auth = getAuth(env, surface, runtime.mailer, runtime.rateLimit ?? true);
    const result = await auth.api.getSession({ headers: request.headers, returnHeaders: true });
    const found = result.response;
    let setCookies = result.headers?.getSetCookie?.() ?? [];
    if (readCookie(request.headers.get("cookie"), SHARED_DEVICE_COOKIE_NAME)) setCookies = rewriteForSharedDevice(setCookies);
    if (!found) return { user: null, setCookies };

    const db = getDb(env.DB);
    const rows = await db
      .select({ publicId: users.publicId, email: users.email, name: users.name, onboardedAt: users.onboardedAt })
      .from(users)
      .where(and(eq(users.id, found.user.id), isNull(users.deletedAt)))
      .limit(1);
    const row = rows[0];
    // A soft-deleted account keeps no access even if a session row survived the deletion.
    if (!row) return { user: null, setCookies };

    const grants = await loadGrants(db, found.user.id);
    const staff = grants.some((g) => requiresSecondFactor(g.role));
    const sessionExpiresAt = new Date(found.session.expiresAt).getTime();
    const secondFactor = staff
      ? await secondFactorState(db, found.user.id, found.session.id, now)
      : { enrolled: false, verified: false };

    const user: SessionUser = {
      id: found.user.id,
      publicId: row.publicId,
      email: row.email,
      displayName: row.name.trim() ? row.name.trim().slice(0, 80) : null,
      roles: rolesOf(grants),
      onboarded: row.onboardedAt !== null,
      grants,
      sessionId: found.session.id,
      sessionExpiresAt,
      surface,
      secondFactor,
    };
    return { user, setCookies };
  } catch (err) {
    // Log the class only: messages from the adapter can echo SQL parameters such as emails.
    console.error(`[auth] session lookup failed: ${err instanceof Error ? err.name : "unknown"}`);
    return ANONYMOUS;
  }
}

/** The strict wire shape for `GET /api/v1/me/session`. */
export function toPublicSessionUser(user: SessionUser): PublicSessionUser {
  return {
    publicId: user.publicId,
    email: user.email,
    displayName: user.displayName,
    roles: user.roles,
    onboarded: user.onboarded,
  };
}

// Requests already resolved by an outer sessionMiddleware (the app and authRoutes both mount it).
const resolved = new WeakSet<Request>();

/** Builds the session middleware; `sessionMiddleware` is the production instance. */
export function createSessionMiddleware(runtime: AuthRuntime = {}) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    if (resolved.has(c.req.raw)) return next();
    resolved.add(c.req.raw);
    const { user, setCookies } = await loadSessionUser(c.env, c.req.raw, runtime);
    if (user) c.set("user", user);
    await next();
    if (setCookies.length === 0) return;
    const res = new Response(c.res.body, c.res);
    for (const v of setCookies) res.headers.append("set-cookie", v);
    // A response that refreshes a session cookie must never be stored by a shared cache.
    res.headers.set("cache-control", NO_STORE);
    c.res = res;
  });
}

/** Resolves `c.var.user` when a valid session cookie is present; never rejects a request. */
export const sessionMiddleware = createSessionMiddleware();

/** 401 unless signed in. Marks the response private, since it depends on the session. */
export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
  if (!c.get("user")) return problemFor(c, "unauthenticated");
  await next();
  c.header("cache-control", NO_STORE);
});

function secondFactorProblem(c: Parameters<typeof problemFor>[0], enrolled: boolean): Response {
  return problemFor(c, "forbidden", {
    type: SECOND_FACTOR_PROBLEM_TYPE,
    detail: enrolled ? "Confirm the code from your authenticator app to continue." : "Set up an authenticator app to continue.",
  });
}

/**
 * 401 unless signed in; 403 unless the user holds one of `roles` (in any scope). A non-student
 * role counts only once this session has passed the second factor; scoped checks (which
 * workspace, which Organization) belong to `can()` in the handler.
 * `E` lets a module typed with a wider env (server/env.ts AppEnv) mount it without a cast.
 */
export function requireRole<E extends AuthEnv = AuthEnv>(...roles: Role[]) {
  return createMiddleware<E>(async (c, next) => {
    // Generic over E so modules typed with the app's wider env (AppEnv) can use it; the
    // annotation restores the type that a generic Context's get() loses.
    const user: SessionUser | undefined = c.get("user");
    if (!user) return problemFor(c, "unauthenticated");
    const held = roles.filter((r) => user.roles.includes(r));
    if (held.length === 0) return problemFor(c, "forbidden");
    const usable = held.some((r) => !requiresSecondFactor(r) || user.secondFactor.verified);
    if (!usable) return secondFactorProblem(c, user.secondFactor.enrolled);
    await next();
    c.header("cache-control", NO_STORE);
  });
}

/**
 * Guards a route with one matrix action. `resourceOf` reads what the decision needs from the
 * request (for example the workspace id path parameter).
 */
export function requirePermission(
  action: PermissionAction,
  resourceOf: (c: Parameters<typeof problemFor>[0]) => PermissionResource | Promise<PermissionResource> = () => ({}),
) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    const user = c.get("user") ?? null;
    const decision = decide(user, action, await resourceOf(c));
    if (!decision.allowed) {
      if (decision.reason === "unauthenticated") return problemFor(c, "unauthenticated");
      if (decision.reason === "second_factor_required") return secondFactorProblem(c, user?.secondFactor.enrolled ?? false);
      return problemFor(c, "forbidden");
    }
    await next();
    if (user) c.header("cache-control", NO_STORE);
  });
}
