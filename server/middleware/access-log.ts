import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { AppEnv } from "../env";
import { logFor } from "../lib/log";

/**
 * One line per request with the route template, never the concrete path: paths carry bearer
 * tokens (/cal/u/{token}.ics, /e/c/{token}) and query strings can reveal a search.
 */
export function routeTemplate(path: string, status: number): string {
  // A 404 that only matched catch-all middleware has no meaningful template.
  if (status === 404 && (path === "*" || path === "/*" || path === "")) return "(unmatched)";
  return path || "(unmatched)";
}

export function accessLog(now: () => number = Date.now): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = now();
    await next();
    const status = c.res.status;
    const fields = {
      method: c.req.method,
      route: routeTemplate(routePath(c), status),
      status,
      durationMs: now() - started,
    };
    const log = logFor(c);
    if (status >= 500) log.error("request", fields);
    else if (status >= 400) log.warn("request", fields);
    else log.info("request", fields);
  };
}
