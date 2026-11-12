import type { MiddlewareHandler } from "hono";
import { findSensitiveKeys } from "@shared/contracts/sensitive";
import type { AppEnv } from "../env";
import { problemFor } from "../lib/problem";
import { queryToObject } from "../lib/validation";

/**
 * Privacy by construction (rule 3): no /api/v1 route may receive a status or identity answer.
 * This guard runs before any handler, on the query string and on JSON or form bodies, and
 * refuses a request carrying a sensitive-looking key with 400 `sensitive_field_rejected`. It
 * returns the key paths only; the values are never read into a log, an error or a response.
 *
 * Route validators repeat the check (server/middleware/validate.ts), so a router mounted
 * without this guard still refuses such keys.
 */

const BODY_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function bodyKeys(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Promise<unknown> {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  try {
    if (type.includes("application/json") || type.includes("+json")) return await c.req.json();
    if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
      return await c.req.parseBody({ all: true });
    }
  } catch {
    // Unparseable bodies are the validator's to refuse (bad_request); nothing to inspect here.
  }
  return null;
}

export function sensitiveGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const found = findSensitiveKeys(queryToObject(url.searchParams)).map((p) => `query.${p}`);
    if (BODY_METHODS.has(c.req.method)) {
      const body = await bodyKeys(c);
      if (body !== null) found.push(...findSensitiveKeys(body).map((p) => `body.${p}`));
    }
    if (found.length > 0) {
      return problemFor(c, "sensitive_field_rejected", {
        errors: found.slice(0, 50).map((path) => ({ path: path.slice(0, 200), message: "Not accepted by this endpoint" })),
      });
    }
    await next();
  };
}
