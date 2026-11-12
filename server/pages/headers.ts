import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

/**
 * Browser caching for public pages. Security headers (one static CSP with no nonce, since pages
 * have no inline scripts or style attributes) come from the global securityHeaders middleware.
 *
 * Two caches with different rules sit in front of a page (plan s02 2.3.2):
 * - the Worker's Cache API copy (server/middleware/edge-cache.ts), five minutes, stored only when
 *   the handler answers `public, max-age=60`;
 * - the browser, whose policy is set here, outermost, after the edge cache has decided. Pages
 *   whose islands can render private answers reach browsers as `no-store`, which also keeps them
 *   out of the back-forward cache, while the Worker still caches the anonymous HTML.
 */

export const BROWSER_CACHE = {
  /** Program and Explore pages: islands there can show eligibility answers. */
  private: "no-store",
  /** Landing and Deadlines: a minute, matching the route map. */
  listing: "public, max-age=60",
  /** Methods, the bot page and text files. */
  editorial: "public, max-age=300",
  /** Content-hashed page assets and immutable release files. */
  immutable: "public, max-age=31536000, immutable",
  none: "no-store",
} as const;

export type BrowserCachePolicy = keyof typeof BROWSER_CACHE;

/** What a handler must answer for the edge cache to keep a copy. */
export const EDGE_STORABLE = "public, max-age=60";

/** Replaces Cache-Control on successful responses (200 and 304) with the browser policy. */
export function browserCache(policy: BrowserCachePolicy): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (c.res.status !== 200 && c.res.status !== 304) return;
    const value = BROWSER_CACHE[policy];
    try {
      c.res.headers.set("cache-control", value);
    } catch {
      // Responses rebuilt from the Cache API can carry immutable headers: copy once.
      const copy = new Response(c.res.body, c.res);
      copy.headers.set("cache-control", value);
      c.res = undefined as unknown as Response;
      c.res = copy;
    }
  };
}
