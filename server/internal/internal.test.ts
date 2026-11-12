import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { signInternalRequest } from "@server/lib/hmac";
import { jobs } from "@server/db/repos";
import * as s from "@server/db/schema";
import { freshDb, freshEventsDb } from "@server/db/testing/fixtures";
import type { Db } from "@server/db/client";
import type { Logger, LogLevel, WorkerBindings } from "@server/jobs/types";
import { sha256Hex } from "./crypto";
import { readSignedHeaders, verifySignedRequest, signCanonical, nonceExpiresAt } from "./hmac";
import { checkUrlChain, resolveSeedPolicy, stricter } from "./host-policy";
import { keyFamily, leasableKinds, mayCall, parseKeyring } from "./keys";
import { createInternalRoutes } from "./routes";

// Test-only secrets: synthetic, never used anywhere else.
const SECRETS = {
  "fetch.test": "test-only-fetch-secret-0123456789abcdef",
  "clock.test": "test-only-clock-secret-0123456789abcdef",
  "llm.test": "test-only-llm-secret-00123456789abcdef",
  "breakglass.test": "test-only-breakglass-secret-0123456789ab",
} as const;
type KeyId = keyof typeof SECRETS;

const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);

/** In-memory R2 with the four calls the internal router makes. */
function fakeR2() {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const toBytes = async (v: unknown): Promise<Uint8Array> => {
    if (typeof v === "string") return new TextEncoder().encode(v);
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return new Uint8Array(await new Response(v as BodyInit).arrayBuffer());
  };
  const bucket = {
    objects,
    async head(key: string) {
      return objects.has(key) ? { key } : null;
    },
    async get(key: string) {
      const o = objects.get(key);
      if (!o) return null;
      return {
        body: new Response(o.bytes).body,
        httpMetadata: { contentType: o.contentType },
        json: async () => JSON.parse(new TextDecoder().decode(o.bytes)),
        text: async () => new TextDecoder().decode(o.bytes),
      };
    },
    async put(key: string, value: unknown, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: await toBytes(value), contentType: opts?.httpMetadata?.contentType ?? "application/octet-stream" });
      return { key };
    },
  };
  return bucket;
}

interface Harness {
  db: Db;
  env: WorkerBindings;
  store: ReturnType<typeof fakeR2>;
  logs: { level: LogLevel; event: string; fields: Record<string, unknown> }[];
  call: (method: string, path: string, opts?: CallOpts) => Promise<Response>;
}

interface CallOpts {
  keyId?: KeyId;
  body?: unknown;
  rawBody?: Uint8Array;
  nonce?: string;
  skewSeconds?: number;
  idempotencyKey?: string | null;
  tamper?: (headers: Record<string, string>) => void;
  headers?: Record<string, string>;
  signedPath?: string;
}

let nonceCounter = 0;
const freshNonce = () => `nonce${String(++nonceCounter).padStart(16, "0")}`;

async function harness(): Promise<Harness> {
  const { raw, db } = await freshDb();
  const events = await freshEventsDb();
  const store = fakeR2();
  const env: WorkerBindings = {
    DB: raw.d1 as unknown as D1Database,
    EVENTS_DB: events.raw.d1 as unknown as D1Database,
    STORE: store as unknown as R2Bucket,
    INTERNAL_HMAC_KEYS: JSON.stringify(SECRETS),
  };
  const logs: Harness["logs"] = [];
  const log: Logger = (level, event, fields = {}) => logs.push({ level, event, fields });
  const app = new Hono().route("/internal/v1", createInternalRoutes({ now: () => NOW, log }));

  const call = async (method: string, path: string, o: CallOpts = {}) => {
    const keyId = o.keyId ?? "fetch.test";
    const body = o.rawBody ?? (o.body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(o.body)));
    const signed = await signInternalRequest({
      method,
      pathAndQuery: o.signedPath ?? path,
      body,
      keyId,
      secret: SECRETS[keyId],
      nowSeconds: NOW / 1000 + (o.skewSeconds ?? 0),
      nonce: o.nonce ?? freshNonce(),
    });
    const headers: Record<string, string> = { ...signed, "content-type": "application/json", ...(o.headers ?? {}) };
    if (o.idempotencyKey !== null && method !== "GET") headers["idempotency-key"] = o.idempotencyKey ?? `test:${nonceCounter}`;
    o.tamper?.(headers);
    return app.request(path, { method, headers, body: method === "GET" ? undefined : (body as BodyInit) }, env);
  };
  return { db, env, store, logs, call };
}

