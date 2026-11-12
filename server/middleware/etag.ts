import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { computeETag, ifNoneMatchMatches } from "../lib/cache";
import { setResponseHeaders } from "../lib/headers";

/**
 * ETag and 304 for successful GETs (plan 02 2.3.3). Skips streams (Server-Sent Events), responses
 * that already carry an ETag, and `no-store` responses, which a browser never revalidates.
 */
export function etag(maxBytes = 2 * 1024 * 1024): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return;
    const res = c.res;
    if (res.status !== 200 || !res.body || res.headers.has("etag")) return;
    if ((res.headers.get("cache-control") ?? "").includes("no-store")) return;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) return;
    const length = Number(res.headers.get("content-length") ?? "0");
    if (length > maxBytes) return;

    const body = await res.clone().arrayBuffer();
    if (body.byteLength > maxBytes) return;
    const tag = await computeETag(body);
    if (ifNoneMatchMatches(c.req.header("if-none-match"), tag)) {
      const headers = new Headers(res.headers);
      headers.set("etag", tag);
      headers.delete("content-length");
      c.res = undefined as unknown as Response;
      c.res = new Response(null, { status: 304, headers });
      return;
    }
    setResponseHeaders(c, { etag: tag });
  };
}
