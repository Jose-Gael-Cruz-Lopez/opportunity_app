import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { getConfig } from "../config";
import { setResponseHeaders } from "../lib/headers";
import { isPublicApiGet } from "../lib/route-match";

/**
 * CORS for /api/* (plan 02 2.3.14):
 * - Trusted origins (the app origin; the Vite dev server when ENVIRONMENT is local) get
 *   credentialed CORS, so the SPA works from `vite dev` against `wrangler dev`.
 * - Any other origin gets `*` without credentials, and only on public GET routes from the route
 *   map. Everything else gets no CORS headers at all, so browsers refuse cross-site reads.
 */

const ALLOW_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOW_HEADERS = "content-type, idempotency-key, if-none-match, if-match, x-request-id";
const EXPOSE_HEADERS = "etag, retry-after, x-request-id";
const PREFLIGHT_MAX_AGE = "600";

export type CorsDecision =
  | { readonly kind: "trusted"; readonly origin: string }
  | { readonly kind: "public" }
  | { readonly kind: "none" };

export function corsDecision(
  origin: string | undefined,
  method: string,
  pathname: string,
  trustedOrigins: readonly string[],
): CorsDecision {
  if (!origin) return { kind: "none" };
  if (trustedOrigins.includes(origin)) return { kind: "trusted", origin };
  const m = method.toUpperCase();
  if ((m === "GET" || m === "HEAD" || m === "OPTIONS") && isPublicApiGet(pathname)) return { kind: "public" };
  return { kind: "none" };
}

export function cors(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    const { trustedOrigins } = getConfig(c.env ?? {});
    const decision = corsDecision(origin, c.req.method, new URL(c.req.url).pathname, trustedOrigins);

    if (c.req.method === "OPTIONS" && c.req.header("access-control-request-method")) {
      const headers = new Headers({ vary: "Origin", "cache-control": "no-store" });
      if (decision.kind === "trusted") {
        headers.set("access-control-allow-origin", decision.origin);
        headers.set("access-control-allow-credentials", "true");
        headers.set("access-control-allow-methods", ALLOW_METHODS);
        headers.set("access-control-allow-headers", ALLOW_HEADERS);
        headers.set("access-control-max-age", PREFLIGHT_MAX_AGE);
      } else if (decision.kind === "public") {
        headers.set("access-control-allow-origin", "*");
        headers.set("access-control-allow-methods", "GET, HEAD");
        headers.set("access-control-allow-headers", "if-none-match");
        headers.set("access-control-max-age", PREFLIGHT_MAX_AGE);
      }
      return new Response(null, { status: 204, headers });
    }

    await next();
    const vary = c.res.headers.get("vary");
    const headers: Record<string, string> = {
      vary: vary && !/\borigin\b/i.test(vary) ? `${vary}, Origin` : (vary ?? "Origin"),
    };
    if (decision.kind === "trusted") {
      headers["access-control-allow-origin"] = decision.origin;
      headers["access-control-allow-credentials"] = "true";
      headers["access-control-expose-headers"] = EXPOSE_HEADERS;
    } else if (decision.kind === "public") {
      headers["access-control-allow-origin"] = "*";
      headers["access-control-expose-headers"] = EXPOSE_HEADERS;
    }
    // setResponseHeaders copes with immutable responses (fetch() or a passthrough from a library).
    setResponseHeaders(c, headers);
  };
}
