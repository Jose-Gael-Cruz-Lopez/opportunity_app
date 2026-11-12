import { getDb, getEventsDb } from "@server/db/client";
import type { MetricsDeps } from "./ports";
import { createAdminMetricsRoutes } from "./routes";

/**
 * server/api/v1/admin/metrics: the founders' metrics view (plan 10.10). Mount under /api/v1 on
 * the registry router, next to the Curator routes:
 *
 *   registryRoutes: new Hono()...route("/", adminMetricsRoutes)
 *
 * See README.md for the definitions, the suppression rule and what is still missing.
 */

export { createAdminMetricsRoutes, METRICS_PATH } from "./routes";
export { AdminMetricsViewSchema, MetricsQuerySchema, type AdminMetricsView } from "./schemas";
export { K_MIN } from "./suppress";
export type { MetricsDeps } from "./ports";

export const adminMetricsDeps: MetricsDeps = {
  db: (c) => getDb(c.env.DB),
  eventsDb: (c) => (c.env.EVENTS_DB ? getEventsDb(c.env.EVENTS_DB) : null),
  user: (c) => c.get("user"),
  now: () => Date.now(),
  environment: (c) => c.env.ENVIRONMENT ?? "local",
};

export const adminMetricsRoutes = createAdminMetricsRoutes(adminMetricsDeps);
