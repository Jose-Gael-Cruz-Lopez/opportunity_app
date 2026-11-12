import { Hono, type Context } from "hono";
import { SlugSchema } from "@shared/contracts/common";
import { ROUTES, relativePath } from "@shared/contracts/routes";
import type { AppEnv } from "@server/env";
import { computeETag, ifNoneMatchMatches, type CacheLike } from "@server/lib/cache";
import { problemFor } from "@server/lib/problem";
import { edgeCache } from "@server/middleware/edge-cache";
import { renderProgramFeed, renderUserFeed } from "./feeds";
import { ICS_CONTENT_TYPE } from "./ics";
import type { CalStore } from "./store";
import { calendarTokenHash, isCalendarToken, stripIcsSuffix } from "./token";

/**
 * Calendar feeds, mounted at /cal (plan 02 2.3.3, plan 6.7.5):
 * - GET /cal/p/{slug}.ics: a published program's national deadlines. Public and identical for
 *   everyone, so it is edge-cached for an hour (with a last-good copy for D1 outages).
 * - GET /cal/u/{token}.ics: a student's tracked deadlines. `private, no-cache` with an ETag and
 *   never edge-cached, so rotating or revoking the token takes effect on the next poll.
 * The token is a bearer secret in the path: nothing here logs it, and the access log records
 * only the route template.
 */

type Ctx = Context<AppEnv>;

export interface CalDeps {
  readonly store: (c: Ctx) => CalStore;
  readonly now: () => number;
  /** Public origin for links inside events (APP_ORIGIN). */
  readonly origin: (c: Ctx) => string;
  /** Edge cache for program feeds: undefined uses caches.default, null disables it (tests). */
  readonly programCache?: CacheLike | null;
}

export const PROGRAM_FEED_CACHE = ROUTES.programCalendar.cache;
export const USER_FEED_CACHE = ROUTES.userCalendar.cache;
const PROGRAM_FEED_TTL_SECONDS = 3600;

function icsHeaders(cacheControl: string, fileName: string): Record<string, string> {
  return {
    "content-type": ICS_CONTENT_TYPE,
    "cache-control": cacheControl,
    "content-disposition": `inline; filename="${fileName}"`,
    "x-content-type-options": "nosniff",
  };
}

/** A 404 that says nothing about why, so tokens and unpublished slugs cannot be probed. */
function notFound(c: Ctx): Response {
  return problemFor(c, "not_found");
}

export function createCalRoutes(deps: CalDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const programCache = edgeCache({
    ttlSeconds: PROGRAM_FEED_TTL_SECONDS,
    ...(deps.programCache !== undefined ? { cache: deps.programCache } : {}),
  });

  app.get(relativePath(ROUTES.programCalendar), programCache, async (c) => {
    const slug = stripIcsSuffix(c.req.param("file") ?? "");
    if (!slug || !SlugSchema.safeParse(slug).success) return notFound(c);
    const found = await deps.store(c).programFeed(slug, deps.now());
    if (!found) return notFound(c);
    if (found.kind === "redirect") {
      return c.body(null, 301, { location: `/cal/p/${found.slug}.ics`, "cache-control": PROGRAM_FEED_CACHE });
    }
    const body = renderProgramFeed(found, deps.origin(c));
    return c.body(body, 200, icsHeaders(PROGRAM_FEED_CACHE, `${found.slug}.ics`));
  });

  app.get(relativePath(ROUTES.userCalendar), async (c) => {
    const token = stripIcsSuffix(c.req.param("file") ?? "");
    if (!token || !isCalendarToken(token)) return notFound(c);
    const feed = await deps.store(c).userFeed(await calendarTokenHash(token), deps.now());
    if (!feed) return notFound(c);
    const body = renderUserFeed(feed, deps.origin(c));
    const etag = await computeETag(body);
    const common = {
      "cache-control": USER_FEED_CACHE,
      etag,
      // The URL is a secret: keep it out of search indexes and Referer headers.
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
    };
    if (ifNoneMatchMatches(c.req.header("if-none-match"), etag)) return c.body(null, 304, common);
    return c.body(body, 200, { ...icsHeaders(USER_FEED_CACHE, "novus-deadlines.ics"), ...common });
  });

  return app;
}