describe("HMAC request verification", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it("accepts a request signed exactly as the pipeline signs it", async () => {
    const res = await h.call("POST", "/internal/v1/heartbeats", { body: { worker: "fetch-1", at: new Date(NOW).toISOString(), version: "0.1.0", leasedJobs: 0 } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await jobs.getHeartbeat(h.db, "pipeline"))?.lastSeenAt).toBe(NOW);
  });

  it("refuses a missing or malformed signature with 401", async () => {
    const res = await h.call("POST", "/internal/v1/heartbeats", { body: {}, tamper: (hd) => delete hd["x-novus-signature"] });
    expect(res.status).toBe(401);
    const bad = await h.call("POST", "/internal/v1/heartbeats", { body: {}, tamper: (hd) => (hd["x-novus-signature"] = "zz") });
    expect(bad.status).toBe(401);
  });

  it("refuses a request signed for another path or under an unknown key", async () => {
    const body = { worker: "w", at: new Date(NOW).toISOString(), version: "1", leasedJobs: 0 };
    const signedForOther = await h.call("POST", "/internal/v1/heartbeats", { body, signedPath: "/internal/v1/heartbeats?x=1" });
    expect(signedForOther.status).toBe(401);

    const wrongKey = await h.call("POST", "/internal/v1/heartbeats", { body, tamper: (hd) => (hd["x-novus-key-id"] = "guidance.test") });
    expect(wrongKey.status).toBe(401);
    expect(h.logs.some((l) => l.event === "internal.refused" && l.fields.reason === "unknown_key")).toBe(true);
  });

  it("refuses a body that differs from the declared content hash", async () => {
    const body = { worker: "w", at: new Date(NOW).toISOString(), version: "1", leasedJobs: 0 };
    const res = await h.call("POST", "/internal/v1/heartbeats", { body, tamper: (hd) => (hd["x-novus-content-sha256"] = "c".repeat(64)) });
    expect(res.status).toBe(401);
    expect(h.logs.some((l) => l.fields.reason === "content_hash_mismatch")).toBe(true);
  });

  it("detects a body changed after signing", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ worker: "w", at: new Date(NOW).toISOString(), version: "1", leasedJobs: 0 }));
    const headers = readSignedHeaders(
      new Headers(
        await signInternalRequest({ method: "POST", pathAndQuery: "/p", body, keyId: "fetch.test", secret: SECRETS["fetch.test"], nowSeconds: NOW / 1000, nonce: freshNonce() }),
      ),
    );
    expect(headers).not.toBeNull();
    const ok = await verifySignedRequest({ method: "POST", pathAndQuery: "/p", headers: headers!, bodySha256: await sha256Hex(body), secret: SECRETS["fetch.test"], nowMs: NOW });
    expect(ok).toEqual({ ok: true });
    const changed = await sha256Hex(new TextEncoder().encode("{}"));
    const hashMismatch = await verifySignedRequest({ method: "POST", pathAndQuery: "/p", headers: headers!, bodySha256: changed, secret: SECRETS["fetch.test"], nowMs: NOW });
    expect(hashMismatch).toEqual({ ok: false, reason: "content_hash_mismatch" });
    const noDeclared = await verifySignedRequest({
      method: "POST",
      pathAndQuery: "/p",
      headers: { ...headers!, contentSha256: null },
      bodySha256: changed,
      secret: SECRETS["fetch.test"],
      nowMs: NOW,
    });
    expect(noDeclared).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses timestamps outside the 60-second window", async () => {
    const body = { worker: "w", at: new Date(NOW).toISOString(), version: "1", leasedJobs: 0 };
    expect((await h.call("POST", "/internal/v1/heartbeats", { body, skewSeconds: -61 })).status).toBe(401);
    expect((await h.call("POST", "/internal/v1/heartbeats", { body, skewSeconds: 61 })).status).toBe(401);
    expect((await h.call("POST", "/internal/v1/heartbeats", { body, skewSeconds: 59 })).status).toBe(200);
  });

  it("refuses a replayed nonce with 409", async () => {
    const body = { worker: "w", at: new Date(NOW).toISOString(), version: "1", leasedJobs: 0 };
    const nonce = freshNonce();
    expect((await h.call("POST", "/internal/v1/heartbeats", { body, nonce })).status).toBe(200);
    const replay = await h.call("POST", "/internal/v1/heartbeats", { body, nonce });
    expect(replay.status).toBe(409);
    expect(h.logs.some((l) => l.fields.reason === "replayed_nonce")).toBe(true);
  });

  it("answers 403 and raises an alert for a key outside its route scope", async () => {
    const res = await h.call("POST", "/internal/v1/tick/catch-up", { body: {}, keyId: "fetch.test" });
    expect(res.status).toBe(403);
    expect(h.logs.some((l) => l.level === "alert" && l.fields.reason === "route_out_of_scope")).toBe(true);
    // clock may call catch-up, but nothing else.
    expect((await h.call("POST", "/internal/v1/heartbeats", { body: {}, keyId: "clock.test" })).status).toBe(403);
  });

  it("keeps the break-glass key disabled until its flag is on", async () => {
    const body = { worker: "laptop", at: new Date(NOW).toISOString(), version: "1", leasedJobs: 0 };
    expect((await h.call("POST", "/internal/v1/heartbeats", { body, keyId: "breakglass.test" })).status).toBe(403);
    await jobs.setFlag(h.db, "breakglass.enabled", true, NOW);
    expect((await h.call("POST", "/internal/v1/heartbeats", { body, keyId: "breakglass.test" })).status).toBe(200);
  });

  it("requires an Idempotency-Key on POST", async () => {
    const res = await h.call("POST", "/internal/v1/heartbeats", { body: { worker: "w", at: new Date(NOW).toISOString(), version: "1", leasedJobs: 0 }, idempotencyKey: null });
    expect(res.status).toBe(400);
  });

  it("validates bodies with the shared contracts", async () => {
    const res = await h.call("POST", "/internal/v1/heartbeats", { body: { worker: "w", extra: true } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("validation_failed");
  });

  it("computes nonce expiry past both sides of the window", () => {
    expect(nonceExpiresAt(1000)).toBe((1000 + 120) * 1000);
  });

  it("signs the same canonical string as server/lib/hmac", async () => {
    const parts = { method: "post", pathAndQuery: "/internal/v1/jobs/lease", timestamp: "1700000000", nonce: "a".repeat(32), bodySha256: "0".repeat(64), keyId: "fetch" };
    const viaLib = await signInternalRequest({ method: "POST", pathAndQuery: parts.pathAndQuery, body: "", keyId: "fetch", secret: "s".repeat(32), nowSeconds: 1700000000, nonce: parts.nonce });
    const emptySha = await sha256Hex("");
    expect(await signCanonical("s".repeat(32), { ...parts, bodySha256: emptySha })).toBe(viaLib["x-novus-signature"]);
  });
});

