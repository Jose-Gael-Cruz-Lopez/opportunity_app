import { getDb } from "@server/db/client";
import { createLogger } from "@server/lib/log";
import type { CuratorDeps } from "./ports";
import { createCuratorRoutes } from "./routes";

/**
 * server/api/v1/curator: the Curator review-task API, the ops pipeline view and release
 * rollback. Mount under /api/v1 next to the registry router (route-map mount `registry`):
 *
 *   app.route("/api/v1", curatorRoutes)
 *
 * See docs/curator.md for the workflow, the publish batch and what the route map still lacks.
 */

export { createCuratorRoutes } from "./routes";
export type { CuratorDeps, CuratorBucket, CuratorLog } from "./ports";
export { CuratorResolveSchema, EditsSchema, QueueQuerySchema, QueueResponseSchema, REJECT_REASONS } from "./schemas";
export { HIGH_IMPACT_REASONS, highImpactReasons } from "./impact";
export { KIND_SEVERITY, CLAIM_LEASE_MS } from "./queue";

const logger = createLogger();

export const curatorDeps: CuratorDeps = {
  db: (c) => getDb(c.env.DB),
  bucket: (c) => c.env.STORE ?? null,
  user: (c) => c.get("user"),
  now: () => Date.now(),
  environment: (c) => c.env.ENVIRONMENT ?? "local",
  log: (level, event, fields) => {
    const line = fields ?? {};
    if (level === "alert" || level === "error") logger.error(event, { ...line, alert: level === "alert" });
    else if (level === "warn") logger.warn(event, line);
    else logger.info(event, line);
  },
};

export const curatorRoutes = createCuratorRoutes(curatorDeps);
