import type { Context, MiddlewareHandler } from "hono";
import { problem, type ApiErrorCode } from "@shared/contracts/common";
import { getDb } from "@server/db/client";
import { jobs } from "@server/db/repos";
import { consoleLogger, type Logger, type WorkerBindings } from "@server/jobs/types";
import { sha256Hex } from "./crypto";
import { IDEMPOTENCY_HEADER, nonceExpiresAt, readSignedHeaders, verifySignedRequest } from "./hmac";
import { mayCall, parseKeyring, scopeFor, type InternalRouteId } from "./keys";

/**
 * Authentication for `/internal/v1/*` (architecture 2.3.14). In order:
 *   1. size cap, 2. signing headers present and well formed, 3. timestamp within 60 s,
 *   4. known key and valid HMAC over method, path?query, timestamp, nonce, body hash, key id,
 *   5. the key's route scope (403 plus an ops alert otherwise; break-glass also needs its flag),
 *   6. single-use nonce (a unique D1 insert; a replay answers 409),
 *   7. an Idempotency-Key on every POST and PUT.
 * Cloudflare Access (service token) sits in front of `internal.<domain>` at the edge; this
 * middleware does not rely on it.
 */

export interface InternalVariables {
  internalKeyId: string;
  idempotencyKey: string | null;
  rawBody: Uint8Array;
  bodySha256: string;
}

export type InternalAppEnv = { Bindings: WorkerBindings; Variables: InternalVariables };
export type InternalContext = Context<InternalAppEnv>;

/** JSON bodies are capped below 16 MB (inline Snapshots carry up to ~14 MB of base64). */
export const MAX_JSON_BYTES = 16 * 1024 * 1024;
/** Raw Snapshot uploads: 32 MB PDFs plus headroom. */
export const MAX_RAW_BYTES = 34 * 1024 * 1024;

let keyringCache: { raw: string | undefined; ring: ReadonlyMap<string, string> } | null = null;

function keyring(raw: string | undefined): ReadonlyMap<string, string> {
  if (!keyringCache || keyringCache.raw !== raw) keyringCache = { raw, ring: parseKeyring(raw) };
  return keyringCache.ring;
}

export function problemResponse(c: Context, code: ApiErrorCode, detail?: string, status?: number): Response {
  const body = problem(code, detail ? { detail } : {});
  return c.json(status ? { ...body, status } : body, (status ?? body.status) as 400);
}

export interface InternalAuthOptions {
  readonly maxBytes?: number;
  readonly now?: () => number;
  readonly log?: Logger;
}

export function internalAuth(route: InternalRouteId, opts: InternalAuthOptions = {}): MiddlewareHandler<InternalAppEnv> {
  const maxBytes = opts.maxBytes ?? MAX_JSON_BYTES;
  return async (c, next) => {
    const log = opts.log ?? consoleLogger;
    const now = (opts.now ?? Date.now)();
    const refuse = (status: 401 | 403 | 409, reason: string, keyId: string | null) => {
      log(status === 403 ? "alert" : "warn", "internal.refused", { route, reason, keyId, status });
      const code: ApiErrorCode = status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : "conflict";
      return problemResponse(c, code, status === 409 ? "nonce already used" : undefined);
    };

    const declared = Number(c.req.header("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > maxBytes) return problemResponse(c, "payload_too_large");

    const headers = readSignedHeaders(c.req.raw.headers);
    if (!headers) return refuse(401, "missing_or_malformed_headers", null);

    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.byteLength > maxBytes) return problemResponse(c, "payload_too_large");
    const bodySha256 = await sha256Hex(body);
    const url = new URL(c.req.url);
    const verdict = await verifySignedRequest({
      method: c.req.method,
      pathAndQuery: `${url.pathname}${url.search}`,
      headers,
      bodySha256,
      secret: keyring(c.env.INTERNAL_HMAC_KEYS).get(headers.keyId),
      nowMs: now,
    });
    if (!verdict.ok) return refuse(401, verdict.reason, headers.keyId);

    if (!mayCall(headers.keyId, route)) return refuse(403, "route_out_of_scope", headers.keyId);
    const db = getDb(c.env.DB);
    const flag = scopeFor(headers.keyId)?.requiresFlag;
    if (flag && !(await jobs.getFlags(db))[flag]) return refuse(403, "key_disabled", headers.keyId);

    if (!(await jobs.useNonce(db, headers.nonce, headers.keyId, nonceExpiresAt(Number(headers.timestamp))))) {
      return refuse(409, "replayed_nonce", headers.keyId);
    }

    const idempotencyKey = c.req.header(IDEMPOTENCY_HEADER) ?? null;
    if ((c.req.method === "POST" || c.req.method === "PUT") && (!idempotencyKey || idempotencyKey.length > 200)) {
      return problemResponse(c, "bad_request", "Idempotency-Key header required");
    }

    c.set("internalKeyId", headers.keyId);
    c.set("idempotencyKey", idempotencyKey);
    c.set("rawBody", body);
    c.set("bodySha256", bodySha256);
    await next();
  };
}
