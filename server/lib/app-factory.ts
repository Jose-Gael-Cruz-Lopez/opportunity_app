import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../env";
import { API_BODY_LIMIT_BYTES, API_BODY_LIMIT_OVERRIDES } from "../config/security";
import {
  accessLog,
  byIp,
  cors,
  errorHandler,
  etag,
  healthz,
  notFoundHandler,
  originCheck,
  rateLimit,
  readOnlyGuard,
  readyz,
  requestId,
  requireFlag,
  securityHeaders,
  sensitiveGuard,
  consoleShell,
  spaShell,
  type Reporter,
} from "../middleware";
import { problemFor } from "./problem";
import type { FlagSnapshot } from "./flags";

/**
 * Builds the Worker's Hono app from its route modules. server/app.ts passes the real modules;
 * tests pass stubs, so the middleware stack is tested without every feature module.
 *
 * Order matters and is fixed here:
 *  1. request id, access log and security headers wrap everything (outermost);
 *  2. origin check on unsafe methods (CSRF), CORS on /api/*;
 *  3. /api/v1: body limit, sensitive-key guard, read-only switch, per-IP limit, session, ETag;
 *  4. /mcp behind the mcp.enabled flag (/internal/v1 verifies HMAC, nonce and key scope inside
 *     server/internal, which owns that table; a second verifier here would burn the nonce);
 *  5. routers, the /app shell, the /curate console shell, and public pages last (they own "/").
 */

// Sub-apps are typed by their own modules (some narrow Bindings to what they read), so the
// factory accepts any Hono instance; app.route() does not need their env type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RouteModule = Hono<any, any, any>;

export interface AppModules {
  readonly authRoutes: RouteModule;
  readonly registryRoutes: RouteModule;
  readonly studentRoutes: RouteModule;
  readonly advisorRoutes: RouteModule;
  readonly calRoutes: RouteModule;
  readonly internalRoutes: RouteModule;
  readonly mcpRoutes: RouteModule;
  readonly pageRoutes: RouteModule;
  /**
   * Resolves the session cookie into c.var.user for /api/v1 (from server/auth). Typed loosely for
   * the same reason as RouteModule: it is written against auth's narrower bindings.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly sessionMiddleware?: MiddlewareHandler<any>;
}

export interface ComposeOptions {
  readonly report?: Reporter;
  readonly loadFlags?: (env: AppEnv["Bindings"]) => Promise<FlagSnapshot>;
  /** Anonymous per-IP ceiling across /api/v1 (judgment; tighter limits sit on costly routes). */
  readonly publicRatePerMinute?: number;
}

export function composeApp(modules: AppModules, options: ComposeOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", requestId(), accessLog(), securityHeaders());
  app.onError(errorHandler(options.report));
  app.notFound(notFoundHandler);

  app.get("/healthz", healthz);
  app.get("/readyz", readyz());

  app.use("*", originCheck());
  app.use("/api/*", cors());

  // One body limit per request: the default, or a listed path's own (exact path match).
  const tooLarge = (c: Parameters<typeof problemFor>[0]) => problemFor(c, "payload_too_large");
  const defaultLimit = bodyLimit({ maxSize: API_BODY_LIMIT_BYTES, onError: tooLarge });
  const overrideLimits = new Map(API_BODY_LIMIT_OVERRIDES.map((o) => [o.path, bodyLimit({ maxSize: o.maxBytes, onError: tooLarge })]));
  const apiBodyLimit: MiddlewareHandler<AppEnv> = (c, next) => (overrideLimits.get(c.req.path.replace(/\/+$/, "")) ?? defaultLimit)(c, next);

  app.use(
    "/api/v1/*",
    apiBodyLimit,
    sensitiveGuard(),
    options.loadFlags ? readOnlyGuard(options.loadFlags) : readOnlyGuard(),
    rateLimit({
      name: "public_api",
      key: byIp,
      rules: [{ limit: options.publicRatePerMinute ?? 300, windowMs: 60_000 }],
      binding: (env) => env.RATE_LIMIT_PUBLIC,
    }),
  );
  if (modules.sessionMiddleware) app.use("/api/v1/*", modules.sessionMiddleware);
  app.use("/api/v1/*", etag());

  const mcpGate = options.loadFlags ? requireFlag("mcp.enabled", options.loadFlags) : requireFlag("mcp.enabled");
  app.use("/mcp", mcpGate);
  app.use("/mcp/*", mcpGate);

  app.route("/api/auth", modules.authRoutes);
  app.route("/api/v1", modules.registryRoutes);
  app.route("/api/v1", modules.studentRoutes);
  app.route("/api/v1", modules.advisorRoutes);
  app.route("/cal", modules.calRoutes);
  app.route("/internal/v1", modules.internalRoutes);
  app.route("/mcp", modules.mcpRoutes);

  app.get("/app", spaShell);
  app.get("/app/*", spaShell);
  // Curator console (second Vite entry); 404 outside local unless the host is curate.<domain>.
  app.get("/curate", consoleShell);
  app.get("/curate/*", consoleShell);

  app.route("/", modules.pageRoutes);
  return app;
}
