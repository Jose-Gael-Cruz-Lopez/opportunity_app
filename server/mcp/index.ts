import { Hono, type Context } from "hono";
import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/hono";
import { createMcpHandler, type McpHttpHandler, type McpServer } from "@modelcontextprotocol/server";
import { MCP_CONFIG } from "./config";
import { consoleSink, normalizeClientName, type McpEventSink, type RequestFacts } from "./log";
import { createR2RegistrySource, type McpRegistry, type R2Like } from "./registry";
import { createNovusMcpServer } from "./server";

/**
 * /mcp: the public, read-only MCP server (plan 8.12). Mounted by server/app.ts as
 * `app.route("/mcp", mcpRoutes)`.
 *
 * Order of checks, each answered before any MCP code runs:
 *   1. the `mcp.enabled` flag (off answers 404; turning it off is the rollback),
 *   2. Host and Origin validation (DNS rebinding; the SDK handler does none itself),
 *   3. an optional per-IP rate limit (the IP is used as a key and never logged),
 *   4. one JSON-RPC message per POST: batch arrays and oversized bodies get 400 / 413.
 * Then `createMcpHandler(factory, { responseMode: "json" })` serves revision 2026-07-28 and, through
 * its default stateless legacy leg, 2025-era clients on the same path.
 */

/** The bindings this module reads; a structural subset of server/env.ts Env. */
export interface McpBindings {
  readonly DB?: { prepare(sql: string): { bind(...values: unknown[]): { first<T = unknown>(): Promise<T | null> } } };
  readonly STORE?: R2Like;
  readonly APP_ORIGIN?: string;
  readonly ENVIRONMENT?: string;
  /** Optional Workers rate-limit binding (anonymous tier, 60 a minute per IP in plan 8.12). */
  readonly MCP_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}

export interface McpRouteDeps {
  isEnabled(env: McpBindings, now: number): Promise<boolean>;
  loadRegistry(env: McpBindings, now: number): Promise<McpRegistry>;
  allowedHosts(env: McpBindings): string[];
  now(): number;
  sink: McpEventSink;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export function defaultAllowedHosts(env: McpBindings): string[] {
  const hosts: string[] = [];
  try {
    if (env.APP_ORIGIN) hosts.push(new URL(env.APP_ORIGIN).hostname);
  } catch {
    // An invalid APP_ORIGIN allows nothing but local hosts in non-production.
  }
  if (env.ENVIRONMENT !== "production") hosts.push(...LOCAL_HOSTS);
  return [...new Set(hosts)];
}

/** Reads the flag from D1's `flags` table (not a registry read) with a short isolate cache; fails closed. */
export function createFlagReader(ttlMs: number = MCP_CONFIG.flagTtlMs): McpRouteDeps["isEnabled"] {
  let cached: { value: boolean; at: number } | null = null;
  return async (env, now) => {
    if (cached && now - cached.at < ttlMs) return cached.value;
    let value = false;
    try {
      const row = await env.DB?.prepare("SELECT enabled FROM flags WHERE key = ?").bind(MCP_CONFIG.flagKey).first<{ enabled: number | boolean }>();
      value = row ? Boolean(row.enabled) : false;
    } catch {
      value = false;
    }
    cached = { value, at: now };
    return value;
  };
}

function defaultRegistryLoader(): McpRouteDeps["loadRegistry"] {
  const fromR2 = createR2RegistrySource();
  return async (env, now) => {
    if (!env.STORE) throw new Error("STORE binding missing");
    return fromR2(env.STORE, now);
  };
}

function jsonRpcError(c: Context, status: 400 | 413 | 429, code: number, message: string) {
  return c.json({ jsonrpc: "2.0", id: null, error: { code, message } }, status);
}

/** Reads the body once with a byte cap; returns the parsed JSON, or a response to send instead. */
async function readSingleMessage(c: Context): Promise<{ body: unknown } | { response: Response }> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MCP_CONFIG.maxBodyBytes) return { response: jsonRpcError(c, 413, -32600, "Request body too large") };
  const text = await c.req.raw.clone().text();
  if (new TextEncoder().encode(text).length > MCP_CONFIG.maxBodyBytes) return { response: jsonRpcError(c, 413, -32600, "Request body too large") };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { response: jsonRpcError(c, 400, -32700, "Parse error") };
  }
  if (Array.isArray(body)) return { response: jsonRpcError(c, 400, -32600, "JSON-RPC batches are not supported; send one message per request") };
  return { body };
}

