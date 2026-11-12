import { Hono, type MiddlewareHandler } from "hono";
import { requireRole } from "@server/auth";
import type { AppEnv } from "@server/env";
import { problemFor } from "@server/lib/problem";
import { parseInput } from "@server/lib/validation";
import { buildMetricsView, metricsWindow } from "./build";
import type { MetricsDeps } from "./ports";
import { engagementWeeks, funnelCounts, ingestCounts, onboardingRecordCounts, programVerifications, retentionRows, trackerSnapshot, type IngestCounts, type RetentionRow } from "./queries";
import { MetricsQuerySchema } from "./schemas";
import { weekStartMs } from "./weeks";

/**
 * GET /api/v1/admin/metrics?days=28&weeks=8 (plan 10.10.3: the founders' table on curate.).
 *
 * Guards, outermost first: requireRole("admin") (401 signed out, 403 without the role, 403
 * `second-factor-required` until TOTP; it also sets Cache-Control: no-store), then the console
 * surface in staging and production. The answer holds aggregates only, every student-derived
 * count suppressed below k = 5 (./suppress.ts).
 */

export const METRICS_PATH = "/admin/metrics";
export const STRICT_SURFACE_ENVIRONMENTS: ReadonlySet<string> = new Set(["staging", "production"]);

const EMPTY_INGEST: IngestCounts = { eventRows: 0, onboardingEventRows: 0, keyedEventRows: 0, lastEventAt: null };

function consoleOnly(deps: MetricsDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = deps.user(c);
    if (user && STRICT_SURFACE_ENVIRONMENTS.has(deps.environment(c)) && user.surface !== "console") {
      return problemFor(c, "forbidden", { detail: "Open the metrics on the curate. address." });
    }
    await next();
  };
}

export function createAdminMetricsRoutes(deps: MetricsDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get(METRICS_PATH, requireRole<AppEnv>("admin"), consoleOnly(deps), async (c) => {
    const parsed = parseInput(MetricsQuerySchema, Object.fromEntries(new URL(c.req.url).searchParams));
    if (!parsed.ok) return problemFor(c, parsed.code, { errors: parsed.errors });
    const { days, weeks } = parsed.data;
    const now = deps.now();
    const w = metricsWindow(now, days, weeks);
    const db = deps.db(c);
    const edb = deps.eventsDb(c);
    const seriesFrom = weekStartMs(w.firstWeek);

    const [ingest, funnel, retention, onboardingRecords, engagement, tracker, programs] = await Promise.all([
      edb ? ingestCounts(edb) : Promise.resolve(EMPTY_INGEST),
      edb ? funnelCounts(edb, w.from, w.to) : Promise.resolve(new Map<string, number>()),
      edb ? retentionRows(edb, w.firstWeek) : Promise.resolve([] as RetentionRow[]),
      onboardingRecordCounts(db, w.from, w.to, now),
      engagementWeeks(db, seriesFrom, now),
      trackerSnapshot(db, now),
      programVerifications(db),
    ]);

    return c.json(
      buildMetricsView({ now, days, weeks, eventsDb: edb ? "ok" : "unbound", ingest, funnel, onboardingRecords, retention, engagement, tracker, programs }),
    );
  });
  return app;
}
