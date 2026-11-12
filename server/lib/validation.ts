import type { z } from "zod";
import type { ApiErrorCode } from "@shared/contracts/common";
import { findSensitiveKeys } from "@shared/contracts/sensitive";

/**
 * Input validation that returns the contract error shape. Two rules shape it:
 * 1. Sensitive keys are refused before parsing (rule 3), with `sensitive_field_rejected` and the
 *    offending paths only, so no status or identity answer is parsed, stored or logged.
 * 2. Error messages never echo input: zod 3's default messages quote received values for some
 *    codes (an invalid enum names the value sent), so each code maps to a fixed message.
 */

export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

/** Fixed messages per zod issue code; none of them can contain submitted text. */
const ISSUE_MESSAGES: Record<string, string> = {
  invalid_type: "Wrong type",
  invalid_literal: "Unexpected value",
  unrecognized_keys: "Unrecognized key",
  invalid_union: "Does not match any allowed shape",
  invalid_union_discriminator: "Unknown kind",
  invalid_enum_value: "Not an allowed value",
  invalid_arguments: "Invalid arguments",
  invalid_return_type: "Invalid return type",
  invalid_date: "Invalid date",
  invalid_string: "Invalid format",
  too_small: "Too small or too short",
  too_big: "Too large or too long",
  invalid_intersection_types: "Conflicting values",
  not_multiple_of: "Not an allowed step",
  not_finite: "Must be a finite number",
};

/**
 * Field issues with fixed messages. `custom` issues keep their message, because those strings
 * are authored in shared/contracts refinements, never derived from input; they are still
 * truncated. Unrecognized keys report the key names as paths: a key name is schema-shaped, and
 * sensitive key names were already refused before parsing.
 */
export function safeIssues(error: z.ZodError, max = 50): FieldIssue[] {
  const out: FieldIssue[] = [];
  for (const issue of error.issues) {
    if (out.length >= max) break;
    const base = issue.path.map(String).join(".");
    if (issue.code === "unrecognized_keys") {
      for (const rawKey of issue.keys) {
        if (out.length >= max) break;
        // Only identifier-shaped key names are echoed; anything else could be free text.
        const key = /^[A-Za-z0-9_-]{1,60}$/.test(rawKey) ? rawKey : "(key)";
        out.push({ path: (base ? `${base}.${key}` : key).slice(0, 200), message: ISSUE_MESSAGES.unrecognized_keys! });
      }
      continue;
    }
    const message = issue.code === "custom" ? issue.message.slice(0, 200) : (ISSUE_MESSAGES[issue.code] ?? "Invalid value");
    out.push({ path: (base || "(root)").slice(0, 200), message });
  }
  return out;
}

export type ParseOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: ApiErrorCode; readonly errors: FieldIssue[] };

/** Checks for sensitive keys, then parses with the schema. */
export function parseInput<S extends z.ZodTypeAny>(schema: S, value: unknown): ParseOutcome<z.output<S>> {
  const sensitive = findSensitiveKeys(value);
  if (sensitive.length > 0) {
    return {
      ok: false,
      code: "sensitive_field_rejected",
      errors: sensitive.slice(0, 50).map((path) => ({ path: path.slice(0, 200), message: "Not accepted by this endpoint" })),
    };
  }
  const result = schema.safeParse(value);
  if (!result.success) return { ok: false, code: "validation_failed", errors: safeIssues(result.error) };
  return { ok: true, data: result.data as z.output<S> };
}

/**
 * Turns URLSearchParams into an object: repeated keys become arrays, single keys stay strings,
 * so `CursorQuerySchema`-style schemas with z.coerce work on either.
 */
export function queryToObject(params: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const all = params.getAll(key);
    out[key] = all.length === 1 ? all[0]! : all;
  }
  return out;
}
