import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import type { FlagKey } from "../config/flags";
import { loadFlags, type FlagSnapshot } from "../lib/flags";
import { problemFor } from "../lib/problem";

/** Hides a feature behind a flag: 404 while it is off, as if the route did not exist. */
export function requireFlag(
  key: FlagKey,
  load: (env: AppEnv["Bindings"]) => Promise<FlagSnapshot> = loadFlags,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!(await load(c.env)).values[key]) return problemFor(c, "not_found");
    await next();
  };
}
