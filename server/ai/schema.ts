import type { z } from "zod";
import { toJsonSchema, type JsonSchema } from "@shared/contracts";

/**
 * Turns a zod schema into the JSON Schema subset Gemini structured output accepts.
 *
 * Gemini honours: type (with null in type arrays), title, description, properties, required,
 * additionalProperties, enum, format date/date-time/time, minimum/maximum, items, prefixItems,
 * minItems/maxItems, anyOf, $ref/$defs. It silently ignores minLength, maxLength, uniqueItems and
 * min/maxProperties, so we strip them here to keep the request honest and enforce them in zod
 * after the call instead.
 */

const KEEP = new Set([
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "enum",
  "format",
  "minimum",
  "maximum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "anyOf",
  "$ref",
  "$defs",
]);
const FORMATS = new Set(["date", "date-time", "time"]);

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node === null || typeof node !== "object") return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (key === "const") {
      out.enum = [value];
      continue;
    }
    if (key === "oneOf") {
      out.anyOf = sanitize(value);
      continue;
    }
    if (!KEEP.has(key)) continue;
    if (key === "format" && !(typeof value === "string" && FORMATS.has(value))) continue;
    if (key === "properties" || key === "$defs") {
      const props: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) props[name] = sanitize(child);
      out[key] = props;
      continue;
    }
    out[key] = sanitize(value);
  }
  return out;
}

/** JSON Schema for a model-output zod schema, in Gemini's accepted subset. */
export function geminiResponseSchema(schema: z.ZodTypeAny): JsonSchema {
  const full = toJsonSchema(schema, { mode: "output" });
  return sanitize(full) as JsonSchema;
}

export interface SchemaComplexity {
  /** Property definitions across the whole tree. */
  readonly properties: number;
  /** anyOf nodes and type arrays: the costly part for Gemini's state machine. */
  readonly unions: number;
  /** Properties not listed in their object's `required`. */
  readonly optional: number;
  readonly depth: number;
}

/**
 * A rough complexity count. Google publishes no numeric limit (too complex returns 400
 * INVALID_ARGUMENT), so tests hold every route schema flat: no unions and no optional fields.
 */
export function schemaComplexity(schema: unknown): SchemaComplexity {
  let properties = 0;
  let unions = 0;
  let optional = 0;
  let depth = 0;
  const visit = (node: unknown, level: number): void => {
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, level));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    depth = Math.max(depth, level);
    if (Array.isArray(obj.anyOf) || Array.isArray(obj.type)) unions++;
    if (obj.properties && typeof obj.properties === "object") {
      const required = new Set(Array.isArray(obj.required) ? (obj.required as string[]) : []);
      for (const [name, child] of Object.entries(obj.properties as Record<string, unknown>)) {
        properties++;
        if (!required.has(name)) optional++;
        visit(child, level + 1);
      }
    }
    if (obj.items) visit(obj.items, level + 1);
    if (obj.anyOf) visit(obj.anyOf, level + 1);
    if (obj.prefixItems) visit(obj.prefixItems, level + 1);
  };
  visit(schema, 0);
  return { properties, unions, optional, depth };
}

/** Every key used anywhere in a schema; tests assert none is outside Gemini's subset. */
export function schemaKeywords(schema: unknown): Set<string> {
  const keys = new Set<string>();
  const visit = (node: unknown, inProperties: boolean): void => {
    if (Array.isArray(node)) {
      node.forEach((n) => visit(n, false));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (!inProperties) keys.add(k);
      visit(v, !inProperties && (k === "properties" || k === "$defs"));
    }
  };
  visit(schema, false);
  return keys;
}
