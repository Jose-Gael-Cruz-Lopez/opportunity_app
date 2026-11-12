import { Hono } from "hono";
import type { AppEnv } from "./env";
import { composeApp } from "./lib/app-factory";
import { adminMetricsRoutes } from "./api/v1/admin/metrics";
import { advisorRoutes } from "./api/v1/advisor";
import { curatorRoutes } from "./api/v1/curator";
import { curatorImportRoutes } from "./api/v1/curator/import";
import { eventsRoutes } from "./api/v1/events";
import { onboardingRoutes } from "./api/v1/onboarding";
import { outcomesRoutes } from "./api/v1/outcomes";
import { registryRoutes } from "./api/v1/registry";
import { remindLinkRoutes, remindRoutes } from "./api/v1/remind";
import { studentRoutes } from "./api/v1/student";
import { authRoutes, sessionMiddleware } from "./auth";
import { turnstileConfigRoutes } from "./auth/turnstile";
import { calRoutes } from "./cal";
import { internalRoutes } from "./internal";
import { mcpRoutes } from "./mcp";
import { pageRoutes } from "./pages";
import { islandAssetRoutes } from "./pages/islands";
import { emailLinkRoutes } from "./services/email";

/**
 * The Worker's Hono app. Mounts (shared/contracts/routes.ts MOUNT_BASES):
 *   /api/auth    authRoutes (Better Auth)
 *   /api/v1      registryRoutes (+ remindRoutes, eventsRoutes, curatorRoutes, curatorImportRoutes,
 *                adminMetricsRoutes, /turnstile config),
 *                studentRoutes (+ onboardingRoutes, outcomesRoutes), advisorRoutes
 *   /cal         calRoutes
 *   /internal/v1 internalRoutes (HMAC-verified before they run; read c.var.internalKeyId)
 *   /mcp         mcpRoutes (behind the mcp.enabled flag)
 *   /app/*       SPA shell from ASSETS; /curate/* the Curator console shell (staff host only)
 *   /            emailLinkRoutes (/e/u/:token), remindLinkRoutes (/e/rc/:token), islandAssetRoutes
 *                (/p/i/:file), then pageRoutes (public Hono JSX pages, data files, redirects)
 * The middleware stack is in server/lib/app-factory.ts.
 */
export function createApp(): Hono<AppEnv> {
  return composeApp({
    authRoutes,
    // Remind me (POST /remind-me, Turnstile checked inside, fails closed), first-party analytics
    // and client error reports (public, parse their own text/plain beacons), the Curator
    // review-task API, candidate import and ops routes, the founders' metrics (each staff router
    // guards its own role and the console surface), and the public Turnstile widget config.
    registryRoutes: new Hono()
      .route("/", registryRoutes)
      .route("/", remindRoutes)
      .route("/", eventsRoutes)
      .route("/", curatorRoutes)
      .route("/", curatorImportRoutes)
      .route("/", adminMetricsRoutes)
      .route("/turnstile", turnstileConfigRoutes()),
    // Onboarding and outcomes are part of the signed-in student surface; onboarding's middleware
    // is scoped to /onboarding/*, and the outcome routes call requireStudent per route (the
    // /programs/:slug/outcomes/summary read is public), so combining the routers changes nothing
    // for the other student paths.
    studentRoutes: new Hono().route("/", studentRoutes).route("/", onboardingRoutes).route("/", outcomesRoutes),
    advisorRoutes,
    calRoutes,
    internalRoutes,
    mcpRoutes,
    // Email links and island assets first: the pages router answers its own 404 page for
    // unknown paths.
    pageRoutes: new Hono().route("/", emailLinkRoutes).route("/", remindLinkRoutes).route("/", islandAssetRoutes).route("/", pageRoutes),
    sessionMiddleware,
  });
}
