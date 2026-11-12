import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { getConfig } from "../config";
import { CACHE, HSTS_VALUE, PERMISSIONS_POLICY, buildCsp } from "../config/security";
import { setResponseHeaders } from "../lib/headers";

/**
 * Security headers on every Worker response, the /app shell included (plan 02 2.3.14). Handlers
 * may set their own Content-Security-Policy (a page that shows Turnstile) or Cache-Control (a
 * public page); everything else is filled in here, after the handler, only where missing.
 */

const BASE_POLICY = buildCsp();
const SPA_POLICY = buildCsp({ turnstile: true, inlineStyles: true });
const CONSOLE_POLICY = buildCsp({ turnstile: false, inlineStyles: false });

/** Paths that should never appear in search results, whatever the environment. */
const NOINDEX_PREFIXES = ["/app", "/curate", "/api/", "/internal/", "/cal/u/", "/e/", "/mcp", "/out/", "/r/", "/go/"];

/** The two SPA shells: the student app (/app) and the Curator console (/curate). */
export function isSpaPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/") || pathname === "/curate" || pathname.startsWith("/curate/");
}

function isConsolePath(pathname: string): boolean {
  return pathname === "/curate" || pathname.startsWith("/curate/");
}

export function shouldNoindex(pathname: string, environment: string): boolean {
  if (environment !== "production") return true;
  return NOINDEX_PREFIXES.some((p) => pathname === p.replace(/\/$/, "") || pathname.startsWith(p));
}

export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const config = getConfig(c.env ?? {});
    const pathname = new URL(c.req.url).pathname;

    const always: Record<string, string> = {
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "cross-origin-opener-policy": "same-origin",
      "permissions-policy": PERMISSIONS_POLICY,
    };
    if (!config.isLocal) always["strict-transport-security"] = HSTS_VALUE;
    setResponseHeaders(c, always);

    const defaults: Record<string, string> = {
      "content-security-policy": isConsolePath(pathname) ? CONSOLE_POLICY : isSpaPath(pathname) ? SPA_POLICY : BASE_POLICY,
      // The safe default: nothing is cached unless its handler chose a policy.
      "cache-control": CACHE.noStore,
    };
    if (shouldNoindex(pathname, config.environment)) defaults["x-robots-tag"] = "noindex, nofollow";
    setResponseHeaders(c, defaults, true);
  };
}
