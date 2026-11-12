import { describe, expect, it } from "vitest";
import { createMcpRoutes, type McpBindings } from "./index";
import type { McpCallEvent } from "./log";
import { MCP_EVENT_KEYS } from "./log";
import { RULED_CARD, TEST_NOW, testRegistry } from "./testing/fixtures";

const HOST = "novus.example.org";
const MODERN = "2026-07-28";
const LEGACY = "2025-06-18";

function setup(enabled = true) {
  const events: McpCallEvent[] = [];
  const app = createMcpRoutes({
    isEnabled: async () => enabled,
    loadRegistry: async () => testRegistry(),
    allowedHosts: () => [HOST],
    now: () => TEST_NOW,
    sink: (e) => events.push(e),
  });
  const env: McpBindings = { APP_ORIGIN: `https://${HOST}` };
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    app.request(
      `https://${HOST}/`,
      {
        method: "POST",
        headers: { host: HOST, "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      env,
    );
  return { app, env, events, post };
}

/** Legacy responses may be SSE; modern ones are plain JSON. */
async function rpcBody(res: Response): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const text = await res.text();
  const data = text.startsWith("event:") || text.startsWith("data:") ? text.split("\n").find((l) => l.startsWith("data:"))!.slice(5) : text;
  return JSON.parse(data);
}

const legacyHeaders = { "mcp-protocol-version": LEGACY };

function modernParams(params: Record<string, unknown> = {}) {
  return {
    ...params,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
}

describe("mcpRoutes gates", () => {
  it("answers 404 while mcp.enabled is off", async () => {
    const { post } = setup(false);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);
  });

  it("refuses an unknown Host or Origin with 403", async () => {
    const { post } = setup();
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { host: "evil.example.net" })).status).toBe(403);
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { origin: "https://evil.example.net" })).status).toBe(403);
  });

  it("refuses JSON-RPC batches and bad JSON with 400 before the handler", async () => {
    const { post, events } = setup();
    const batch = await post([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
    expect(batch.status).toBe(400);
    expect((await rpcBody(batch)).error?.code).toBe(-32600);
    expect((await post("{not json")).status).toBe(400);
    expect(events).toHaveLength(0);
  });

  it("refuses an oversized body with 413", async () => {
    const { post } = setup();
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(70_000) } });
    expect(res.status).toBe(413);
  });

  it("answers GET with 405 (no sessions, no stream)", async () => {
    const { app, env } = setup();
    const res = await app.request(`https://${HOST}/`, { method: "GET", headers: { host: HOST, accept: "text/event-stream" } }, env);
    expect(res.status).toBe(405);
  });

  it("applies the optional rate limiter per client IP", async () => {
    const { app } = setup();
    const env: McpBindings = { APP_ORIGIN: `https://${HOST}`, MCP_RATE_LIMITER: { limit: async () => ({ success: false }) } };
    const res = await app.request(
      `https://${HOST}/`,
      { method: "POST", headers: { host: HOST, "cf-connecting-ip": "203.0.113.9", "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(res.status).toBe(429);
  });
});

describe("legacy era (2025-06-18, stateless)", () => {
  it("initializes, lists tools with read-only annotations and calls a tool", async () => {
    const { post } = setup();
    const init = await rpcBody(
      await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "inspector", version: "1" } } }),
    );
    expect((init.result?.serverInfo as { name: string }).name).toBe("novus");
    expect(String(init.result?.instructions)).toContain("CC-BY-4.0");

    const list = await rpcBody(await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, legacyHeaders));
    const tools = list.result?.tools as { name: string; annotations: Record<string, unknown>; inputSchema: Record<string, unknown>; outputSchema?: unknown }[];
    expect(tools.map((t) => t.name)).toEqual(["search_programs", "get_program", "list_deadlines", "check_eligibility"]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.outputSchema).toBeDefined();
    }

    const call = await rpcBody(
      await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_program", arguments: { program: RULED_CARD.slug } } }, legacyHeaders),
    );
    const structured = call.result?.structuredContent as { program: { slug: string; citation: { novusUrl: string } } };
    expect(structured.program.slug).toBe(RULED_CARD.slug);
    expect(structured.program.citation.novusUrl).toBe(`https://${HOST}/programs/${RULED_CARD.slug}?ref=mcp`);
    // The same data is returned as text for clients without structured output.
    const text = (call.result?.content as { type: string; text: string }[])[0]!.text;
    expect(JSON.parse(text)).toEqual(structured);
  });

  it("refuses sensitive profile keys with the Novus message and logs nothing about them", async () => {
    const { post, events } = setup();
    const res = await rpcBody(
      await post(
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "check_eligibility", arguments: { programs: [RULED_CARD.slug], profile: { classYear: "first_year", citizenship: "canary-value-123" } } },
        },
        legacyHeaders,
      ),
    );
    expect(res.result?.isError).toBe(true);
    const message = (res.result?.content as { text: string }[])[0]!.text;
    expect(message).toContain("Novus does not accept that information");
    expect(message).not.toContain("canary-value-123");
    expect(JSON.stringify(events)).not.toContain("canary-value-123");
  });

  it("logs only allowlisted keys and no program ids or arguments for check_eligibility", async () => {
    const { post, events } = setup();
    await post(
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "check_eligibility", arguments: { programs: [RULED_CARD.slug], profile: { classYear: "first_year", majorCip: "11.0701" } } },
      },
      { ...legacyHeaders, "user-agent": "Claude-User/1.0" },
    );
    await post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "search_programs", arguments: { query: "canary query text" } } }, legacyHeaders);
    expect(events).toHaveLength(2);
    for (const e of events) expect(Object.keys(e).sort()).toEqual([...MCP_EVENT_KEYS].sort());
    const elig = events[0]!;
    expect(elig).toMatchObject({ tool: "check_eligibility", status: "ok", program_ids: null, result_count: 1, client_name: "claude", protocol_version: LEGACY });
    const serialized = JSON.stringify(events);
    for (const secret of [RULED_CARD.programId, RULED_CARD.slug, "11.0701", "first_year", "canary query text"]) expect(serialized).not.toContain(secret);
  });
});

