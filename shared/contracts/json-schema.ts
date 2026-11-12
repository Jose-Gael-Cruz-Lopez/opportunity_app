import { z } from "zod";

/**
 * Minimal zod (v3 API) to JSON Schema (draft 2020-12) converter. zod 3.25's own `toJSONSchema`
 * only accepts zod 4 schemas, and the repo pins the v3 API, so this covers the subset the contracts
 * use. Refinements cannot be expressed in JSON Schema and are dropped; the Worker re-validates
 * every body with zod, so the generated schemas are for codegen and model output, not security.
 *
 * Mode "input" (default) treats fields with defaults as optional, which is what a client posting
 * to the API needs. Mode "output" marks them required, which matches what the API returns.
 */

export type JsonSchema = { [key: string]: unknown };
export type JsonSchemaMode = "input" | "output";

interface Ctx {
  readonly mode: JsonSchemaMode;
}

const HINTS = new WeakMap<z.ZodTypeAny, JsonSchema>();

/**
 * Attaches JSON Schema keywords that a zod refinement cannot express (for example
 * `format: "date"` on a refined string). Returns the same schema for chaining.
 */
export function withJsonSchema<T extends z.ZodTypeAny>(schema: T, hint: JsonSchema): T {
  HINTS.set(schema, hint);
  return schema;
}

function withDescription(schema: z.ZodTypeAny, out: JsonSchema): JsonSchema {
  return schema.description ? { ...out, description: schema.description } : out;
}

function stringSchema(s: z.ZodString): JsonSchema {
  const out: JsonSchema = { type: "string" };
  for (const check of s._def.checks) {
    switch (check.kind) {
      case "min":
        out.minLength = check.value;
        break;
      case "max":
        out.maxLength = check.value;
        break;
      case "length":
        out.minLength = check.value;
        out.maxLength = check.value;
        break;
      case "regex":
        out.pattern = check.regex.source;
        break;
      case "email":
        out.format = "email";
        break;
      case "url":
        out.format = "uri";
        break;
      case "uuid":
        out.format = "uuid";
        break;
      case "datetime":
        out.format = "date-time";
        break;
      default:
        break;
    }
  }
  return out;
}

