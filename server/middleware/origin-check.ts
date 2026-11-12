import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { getConfig, trustedOriginsFor } from "../config";
import { problemFor } from "../lib/problem";

/**
 * CSRF defence for cookie-authenticated writes (plan 02 2.3.3, 2.3.14): an unsafe method from a
 * browser must come from a trusted origin for the host it targets (the console host trusts only
 * the console origin; every other host trusts only the app origins). Browsers always send Origin on cross-origin POSTs and
 * Sec-Fetch-Site on modern engines; a request with neither is not from a browser page, carries
 * no ambient cookies worth forging, and is allowed (API clients, the pipeline, curl).
 *
 * Exempt: /internal/* (HMAC-signed), /mcp (no cookies), and the RFC 8058 one-click unsubscribe
 * endpoint /e/u/*, which mail providers POST to from their own origin by design.
 */

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const EXEMPT_PREFIXES = ["/internal/", "/mcp", "/e/u/"];

export type OriginVerdict = "allow" | "deny";

export function originVerdict(input: {
  method: string;
  pathname: string;
  origin: string | undefined;
  secFetchSite: string | undefined;
  trustedOrigins: readonly string[];
}): OriginVerdict {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return "allow";
  if (EXEMPT_PREFIXES.some((p) => input.pathname === p.replace(/\/$/, "") || input.pathname.startsWith(p))) return "allow";
  if (input.origin !== undefined) {
    // "null" is sent by sandboxed frames and some redirects: never trusted for a write.
    return input.trustedOrigins.includes(input.origin) ? "allow" : "deny";
  }
  if (input.secFetchSite !== undefined) {
    return input.secFetchSite === "same-origin" || input.secFetchSite === "none" ? "allow" : "deny";
  }
  return "allow";
}

export function originCheck(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const verdict = originVerdict({
      method: c.req.method,
      pathname: new URL(c.req.url).pathname,
      origin: c.req.header("origin"),
      secFetchSite: c.req.header("sec-fetch-site"),
      // Surface-aware: the staff console (curate.*) and the app each trust only their own origin.
      trustedOrigins: trustedOriginsFor(getConfig(c.env ?? {}), c.req.url),
    });
    if (verdict === "deny") return problemFor(c, "forbidden", { detail: "Cross-site request refused." });
    await next();
  };
}