describe("modern era (2026-07-28, per-request envelope)", () => {
  it("serves server/discover, tools/list and tools/call as plain JSON", async () => {
    const { post } = setup();
    const discover = await post({ jsonrpc: "2.0", id: 1, method: "server/discover", params: modernParams() }, { "mcp-protocol-version": MODERN, "mcp-method": "server/discover" });
    expect(discover.status).toBe(200);
    expect(discover.headers.get("content-type")).toContain("application/json");
    const discovered = await rpcBody(discover);
    expect(discovered.error).toBeUndefined();

    const list = await rpcBody(
      await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: modernParams() }, { "mcp-protocol-version": MODERN, "mcp-method": "tools/list" }),
    );
    expect((list.result?.tools as unknown[]).length).toBe(4);

    const call = await rpcBody(
      await post(
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: modernParams({ name: "list_deadlines", arguments: { within_days: 30, limit: 5 } }) },
        { "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": "list_deadlines" },
      ),
    );
    const structured = call.result?.structuredContent as { deadlines: unknown[] };
    expect(structured.deadlines.length).toBeGreaterThan(0);
  });

  it("rejects an Mcp-Name header that does not match the body", async () => {
    const { post } = setup();
    const res = await post(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: modernParams({ name: "list_deadlines", arguments: {} }) },
      { "mcp-protocol-version": MODERN, "mcp-method": "tools/call", "mcp-name": "search_programs" },
    );
    expect(res.status).toBe(400);
  });

  it("reads the methodology and a program resource; the program template lists nothing", async () => {
    const { post, events } = setup();
    const headers = (name: string) => ({ "mcp-protocol-version": MODERN, "mcp-method": "resources/read", "mcp-name": name });
    const methodology = await rpcBody(await post({ jsonrpc: "2.0", id: 5, method: "resources/read", params: modernParams({ uri: "novus://methodology" }) }, headers("novus://methodology")));
    expect(JSON.stringify(methodology.result)).toContain("How Novus verifies records");
    const uri = `novus://programs/${RULED_CARD.slug}`;
    const program = await rpcBody(await post({ jsonrpc: "2.0", id: 6, method: "resources/read", params: modernParams({ uri }) }, headers(uri)));
    expect(JSON.stringify(program.result)).toContain(RULED_CARD.name);
    expect(events.find((e) => e.resource_template === "novus://programs/{slug}")).toBeDefined();
    expect(JSON.stringify(events)).not.toContain(RULED_CARD.slug);

    const listed = await rpcBody(
      await post({ jsonrpc: "2.0", id: 7, method: "resources/list", params: modernParams() }, { "mcp-protocol-version": MODERN, "mcp-method": "resources/list" }),
    );
    const uris = (listed.result?.resources as { uri: string }[]).map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(["novus://methodology", "novus://taxonomy/opportunity-types"]));
    expect(uris.some((u) => u.startsWith("novus://programs/"))).toBe(false);
  });
});
