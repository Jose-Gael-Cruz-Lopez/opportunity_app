/**
 * The one logging allowlist for MCP (plan 8.12, S08-056): it serves both log lines and the
 * `mcp_tool_called` analytics event. Nothing else is recorded: no argument values, profiles, query
 * text, filter values, institution ids or IPs. check_eligibility never records program ids.
 */

export const CLIENT_NAMES = ["claude", "chatgpt", "inspector", "other"] as const;
export type ClientName = (typeof CLIENT_NAMES)[number];

export const LATENCY_BUCKETS = ["lt_50ms", "50_200ms", "200_1000ms", "gte_1000ms"] as const;
export type LatencyBucket = (typeof LATENCY_BUCKETS)[number];

export type McpCallStatus = "ok" | "invalid" | "not_found" | "error" | "unavailable";

export interface McpCallEvent {
  readonly event: "mcp_tool_called";
  readonly tool: string | null;
  /** For resources/read: the template (never the concrete URI). */
  readonly resource_template: string | null;
  readonly protocol_version: string | null;
  readonly client_name: ClientName;
  readonly tier: "anonymous" | "developer" | "assistant_platform";
  readonly api_client_id: string | null;
  readonly status: McpCallStatus;
  readonly latency_ms: LatencyBucket;
  /** Bucketed for search_programs; the number of programs checked (1-10) for check_eligibility. */
  readonly result_count: string | number | null;
  /** Only for search_programs and list_deadlines, and never for sensitive-audience programs. */
  readonly program_ids: readonly string[] | null;
}

export const MCP_EVENT_KEYS = [
  "event",
  "tool",
  "resource_template",
  "protocol_version",
  "client_name",
  "tier",
  "api_client_id",
  "status",
  "latency_ms",
  "result_count",
  "program_ids",
] as const satisfies readonly (keyof McpCallEvent)[];

/** Tools allowed to record program ids (their ids are outputs, not inputs). */
const PROGRAM_ID_TOOLS = new Set(["search_programs", "list_deadlines"]);

export function latencyBucket(ms: number): LatencyBucket {
  if (ms < 50) return "lt_50ms";
  if (ms < 200) return "50_200ms";
  if (ms < 1000) return "200_1000ms";
  return "gte_1000ms";
}

/** 0, 1-5 or 6-25 for search; exact for the others (they are already small and bounded). */
export function resultCountBucket(tool: string, count: number): string | number {
  if (tool !== "search_programs") return count;
  if (count === 0) return "0";
  return count <= 5 ? "1-5" : "6-25";
}

/** Normalizes a client name or user agent to the four allowlisted values. */
export function normalizeClientName(raw: string | null | undefined): ClientName {
  const v = (raw ?? "").toLowerCase();
  if (v.includes("claude") || v.includes("anthropic")) return "claude";
  if (v.includes("chatgpt") || v.includes("openai")) return "chatgpt";
  if (v.includes("inspector")) return "inspector";
  return "other";
}

export interface CallFacts {
  readonly tool: string;
  readonly status: McpCallStatus;
  readonly latencyMs: number;
  readonly resultCount: number | null;
  readonly programIds: readonly string[] | null;
}

export interface RequestFacts {
  readonly protocolVersion: string | null;
  readonly clientName: ClientName;
  readonly tier: McpCallEvent["tier"];
  readonly apiClientId: string | null;
}

/** Builds the event from facts, applying every allowlist rule in one place. */
export function toCallEvent(call: CallFacts, req: RequestFacts): McpCallEvent {
  const ids = PROGRAM_ID_TOOLS.has(call.tool) && call.programIds ? [...call.programIds].slice(0, 25) : null;
  return {
    event: "mcp_tool_called",
    tool: call.tool,
    resource_template: null,
    protocol_version: req.protocolVersion,
    client_name: req.clientName,
    tier: req.tier,
    api_client_id: req.apiClientId,
    status: call.status,
    latency_ms: latencyBucket(call.latencyMs),
    result_count: call.resultCount === null ? null : resultCountBucket(call.tool, call.resultCount),
    program_ids: ids,
  };
}

export function toResourceEvent(template: string, status: McpCallStatus, latencyMs: number, req: RequestFacts): McpCallEvent {
  return {
    event: "mcp_tool_called",
    tool: null,
    resource_template: template,
    protocol_version: req.protocolVersion,
    client_name: req.clientName,
    tier: req.tier,
    api_client_id: req.apiClientId,
    status,
    latency_ms: latencyBucket(latencyMs),
    result_count: null,
    program_ids: null,
  };
}

export type McpEventSink = (event: McpCallEvent) => void;

/** Default sink: one structured log line with only allowlisted keys. */
export const consoleSink: McpEventSink = (event) => {
  const line: Record<string, unknown> = {};
  for (const key of MCP_EVENT_KEYS) line[key] = event[key];
  console.log(JSON.stringify(line));
};
