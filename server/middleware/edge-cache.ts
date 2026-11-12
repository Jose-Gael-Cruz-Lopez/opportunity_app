import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import {
  LAST_GOOD_TTL,
  computeETag,
  defaultCache,
  escapeHtml,
  ifNoneMatchMatches,
  isPrivateCacheControl,
  lastGoodKey,
  pageCacheKey,
  type CacheLike,
} from "../lib/cache";
import { logFor } from "../lib/log";

/**
 * Edge cache for public pages (plan 02 2.3.2):
 * - Rendered HTML stays in the Cache API for 5 minutes, so an approved change shows everywhere
 *   within 5 minutes with no publisher job.
 * - Every successful render also writes a last-good copy under a separate key, kept 1 day when a
 *   handler marks a deadline within 14 days (`x-novus-near-deadline: 1`) and 7 days otherwise.
 * - When rendering fails (a D1 outage), the last-good copy is served with an "as of" banner, or
 *   the `fallback` renders a reduced page; only then does the error stand.
 * - No personalization reaches the cache: Cookie and Authorization are stripped before the
 *   handler runs, and a response that sets a cookie, is private, or was rendered for a signed-in
 *   user is never stored.
 *
 *   pageRoutes.get("/programs/:slug", edgeCache(), renderProgram);
 */

export const RENDERED_AT_HEADER = "x-novus-rendered-at";
export const NEAR_DEADLINE_HEADER = "x-novus-near-deadline";
export const CACHE_STATUS_HEADER = "x-novus-cache";

export interface EdgeCacheOptions {
  /** Seconds the fresh copy lives in the Worker cache. */
  readonly ttlSeconds?: number;
  /** Query parameters that change the page (everything else is dropped from the key). */
  readonly varyParams?: readonly string[];
  /** Cache to use; defaults to caches.default, and caching is skipped where none exists. */
  readonly cache?: CacheLike | null;
  /** Renders a reduced page (e.g. from the R2 release artifact) when no last-good copy exists. */
  readonly fallback?: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => Promise<Response | null>;
  readonly now?: () => number;
}

const STRIPPED_REQUEST_HEADERS = ["cookie", "authorization"];
/** Headers that are ours to manage and never go back to a browser from the cache. */
const INTERNAL_HEADERS = [RENDERED_AT_HEADER, NEAR_DEADLINE_HEADER];

function waitUntil(c: Parameters<MiddlewareHandler<AppEnv>>[0], task: Promise<unknown>): void {
  const safe = task.catch(() => undefined);
  try {
    c.executionCtx.waitUntil(safe);
  } catch {
    // No execution context outside workerd; the promise still settles.
  }
}

function withHeaders(res: Response, set: Record<string, string>, remove: readonly string[] = []): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(set)) headers.set(k, v);
  for (const k of remove) headers.delete(k);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** Injects the stale banner after <body> where HTMLRewriter exists (workerd); else unchanged. */
export function addStaleBanner(res: Response, renderedAtMs: number | null): Response {
  const Rewriter = (globalThis as unknown as { HTMLRewriter?: new () => HTMLRewriter }).HTMLRewriter;
  if (!Rewriter) return res;
  const when = renderedAtMs ? new Date(renderedAtMs).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "earlier";
  const banner = `<div class="novus-stale-banner" role="status">Showing a saved copy from ${escapeHtml(when)}. Live data is temporarily unavailable; check the official site before you rely on a date.</div>`;
  return new Rewriter()
    .on("body", {
      element(el) {
        el.prepend(banner, { html: true });
      },
    })
    .transform(res);
}

export function edgeCache(options: EdgeCacheOptions = {}): MiddlewareHandler<AppEnv> {
  const ttl = options.ttlSeconds ?? 300;
  const now = options.now ?? Date.now;
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return next();
    const cache = options.cache === undefined ? defaultCache() : options.cache;

    // Public handlers never see cookies, so they cannot personalise what gets cached.
    const stripped = new Headers(c.req.raw.headers);
    STRIPPED_REQUEST_HEADERS.forEach((h) => stripped.delete(h));
    c.req.raw = new Request(c.req.raw.url, { method: c.req.raw.method, headers: stripped });

    const key = pageCacheKey(new URL(c.req.url), options.varyParams);
    if (cache) {
      const hit = await cache.match(key);
      if (hit) {
        const tag = hit.headers.get("etag");
        if (tag && ifNoneMatchMatches(c.req.header("if-none-match"), tag)) {
          return new Response(null, { status: 304, headers: { etag: tag, [CACHE_STATUS_HEADER]: "HIT" } });
        }
        return withHeaders(hit, { [CACHE_STATUS_HEADER]: "HIT" }, INTERNAL_HEADERS);
      }
    }

    await next();
    const res = c.res;

    if (res.status >= 500 || c.error) {
      const lastGood = cache ? await cache.match(lastGoodKey(key)) : undefined;
      if (lastGood) {
        logFor(c).warn("served_last_good", { cache: "last_good" });
        const renderedAt = Number(lastGood.headers.get(RENDERED_AT_HEADER)) || null;
        const stale = withHeaders(lastGood, { [CACHE_STATUS_HEADER]: "STALE", "cache-control": "no-store" }, [...INTERNAL_HEADERS, "etag"]);
        c.res = undefined as unknown as Response;
        c.res = addStaleBanner(stale, renderedAt);
        return;
      }
      const reduced = options.fallback ? await options.fallback(c).catch(() => null) : null;
      if (reduced) {
        c.res = undefined as unknown as Response;
        c.res = withHeaders(reduced, { [CACHE_STATUS_HEADER]: "FALLBACK", "cache-control": "no-store" });
      }
      return;
    }

    const cacheControl = res.headers.get("cache-control");
    const storable =
      res.status === 200 &&
      !res.headers.has("set-cookie") &&
      !isPrivateCacheControl(cacheControl) &&
      c.get("user") === undefined;
    if (!storable) {
      if (res.status === 200) c.res.headers.set(CACHE_STATUS_HEADER, "BYPASS");
      return;
    }

    const body = await res.arrayBuffer();
    const tag = await computeETag(body);
    const renderedAt = String(now());
    const nearDeadline = res.headers.get(NEAR_DEADLINE_HEADER) === "1";
    const browserHeaders = new Headers(res.headers);
    INTERNAL_HEADERS.forEach((h) => browserHeaders.delete(h));
    browserHeaders.set("etag", tag);
    browserHeaders.set(CACHE_STATUS_HEADER, "MISS");

    if (cache) {
      const stored = new Headers(browserHeaders);
      stored.delete(CACHE_STATUS_HEADER);
      // The Cache API expires entries by the stored Cache-Control, separate from the browser's.
      const fresh = new Headers(stored);
      fresh.set("cache-control", `public, max-age=${ttl}`);
      const keep = new Headers(stored);
      keep.set("cache-control", `public, max-age=${nearDeadline ? LAST_GOOD_TTL.nearDeadline : LAST_GOOD_TTL.default}`);
      keep.set(RENDERED_AT_HEADER, renderedAt);
      waitUntil(
        c,
        Promise.all([
          cache.put(key, new Response(body.slice(0), { status: 200, headers: fresh })),
          cache.put(lastGoodKey(key), new Response(body.slice(0), { status: 200, headers: keep })),
        ]),
      );
    }

    c.res = undefined as unknown as Response;
    if (ifNoneMatchMatches(c.req.header("if-none-match"), tag)) {
      browserHeaders.delete("content-length");
      c.res = new Response(null, { status: 304, headers: browserHeaders });
    } else {
      c.res = new Response(body, { status: 200, headers: browserHeaders });
    }
  };
}
