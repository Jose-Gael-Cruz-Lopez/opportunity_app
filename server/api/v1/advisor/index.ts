import type { MiddlewareHandler } from "hono";
import { requireRole } from "@server/auth";
import { getDb, getEventsDb } from "@server/db/client";
import type { AppEnv } from "@server/env";
import type { AdvisorDeps } from "./ports";
import { createAdvisorRoutes } from "./routes";

export { createAdvisorRoutes, parseIfMatch, publicView } from "./routes";
export type { AdvisorDeps } from "./ports";
export { buildProgressView, PROGRESS_STAGES, STAGE_LABELS, type ProgressView } from "./aggregate";

/**
 * server/auth's requireRole("advisor"): 401 without a session, 403 without the role, and 403
 * with the second-factor problem type while the session has not passed TOTP (every non-student
 * role needs it, server/auth/permissions.ts). Handlers then check the workspace-scoped matrix
 * action with `can()` (./routes.ts).
 */
export const requireAdvisorRole: MiddlewareHandler<AppEnv> = requireRole<AppEnv>("advisor");

export const advisorDeps: AdvisorDeps = {
  requireAdvisor: requireAdvisorRole,
  user: (c) => c.get("user"),
  db: (c) => getDb(c.env.DB),
  eventsDb: (c) => (c.env.EVENTS_DB ? getEventsDb(c.env.EVENTS_DB) : null),
  now: () => Date.now(),
};

export const advisorRoutes = createAdvisorRoutes(advisorDeps);