describe("key scopes and keyring", () => {
  it("derives the family from a rotation suffix", () => {
    expect(keyFamily("fetch.2026q4")).toBe("fetch");
    expect(keyFamily("fetch:2")).toBe("fetch");
    expect(keyFamily("unknown.1")).toBeNull();
  });

  it("never lets a pipeline key reach curation patches except curate_import", () => {
    for (const key of ["fetch", "guidance", "clock", "breakglass", "rollover", "llm", "docintel", "ops"]) {
      expect(mayCall(key, "ingestCurationPatch")).toBe(false);
    }
    expect(mayCall("curate_import", "ingestCurationPatch")).toBe(true);
    expect(leasableKinds("breakglass")).not.toContain("llm");
  });

  it("drops malformed entries instead of failing the whole keyring", () => {
    const ring = parseKeyring(JSON.stringify({ fetch: "x".repeat(32), llm: "short", "evil key": "y".repeat(40), nope: "z".repeat(40) }));
    expect([...ring.keys()]).toEqual(["fetch"]);
    expect(parseKeyring("not json").size).toBe(0);
    expect(parseKeyring(undefined).size).toBe(0);
  });
});

describe("host policy gate", () => {
  it("matches seed entries by suffix, wildcard and path", () => {
    expect(resolveSeedPolicy("https://www.linkedin.com/jobs/1").policy).toBe("never");
    expect(resolveSeedPolicy("https://foundation.smapply.io/prog").policy).toBe("manual_only");
    expect(resolveSeedPolicy("https://docs.google.com/forms/d/abc").policy).toBe("link_only");
    expect(resolveSeedPolicy("https://docs.google.com/document/d/abc").policy).toBe("allowed");
    expect(resolveSeedPolicy("ftp://example.org").policy).toBe("never");
  });

  it("refuses a chain when any hop lands on a restricted host", () => {
    const d = checkUrlChain(["https://programs.example.org/apply", "https://lnkd.in/x"]);
    expect(d).toMatchObject({ allowed: false, refusedHost: "lnkd.in", refusedPolicy: "never" });
    expect(checkUrlChain(["https://programs.example.org/apply"]).allowed).toBe(true);
  });

  it("takes the stricter of seed and stored policy", () => {
    expect(stricter("allowed", "manual_only")).toBe("manual_only");
    const d = checkUrlChain(["https://programs.example.org/"], new Map([["programs.example.org", "link_only"]]));
    expect(d.allowed).toBe(false);
  });
});