function requestFacts(c: Context): RequestFacts {
  return {
    protocolVersion: c.req.header("mcp-protocol-version")?.slice(0, 20) ?? null,
    clientName: normalizeClientName(c.req.header("user-agent")),
    tier: "anonymous",
    apiClientId: null,
  };
}

export function createMcpRoutes(overrides: Partial<McpRouteDeps> = {}): Hono<{ Bindings: McpBindings }> {
  const deps: McpRouteDeps = {
    isEnabled: overrides.isEnabled ?? createFlagReader(),
    loadRegistry: overrides.loadRegistry ?? defaultRegistryLoader(),
    allowedHosts: overrides.allowedHosts ?? defaultAllowedHosts,
    now: overrides.now ?? Date.now,
    sink: overrides.sink ?? consoleSink,
  };
  const app = new Hono<{ Bindings: McpBindings }>();

  // One handler per isolate. The SDK calls the factory with the Request it was given, so each
  // request's bindings and log facts travel through this WeakMap instead of a closure per handler.
  const pendingServers = new WeakMap<Request, () => McpServer>();
  let handler: McpHttpHandler | null = null;
  const getHandler = (): McpHttpHandler =>
    (handler ??= createMcpHandler(
      (ctx) => {
        const make = ctx.requestInfo ? pendingServers.get(ctx.requestInfo) : undefined;
        if (!make) throw new Error("MCP request was not prepared by mcpRoutes");
        return make();
      },
      { responseMode: "json", maxRequestBodySize: MCP_CONFIG.maxBodyBytes },
    ));

  app.use("*", async (c, next) => {
    if (!(await deps.isEnabled(c.env ?? {}, deps.now()))) return c.json({ error: "not_found" }, 404);
    await next();
  });
  app.use("*", async (c, next) => hostHeaderValidation(deps.allowedHosts(c.env ?? {}))(c, next));
  app.use("*", async (c, next) => originValidation(deps.allowedHosts(c.env ?? {}))(c, next));
  app.use("*", async (c, next) => {
    const limiter = c.env?.MCP_RATE_LIMITER;
    const ip = c.req.header("cf-connecting-ip");
    if (limiter && ip) {
      const { success } = await limiter.limit({ key: `mcp:${ip}` });
      if (!success) return jsonRpcError(c, 429, -32000, "Rate limit reached; try again in a minute");
    }
    await next();
  });

  app.all("/", async (c) => {
    const env = c.env ?? {};
    let parsedBody: unknown;
    if (c.req.method === "POST") {
      const read = await readSingleMessage(c);
      if ("response" in read) return read.response;
      parsedBody = read.body;
    }
    const origin = env.APP_ORIGIN ?? new URL(c.req.url).origin;
    const request = requestFacts(c);
    pendingServers.set(c.req.raw, () =>
      createNovusMcpServer({ loadRegistry: () => deps.loadRegistry(env, deps.now()), origin, now: deps.now, sink: deps.sink, request }),
    );
    return getHandler().fetch(c.req.raw, parsedBody === undefined ? {} : { parsedBody });
  });

  return app;
}

export const mcpRoutes = createMcpRoutes();

export { createNovusMcpServer } from "./server";
export { registryFromArtifact, createR2RegistrySource, RELEASE_KEYS } from "./registry";
export { MCP_TOOLS } from "./tools";
