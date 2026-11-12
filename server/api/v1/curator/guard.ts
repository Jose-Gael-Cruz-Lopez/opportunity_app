import { and, eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { requireRole } from "@server/auth";
import type { Db } from "@server/db/client";
import * as s from "@server/db/schema";
import type { AppEnv, SessionUser } from "@server/env";
import { problemFor } from "@server/lib/problem";
import type { CuratorDeps } from "./ports";

/**
 * Access to the Curator API, outermost first:
 *
 * 1. `requireRole("curator", "admin")` (server/auth): 401 signed out, 403 without the role, and
 *    403 with type `/problems/second-factor-required` until this session passes TOTP. Every
 *    non-student role needs the second factor (plan 2.3.10), so this is the TOTP requirement.
 * 2. Console surface: in staging and production the session must belong to `curate.` (Strict
 *    cookie, 12-hour fixed session, behind Cloudflare Access; plan 01 F-16). A curator's app
 *    session on the main origin cannot work tasks. Local development accepts both surfaces.
 * 3. A Curator identity: an active `curators` row linked to the account, because verifications
 *    are signed with the public handle (`verified_by`). Admins without a handle may read the ops
 *    view and roll a release back, but cannot work tasks.
 */

export const STRICT_SURFACE_ENVIRONMENTS: ReadonlySet<string> = new Set(["staging", "production"]);

export interface CuratorIdentity {
  /** curators.id */
  id: string;
  handle: string;
  isAdmin: boolean;
  userId: string;
}

export function consoleSurface(deps: CuratorDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = deps.user(c);
    if (user && STRICT_SURFACE_ENVIRONMENTS.has(deps.environment(c)) && user.surface !== "console") {
      return problemFor(c, "forbidden", { detail: "Open the Curator console on the curate. address to work tasks." });
    }
    await next();
  };
}

export const requireCuratorRole: MiddlewareHandler<AppEnv> = requireRole<AppEnv>("curator", "admin");
export const requireAdminRole: MiddlewareHandler<AppEnv> = requireRole<AppEnv>("admin");

export async function loadCuratorIdentity(db: Db, user: SessionUser): Promise<CuratorIdentity | null> {
  const row = await db.query.curators.findFirst({ where: and(eq(s.curators.userId, user.id), eq(s.curators.active, true)) });
  if (!row) return null;
  return { id: row.id, handle: row.publicHandle, isAdmin: user.roles.includes("admin"), userId: user.id };
}

const identities = new WeakMap<Request, CuratorIdentity>();

/** 403 unless the signed-in user has an active Curator handle; later handlers read it with `curatorOf`. */
export function requireCuratorIdentity(deps: CuratorDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = deps.user(c);
    if (!user) return problemFor(c, "unauthenticated");
    const identity = await loadCuratorIdentity(deps.db(c), user);
    if (!identity) return problemFor(c, "forbidden", { detail: "This account has no active Curator handle." });
    identities.set(c.req.raw, identity);
    await next();
  };
}

export function curatorOf(c: Context<AppEnv>): CuratorIdentity {
  const identity = identities.get(c.req.raw);
  if (!identity) throw new Error("curatorOf called outside requireCuratorIdentity");
  return identity;
}
