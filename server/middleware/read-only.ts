import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { loadFlags, type FlagSnapshot } from "../lib/flags";
import { problemFor } from "../lib/problem";

/**
 * The `site.read_only` switch (plan 02 2.3.12): during an incident or a migration, writes on
 * /api/v1 answer 503 with Retry-After while reads keep working. Flags come from the cached
 * snapshot, so this costs one D1 read per isolate per minute.
 */
const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function readOnlyGuard(
  load: (env: AppEnv["Bindings"]) => Promise<FlagSnapshot> = loadFlags,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (WRITE_METHODS.has(c.req.method)) {
      const flags = await load(c.env);
      if (flags.values["site.read_only"]) {
        return problemFor(c, "unavailable", { detail: "Novus is read-only for a short while." }, { retryAfter: 300 });
      }
    }
    await next();
  };
}
