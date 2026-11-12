import type { z } from "zod";
import type { McpRegistry } from "../registry";

/** What every tool handler receives. Handlers are pure over this context: no I/O beyond the registry. */
export interface ToolContext {
  readonly registry: McpRegistry;
  /** Public origin for citation links. */
  readonly origin: string;
  /** Epoch ms; injected so tests are deterministic. */
  readonly now: number;
}

/** What a handler returns: the structured output plus the only facts logging may record. */
export interface ToolRun<O> {
  readonly output: O;
  readonly resultCount: number;
  /**
   * Program ids for the analytics allowlist; only search and deadline listings set this, and
   * never for sensitive-audience programs. check_eligibility must leave it null (its ids are inputs).
   */
  readonly programIds: readonly string[] | null;
}

export interface ToolDef<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: I;
  readonly output: O;
  /** Optional refusal before zod parsing (sensitive keys). Returns a message or null. */
  readonly precheck?: (value: unknown) => string | null;
  run(args: z.output<I>, ctx: ToolContext): Promise<ToolRun<z.output<O>>>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a heterogeneous list of tools needs an existential type
export type AnyToolDef = ToolDef<any, any>;

/** Every MCP tool is a read over public data (plan 8.12 annotations). */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** A failure the caller can act on (unknown program, bad cursor); its message is safe to return. */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly status: "invalid" | "not_found" = "invalid",
  ) {
    super(message);
    this.name = "ToolError";
  }
}
