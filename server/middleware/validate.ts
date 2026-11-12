import type { Context, MiddlewareHandler } from "hono";
import { validator } from "hono/validator";
import type { z } from "zod";
import { problemFor } from "../lib/problem";
import { parseInput, queryToObject } from "../lib/validation";

/**
 * zod validators that answer in the contract error shape:
 *
 *   app.patch("/me/profile", validateJson(StudentProfileUpdateSchema), (c) => {
 *     const patch = c.req.valid("json");   // typed as the schema's output
 *   });
 *
 * Each validator refuses sensitive keys first (400 sensitive_field_rejected), then parses
 * (400 validation_failed with field paths and fixed messages, never the submitted values).
 */

function refuse(c: Context, outcome: Extract<ReturnType<typeof parseInput>, { ok: false }>): Response {
  return problemFor(c, outcome.code, { errors: outcome.errors });
}

export function validateJson<S extends z.ZodTypeAny>(schema: S) {
  return validator("json", (value, c): z.output<S> | Response => {
    const outcome = parseInput(schema, value);
    return outcome.ok ? outcome.data : refuse(c, outcome);
  });
}

/** Query strings: repeated keys arrive as arrays, single keys as strings (use z.coerce). */
export function validateQuery<S extends z.ZodTypeAny>(schema: S) {
  return validator("query", (_value, c): z.output<S> | Response => {
    const outcome = parseInput(schema, queryToObject(new URL(c.req.url).searchParams));
    return outcome.ok ? outcome.data : refuse(c, outcome);
  });
}

export function validateParams<S extends z.ZodTypeAny>(schema: S) {
  return validator("param", (value, c): z.output<S> | Response => {
    const outcome = parseInput(schema, value);
    return outcome.ok ? outcome.data : refuse(c, outcome);
  });
}

/**
 * Hono's json validator refuses a non-JSON content type with a plain 400 HTTPException, which
 * the error handler turns into `bad_request`. This middleware gives that case a clearer code for
 * routes that want it, and is optional.
 */
export function requireJson(): MiddlewareHandler {
  return async (c, next) => {
    const type = (c.req.header("content-type") ?? "").toLowerCase();
    if (!/^application\/([a-z0-9.+-]*\+)?json/.test(type)) {
      return problemFor(c, "bad_request", { detail: "Send a JSON body with Content-Type: application/json." });
    }
    await next();
  };
}