function numberSchema(n: z.ZodNumber): JsonSchema {
  const out: JsonSchema = { type: "number" };
  for (const check of n._def.checks) {
    if (check.kind === "int") out.type = "integer";
    else if (check.kind === "min") out[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value;
    else if (check.kind === "max") out[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value;
    else if (check.kind === "multipleOf") out.multipleOf = check.value;
  }
  return out;
}

/** True when a property may be absent from an object in the given mode. */
function isOptional(schema: z.ZodTypeAny, ctx: Ctx): boolean {
  if (schema instanceof z.ZodOptional) return true;
  if (schema instanceof z.ZodDefault) return ctx.mode === "input";
  if (schema instanceof z.ZodEffects) return isOptional(schema._def.schema, ctx);
  return false;
}

function convert(schema: z.ZodTypeAny, ctx: Ctx): JsonSchema {
  const hint = HINTS.get(schema);
  if (hint) {
    HINTS.delete(schema);
    try {
      return { ...convert(schema, ctx), ...hint };
    } finally {
      HINTS.set(schema, hint);
    }
  }
  if (schema instanceof z.ZodString) return withDescription(schema, stringSchema(schema));
  if (schema instanceof z.ZodNumber) return withDescription(schema, numberSchema(schema));
  if (schema instanceof z.ZodBoolean) return withDescription(schema, { type: "boolean" });
  if (schema instanceof z.ZodNull) return { type: "null" };
  if (schema instanceof z.ZodDate) return withDescription(schema, { type: "string", format: "date-time" });
  if (schema instanceof z.ZodLiteral) return withDescription(schema, { const: schema._def.value });
  if (schema instanceof z.ZodEnum) return withDescription(schema, { type: "string", enum: [...schema._def.values] });
  if (schema instanceof z.ZodNativeEnum) {
    return withDescription(schema, { enum: Object.values(schema._def.values as Record<string, string | number>) });
  }
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) return withDescription(schema, {});
  if (schema instanceof z.ZodOptional) return convert(schema._def.innerType, ctx);
  if (schema instanceof z.ZodNullable) {
    return withDescription(schema, { anyOf: [convert(schema._def.innerType, ctx), { type: "null" }] });
  }
  if (schema instanceof z.ZodDefault) {
    return { ...convert(schema._def.innerType, ctx), default: schema._def.defaultValue() };
  }
  if (schema instanceof z.ZodEffects) return withDescription(schema, convert(schema._def.schema, ctx));
  if (schema instanceof z.ZodBranded) return convert(schema._def.type, ctx);
  if (schema instanceof z.ZodReadonly) return convert(schema._def.innerType, ctx);
  if (schema instanceof z.ZodCatch) return convert(schema._def.innerType, ctx);
  if (schema instanceof z.ZodPipeline) return convert(ctx.mode === "input" ? schema._def.in : schema._def.out, ctx);
  if (schema instanceof z.ZodLazy) return { $comment: "recursive schema", type: "object" };
  if (schema instanceof z.ZodArray) {
    const out: JsonSchema = { type: "array", items: convert(schema._def.type, ctx) };
    if (schema._def.minLength) out.minItems = schema._def.minLength.value;
    if (schema._def.maxLength) out.maxItems = schema._def.maxLength.value;
    if (schema._def.exactLength) {
      out.minItems = schema._def.exactLength.value;
      out.maxItems = schema._def.exactLength.value;
    }
    return withDescription(schema, out);
  }
  if (schema instanceof z.ZodTuple) {
    const items = (schema._def.items as z.ZodTypeAny[]).map((i) => convert(i, ctx));
    return withDescription(schema, { type: "array", prefixItems: items, minItems: items.length, maxItems: items.length });
  }
  if (schema instanceof z.ZodRecord) {
    const out: JsonSchema = { type: "object", additionalProperties: convert(schema._def.valueType, ctx) };
    const key = schema._def.keyType as z.ZodTypeAny;
    if (key instanceof z.ZodEnum) out.propertyNames = { enum: [...key._def.values] };
    else if (key instanceof z.ZodString) {
      const keySchema = stringSchema(key);
      if (keySchema.pattern) out.propertyNames = { pattern: keySchema.pattern };
    }
    return withDescription(schema, out);
  }
  if (schema instanceof z.ZodUnion) {
    return withDescription(schema, { anyOf: (schema._def.options as z.ZodTypeAny[]).map((o) => convert(o, ctx)) });
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = [...(schema._def.options as z.ZodTypeAny[])];
    return withDescription(schema, { oneOf: options.map((o) => convert(o, ctx)) });
  }
  if (schema instanceof z.ZodIntersection) {
    return withDescription(schema, { allOf: [convert(schema._def.left, ctx), convert(schema._def.right, ctx)] });
  }
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convert(value, ctx);
      if (!isOptional(value, ctx)) required.push(key);
    }
    const out: JsonSchema = { type: "object", properties };
    if (required.length > 0) out.required = required;
    const unknownKeys = schema._def.unknownKeys as string;
    if (unknownKeys === "strict") out.additionalProperties = false;
    else if (unknownKeys === "passthrough") out.additionalProperties = true;
    return withDescription(schema, out);
  }
  throw new Error(`json-schema: unsupported zod type ${(schema._def as { typeName?: string }).typeName ?? "unknown"}`);
}

/** Converts a zod schema to a standalone JSON Schema document. */
export function toJsonSchema(schema: z.ZodTypeAny, opts: { title?: string; id?: string; mode?: JsonSchemaMode } = {}): JsonSchema {
  const body = convert(schema, { mode: opts.mode ?? "input" });
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    ...(opts.id ? { $id: opts.id } : {}),
    ...(opts.title ? { title: opts.title } : {}),
    ...body,
  };
}

/** Every property name that appears anywhere in a JSON Schema (for contract tests). */
export function collectPropertyNames(schema: unknown): string[] {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    if (obj.properties && typeof obj.properties === "object") {
      for (const key of Object.keys(obj.properties as object)) names.add(key);
    }
    Object.values(obj).forEach(visit);
  };
  visit(schema);
  return [...names];
}