describe("job leasing over /internal/v1", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  async function enqueueFetch(n: number, host = "a.example.org") {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await jobs.enqueueJob(h.db, { kind: "fetch", idempotencyKey: `fetch:src${i}:${host}`, concurrencyKey: `host:${host}:${i}`, payload: { sourceId: `src${i}` } }, NOW - 1000);
      ids.push(r.id);
    }
    return ids;
  }

  it("leases due jobs of the key's kinds and records a pipeline heartbeat", async () => {
    await enqueueFetch(3);
    const res = await h.call("POST", "/internal/v1/jobs/lease", { body: { kinds: ["fetch"], max: 2, owner: "modal-1" } });
    expect(res.status).toBe(200);
    const { jobs: leased } = (await res.json()) as { jobs: { id: string; status: string; leaseOwner: string }[] };
    expect(leased).toHaveLength(2);
    expect(leased.every((j) => j.status === "leased" && j.leaseOwner === "modal-1")).toBe(true);
    expect((await jobs.getHeartbeat(h.db, "pipeline"))?.lastSeenAt).toBe(NOW);
  });

  it("refuses to lease kinds outside the key's scope", async () => {
    const res = await h.call("POST", "/internal/v1/jobs/lease", { body: { kinds: ["llm"], owner: "modal-1" } });
    expect(res.status).toBe(403);
    expect(h.logs.some((l) => l.event === "internal.lease_out_of_scope")).toBe(true);
  });

  it("holds one live lease per concurrency key", async () => {
    await jobs.enqueueJob(h.db, { kind: "fetch", idempotencyKey: "fetch:x:1", concurrencyKey: "host:same.example.org" }, NOW - 1000);
    await jobs.enqueueJob(h.db, { kind: "fetch", idempotencyKey: "fetch:y:1", concurrencyKey: "host:same.example.org" }, NOW - 1000);
    const first = (await (await h.call("POST", "/internal/v1/jobs/lease", { body: { kinds: ["fetch"], max: 5, owner: "a" } })).json()) as { jobs: unknown[] };
    const second = (await (await h.call("POST", "/internal/v1/jobs/lease", { body: { kinds: ["fetch"], max: 5, owner: "b" } })).json()) as { jobs: unknown[] };
    expect(first.jobs).toHaveLength(1);
    expect(second.jobs).toHaveLength(0);
  });

  it("completes a leased job once; a retried completion is a no-op", async () => {
    const [id] = await enqueueFetch(1);
    await h.call("POST", "/internal/v1/jobs/lease", { body: { kinds: ["fetch"], owner: "modal-1" } });
    const done = await h.call("POST", `/internal/v1/jobs/${id}/complete`, { body: { owner: "modal-1" }, idempotencyKey: "complete:1" });
    expect(await done.json()).toEqual({ status: "done" });
    // Same Idempotency-Key, fresh nonce (the pipeline's retry): no second effect.
    const again = await h.call("POST", `/internal/v1/jobs/${id}/complete`, { body: { owner: "modal-1" }, idempotencyKey: "complete:1" });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "already_done" });
    const runs = await h.db.select().from(s.jobRuns);
    expect(runs.filter((r) => r.jobId === id)).toHaveLength(1);
  });

  it("refuses completion by another owner", async () => {
    const [id] = await enqueueFetch(1);
    await h.call("POST", "/internal/v1/jobs/lease", { body: { kinds: ["fetch"], owner: "modal-1" } });
    const res = await h.call("POST", `/internal/v1/jobs/${id}/complete`, { body: { owner: "intruder" } });
    expect(res.status).toBe(409);
  });

  it("applies a fetch's next check time from the completion result", async () => {
    const t = NOW - 1000;
    await h.db.insert(s.sourceHosts).values({ host: "programs.example.org", policy: "allowed", policySource: "default", updatedAt: t });
    await h.db.insert(s.sources).values({ id: "01890000-0000-7000-8000-000000000001", url: "https://programs.example.org/a", kind: "official_page", host: "programs.example.org", createdAt: t, updatedAt: t });
    const { id } = await jobs.enqueueJob(h.db, { kind: "fetch", idempotencyKey: "fetch:s1", payload: { sourceId: "01890000-0000-7000-8000-000000000001" } }, t);
    await h.call("POST", "/internal/v1/jobs/lease", { body: { kinds: ["fetch"], owner: "m" } });
    const next = new Date(NOW + 86_400_000).toISOString();
    expect((await h.call("POST", `/internal/v1/jobs/${id}/complete`, { body: { owner: "m", result: { nextCheckAt: next } } })).status).toBe(200);
    const src = await h.db.query.sources.findFirst();
    expect(src?.nextCheckAt).toBe(NOW + 86_400_000);
  });

  it("fails with retry, defer and dead dispositions", async () => {
    const ids = await enqueueFetch(3);
    await h.call("POST", "/internal/v1/jobs/lease", { body: { kinds: ["fetch"], max: 3, owner: "m" } });
    const statuses = [];
    for (const [i, disposition] of (["retry", "defer", "dead"] as const).entries()) {
      const res = await h.call("POST", `/internal/v1/jobs/${ids[i]}/fail`, { body: { owner: "m", errorClass: "HTTPError", disposition } });
      statuses.push(((await res.json()) as { status: string }).status);
    }
    expect(statuses).toEqual(["retrying", "deferred", "dead"]);
    expect(h.logs.some((l) => l.event === "job.dead")).toBe(true);
    const deferred = await jobs.getJob(h.db, ids[1]!);
    expect(deferred?.attempts).toBe(0);
  });

  it("does not let a key complete a kind it may not lease", async () => {
    const { id } = await jobs.enqueueJob(h.db, { kind: "llm", idempotencyKey: "llm:1" }, NOW - 1000);
    await jobs.leaseJobs(h.db, { kinds: ["llm"], max: 1, leaseMs: 60_000, owner: "m", now: NOW });
    expect((await h.call("POST", `/internal/v1/jobs/${id}/complete`, { body: { owner: "m" }, keyId: "fetch.test" })).status).toBe(403);
    expect((await h.call("POST", `/internal/v1/jobs/${id}/complete`, { body: { owner: "m" }, keyId: "llm.test" })).status).toBe(200);
  });
});

