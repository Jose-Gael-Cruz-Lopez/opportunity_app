import type { Handler } from "hono";
import type { AppEnv } from "../env";

/**
 * /healthz answers while the isolate runs; /readyz also proves D1 answers (Sentry's uptime
 * monitor watches it). Neither reveals versions, bindings or error text.
 */
export const healthz: Handler<AppEnv> = (c) => c.json({ status: "ok" }, 200, { "cache-control": "no-store" });

export function readyz(timeoutMs = 2_000): Handler<AppEnv> {
  return async (c) => {
    let ok = false;
    try {
      const probe = c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
      const row = await Promise.race([probe, timeout]);
      ok = row?.ok === 1;
    } catch {
      ok = false;
    }
    return c.json({ status: ok ? "ok" : "degraded", checks: { db: ok ? "ok" : "fail" } }, ok ? 200 : 503, {
      "cache-control": "no-store",
    });
  };
}
