import type { Context, MiddlewareHandler } from "hono";
import type { Db, EventsDb } from "@server/db/client";
import type { AppEnv, SessionUser } from "@server/env";

/**
 * What the advisor routes need from the rest of the Worker. Tests pass in-memory databases and a
 * fake session; production wiring (./index.ts) reads the D1 bindings and the session that
 * server/auth's sessionMiddleware puts on the context.
 */
export interface AdvisorDeps {
  /**
   * Must answer 401 without a session, 403 without the advisor role and 403 (second-factor
   * problem type) before the session passed TOTP: production passes requireRole("advisor").
   */
  readonly requireAdvisor: MiddlewareHandler<AppEnv>;
  /** The signed-in user, after requireAdvisor ran. */
  readonly user: (c: Context<AppEnv>) => SessionUser | undefined;
  readonly db: (c: Context<AppEnv>) => Db;
  /** novus-events, for list view counts; null when the binding is absent (counts show as unknown). */
  readonly eventsDb: (c: Context<AppEnv>) => EventsDb | null;
  readonly now: () => number;
}