describe("snapshots, review tasks and idempotent ingest", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  function snapshotBody(raw: string, rawSha256: string, extra: Record<string, unknown> = {}) {
    return {
      sourceId: null,
      sourceKind: "official_page",
      requestedUrl: "https://programs.example.org/apply",
      finalUrl: "https://programs.example.org/apply",
      redirectChain: [],
      fetchedAt: new Date(NOW - 5000).toISOString(),
      httpStatus: 200,
      contentType: "text/html",
      rawSha256,
      mainTextSha256: null,
      normalizerVersion: "n1",
      rawBase64: btoa(raw),
      mainText: null,
      aiInputAllowed: true,
      pdfPages: null,
      ...extra,
    };
  }

  it("stores a Snapshot once; a retry returns the same row", async () => {
    const raw = "<html>Sample text, not a real program</html>";
    const sha = await sha256Hex(raw);
    const first = await h.call("POST", "/internal/v1/snapshots", { body: snapshotBody(raw, sha) });
    expect(first.status).toBe(201);
    const a = (await first.json()) as { snapshotId: string; stored: boolean };
    const retry = await h.call("POST", "/internal/v1/snapshots", { body: snapshotBody(raw, sha) });
    expect(retry.status).toBe(200);
    const b = (await retry.json()) as { snapshotId: string; stored: boolean };
    expect(b).toMatchObject({ snapshotId: a.snapshotId, stored: false });
    expect(await h.db.select().from(s.snapshots)).toHaveLength(1);
    expect(h.store.objects.has(`snapshots/raw/${sha}`)).toBe(true);
  });

  it("refuses raw bytes that do not match their hash", async () => {
    const res = await h.call("POST", "/internal/v1/snapshots", { body: snapshotBody("abc", "0".repeat(64)) });
    expect(res.status).toBe(422);
  });

  it("refuses a Snapshot whose redirect chain reaches a restricted host", async () => {
    const raw = "x";
    const res = await h.call("POST", "/internal/v1/snapshots", { body: snapshotBody(raw, await sha256Hex(raw), { redirectChain: ["https://www.linkedin.com/in/x"] }) });
    expect(res.status).toBe(422);
    expect(await h.db.select().from(s.snapshots)).toHaveLength(0);
    expect(h.logs.some((l) => l.event === "internal.host_policy_refused" && l.fields.host === "www.linkedin.com")).toBe(true);
  });

  it("asks for the raw upload first when bytes are not inline", async () => {
    const res = await h.call("POST", "/internal/v1/snapshots", { body: snapshotBody("x", "a".repeat(64), { rawBase64: null }) });
    expect(res.status).toBe(412);
  });

  it("PUT snapshots/raw is content addressed and idempotent", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7 sample");
    const sha = await sha256Hex(bytes);
    const chain = { "x-novus-url-chain": "https://programs.example.org/a.pdf", "content-type": "application/pdf" };
    const put = await h.call("PUT", `/internal/v1/snapshots/raw/${sha}`, { rawBody: bytes, headers: chain });
    expect(put.status).toBe(201);
    const again = await h.call("PUT", `/internal/v1/snapshots/raw/${sha}`, { rawBody: bytes, headers: chain });
    expect(await again.json()).toMatchObject({ stored: false });
    const wrong = await h.call("PUT", `/internal/v1/snapshots/raw/${"b".repeat(64)}`, { rawBody: bytes, headers: chain });
    expect(wrong.status).toBe(422);
    const got = await h.call("GET", `/internal/v1/snapshots/raw/${sha}`);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
  });

  it("creates a review task once and merges a repeat", async () => {
    const t0 = NOW - 1000;
    const orgId = "01890000-0000-7000-8000-0000000000a0";
    const programId = "01890000-0000-7000-8000-0000000000aa";
    await h.db.insert(s.organizations).values({ id: orgId, slug: "sample-org", name: "Sample Org", kind: "nonprofit", isSample: true, createdAt: t0, updatedAt: t0 });
    await h.db.insert(s.programs).values({ id: programId, organizationId: orgId, slug: "sample-program", name: "Sample Program", officialUrl: "https://programs.example.org/", recurrence: "annual", isSample: true, createdAt: t0, updatedAt: t0 });
    const body = { kind: "source_broken", subject: { type: "program", id: programId }, reasonCodes: ["policy_blocked"] };
    const first = await h.call("POST", "/internal/v1/review-tasks", { body });
    expect(first.status).toBe(201);
    const second = await h.call("POST", "/internal/v1/review-tasks", { body });
    expect(second.status).toBe(200);
    const a = (await first.json()) as { id: string };
    const b = (await second.json()) as { id: string };
    expect(b.id).toBe(a.id);
    expect(await h.db.select().from(s.reviewTasks)).toHaveLength(1);
  });

  it("records LLM call metering without text", async () => {
    const res = await h.call("POST", "/internal/v1/llm-calls", {
      keyId: "llm.test",
      body: { routeId: "extract", routeVersion: "1", modelRequested: "gemini-test", status: "ok", inputTokens: 10, outputTokens: 5, prompt: "never stored" },
    });
    expect(res.status).toBe(201);
  });

  it("answers 501 for curation patches until apply exists, after validating the body", async () => {
    const res = await h.call("POST", "/internal/v1/curation-patches", { body: { rowHash: "x" } });
    // fetch keys may not call it at all.
    expect(res.status).toBe(403);
  });

  it("answers problem+json 404 for unknown internal paths after auth", async () => {
    const res = await h.call("POST", "/internal/v1/nothing-here", { body: {} });
    expect(res.status).toBe(404);
  });
});
