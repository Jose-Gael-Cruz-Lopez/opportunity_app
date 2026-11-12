import { McpServer, ResourceTemplate, type CallToolResult } from "@modelcontextprotocol/server";
import { MCP_CONFIG, SERVER_INSTRUCTIONS } from "./config";
import { consoleSink, toCallEvent, toResourceEvent, type McpCallStatus, type McpEventSink, type RequestFacts } from "./log";
import { RegistryUnavailableError, type McpRegistry } from "./registry";
import { RESOURCE_URIS, methodologyText, opportunityTypesJson, programResourceJson } from "./resources";
import { toolSchema } from "./schema";
import { MCP_TOOLS, READ_ONLY_ANNOTATIONS, ToolError, type AnyToolDef } from "./tools";

/**
 * Builds one MCP server instance. createMcpHandler calls the factory once per HTTP request (both
 * protocol eras are stateless), so everything here is cheap: the registry is loaded lazily and
 * shared through the isolate cache in registry.ts, and tools/list never touches R2.
 */

export interface NovusMcpOptions {
  /** Loads the current release; called at most once per instance, only by calls that need data. */
  readonly loadRegistry: () => Promise<McpRegistry>;
  readonly origin: string;
  readonly now?: () => number;
  readonly sink?: McpEventSink;
  readonly request?: RequestFacts;
}

const ANONYMOUS: RequestFacts = { protocolVersion: null, clientName: "other", tier: "anonymous", apiClientId: null };

function textResult(output: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output as Record<string, unknown> };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Maps a thrown error to a caller-safe message and a log status; internals never leave the server. */
export function describeFailure(err: unknown): { status: McpCallStatus; message: string } {
  if (err instanceof ToolError) return { status: err.status, message: err.message };
  if (err instanceof RegistryUnavailableError) return { status: "unavailable", message: "The Novus registry is temporarily unavailable. Try again shortly." };
  return { status: "error", message: "Novus could not complete this request." };
}

function registerTool(server: McpServer, tool: AnyToolDef, opts: Required<Pick<NovusMcpOptions, "origin" | "now" | "sink">> & { registry: () => Promise<McpRegistry>; request: RequestFacts }): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: toolSchema(tool.input, { precheck: tool.precheck }),
      outputSchema: toolSchema(tool.output, { mode: "output" }),
      annotations: { title: tool.title, ...READ_ONLY_ANNOTATIONS },
    },
    async (args: unknown) => {
      const started = Date.now();
      try {
        const registry = await opts.registry();
        const run = await tool.run(args, { registry, origin: opts.origin, now: opts.now() });
        opts.sink(toCallEvent({ tool: tool.name, status: "ok", latencyMs: Date.now() - started, resultCount: run.resultCount, programIds: run.programIds }, opts.request));
        return textResult(run.output);
      } catch (err) {
        const { status, message } = describeFailure(err);
        opts.sink(toCallEvent({ tool: tool.name, status, latencyMs: Date.now() - started, resultCount: null, programIds: null }, opts.request));
        return errorResult(message);
      }
    },
  );
}

export function createNovusMcpServer(options: NovusMcpOptions): McpServer {
  let pending: Promise<McpRegistry> | null = null;
  const registry = () => (pending ??= options.loadRegistry());
  const shared = {
    registry,
    origin: options.origin,
    now: options.now ?? Date.now,
    sink: options.sink ?? consoleSink,
    request: options.request ?? ANONYMOUS,
  };

  const server = new McpServer(
    { name: MCP_CONFIG.serverName, title: MCP_CONFIG.serverTitle, version: MCP_CONFIG.serverVersion },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {}, resources: {} } },
  );

  for (const tool of MCP_TOOLS) registerTool(server, tool, shared);

  server.registerResource(
    "methodology",
    RESOURCE_URIS.methodology,
    { title: "How Novus verifies records", mimeType: "text/markdown" },
    async (uri) => {
      shared.sink(toResourceEvent(RESOURCE_URIS.methodology, "ok", 0, shared.request));
      return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: methodologyText(shared.origin) }] };
    },
  );

  server.registerResource(
    "opportunity-types",
    RESOURCE_URIS.opportunityTypes,
    { title: "Opportunity types", mimeType: "application/json" },
    async (uri) => {
      shared.sink(toResourceEvent(RESOURCE_URIS.opportunityTypes, "ok", 0, shared.request));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: opportunityTypesJson() }] };
    },
  );

  server.registerResource(
    "program",
    new ResourceTemplate(RESOURCE_URIS.programTemplate, { list: undefined }),
    { title: "Program by slug", mimeType: "application/json" },
    async (uri, variables) => {
      const started = Date.now();
      const slug = Array.isArray(variables.slug) ? variables.slug[0] : variables.slug;
      let text: string | null = null;
      let status: McpCallStatus = "ok";
      try {
        text = slug ? programResourceJson(await registry(), String(slug), shared.origin, shared.now()) : null;
        if (text === null) status = "not_found";
      } catch (err) {
        status = describeFailure(err).status;
      }
      shared.sink(toResourceEvent(RESOURCE_URIS.programTemplate, status, Date.now() - started, shared.request));
      if (text === null) throw new Error(status === "not_found" ? "No published program matches that slug." : describeFailure(new RegistryUnavailableError("")).message);
      return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
    },
  );

  return server;
}
