import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { z } from "zod";
import { toJsonSchema, type JsonSchema } from "@shared/contracts/json-schema";

/**
 * Adapts a zod (v3 API) schema to the Standard Schema + JSON Schema interface that
 * `McpServer.registerTool` takes. The SDK can only convert zod 4 schemas itself, and the repo pins
 * the v3 API, so the JSON Schema comes from shared/contracts/json-schema.ts and validation runs
 * through zod. `precheck` runs before zod so a tool can answer with its own message (for example
 * "Novus does not accept that information") instead of zod's generic unknown-key error.
 */

export interface ToolSchemaOptions {
  /** Returns an error message to refuse the value before zod runs, or null to continue. */
  readonly precheck?: (value: unknown) => string | null;
  readonly mode?: "input" | "output";
}

function issuePath(path: readonly (string | number)[]): string {
  return path.length ? `${path.join(".")}: ` : "";
}

/** JSON Schema without the `$schema` key, which tool listings do not need. */
export function jsonSchemaFor(schema: z.ZodTypeAny, mode: "input" | "output"): JsonSchema {
  const { $schema: _ignored, ...rest } = toJsonSchema(schema, { mode });
  return rest;
}

export function toolSchema<S extends z.ZodTypeAny>(schema: S, opts: ToolSchemaOptions = {}): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
  const mode = opts.mode ?? "input";
  let cached: JsonSchema | null = null;
  const json = (): JsonSchema => (cached ??= jsonSchemaFor(schema, mode));
  return {
    "~standard": {
      version: 1,
      vendor: "novus-zod3",
      validate(value: unknown) {
        const refused = opts.precheck?.(value) ?? null;
        if (refused !== null) return { issues: [{ message: refused }] };
        const parsed = schema.safeParse(value);
        if (parsed.success) return { value: parsed.data as z.output<S> };
        // Messages name the path and zod's message only; argument values are never echoed back.
        return { issues: parsed.error.issues.map((i) => ({ message: `${issuePath(i.path)}${i.message}` })) };
      },
      jsonSchema: { input: () => json(), output: () => json() },
    },
  };
}
