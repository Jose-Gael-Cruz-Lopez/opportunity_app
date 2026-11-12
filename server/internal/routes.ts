import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { IdSchema, UrlSchema, issuesFromZod, problem } from "@shared/contracts/common";
import { CurationPatchSchema, ExtractionIngestSchema, HeartbeatSchema, SnapshotIngestSchema } from "@shared/contracts/internal";
import { CreateReviewTaskInputSchema, JobCompleteSchema, JobFailSchema, JobLeaseRequestSchema, type JobKind } from "@shared/contracts/ops";
import { SourceKindSchema } from "@shared/taxonomy";
import { getDb, getEventsDb, type Db } from "@server/db/client";
import { events, jobs, registry, review } from "@server/db/repos";
import * as s from "@server/db/schema";
import { catchUp } from "@server/jobs";
import { consoleLogger, type Logger } from "@server/jobs/types";
import { actorForInternalKey } from "@server/services/audit";
import { internalAuth, problemResponse, MAX_RAW_BYTES, type InternalAppEnv, type InternalContext } from "./auth";
import { base64Decode, sha256Hex } from "./crypto";
import { checkUrlChain, hostOf, FETCHABLE_POLICIES } from "./host-policy";
import { keyFamily, leasableKinds, mayHandleKind } from "./keys";
import { findSnapshot, getSnapshot, getSource, getSourceByUrl, latestSnapshotOfSource, sourcePolicyFor, storedHostPolicies } from "./store";

/**
 * `/internal/v1/*`: the pipeline's only way to read and write (it holds no D1 or R2 credentials).
 * Every route sits behind `internalAuth(routeId)`. Handlers are idempotent by construction, so a
 * retry with the same Idempotency-Key and a fresh nonce has no further effect:
 *   jobs: lease state machine (complete/fail check owner and state);
 *   snapshots: content-addressed R2 keys plus a lookup of the identical Snapshot row;
 *   review tasks: upsert on the live dedupe key; heartbeats: last write wins.
 */

export interface InternalRouteOptions {
  readonly now?: () => number;
  readonly log?: Logger;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const RAW_PREFIX = "snapshots/raw/";
const TEXT_PREFIX = "snapshots/text/";

function decodeJson(c: InternalContext): unknown {
  const raw = c.get("rawBody");
  if (raw.byteLength === 0) return {};
  return JSON.parse(new TextDecoder().decode(raw));
}

type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response };

function parseBody<S extends z.ZodTypeAny>(c: InternalContext, schema: S): Parsed<z.output<S>> {
  let json: unknown;
  try {
    json = decodeJson(c);
  } catch {
    return { ok: false, res: problemResponse(c, "bad_request", "body is not JSON") };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, res: c.json(problem("validation_failed", { errors: issuesFromZod(parsed.error) }), 400) };
  return { ok: true, data: parsed.data };
}

function unprocessable(c: InternalContext, detail: string): Response {
  return c.json({ ...problem("forbidden", { detail }), status: 422 }, 422);
}

function notImplemented(c: InternalContext, detail: string): Response {
  return c.json({ ...problem("unavailable", { detail }), status: 501 }, 501);
}

/** Phase-2 LLM metering record: counts and ids only. Unknown keys (and any text) are dropped. */
const LlmCallRecordSchema = z.object({
  routeId: z.string().min(1).max(60),
  routeVersion: z.string().min(1).max(20),
  provider: z.string().max(40).default("gemini"),
  modelRequested: z.string().min(1).max(80),
  modelServed: z.string().max(80).nullable().default(null),
  status: z.enum(["ok", "schema_invalid", "refused", "max_tokens", "timeout", "error", "degraded"]),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  costMicros: z.number().int().nonnegative().default(0),
  latencyMs: z.number().int().nonnegative().nullable().default(null),
  requestId: z.string().max(120).nullable().default(null),
  reservationId: z.string().max(80).nullable().default(null),
});

const SourceUpsertSchema = z
  .object({
    url: UrlSchema,
    kind: SourceKindSchema,
    programId: IdSchema.nullable().default(null),
    organizationId: IdSchema.nullable().default(null),
  })
  .strict();

async function reviewTaskById(db: Db, id: string) {
  const row = await db.query.reviewTasks.findFirst({ where: eq(s.reviewTasks.id, id) });
  return row ? review.toReviewTask(row, await registry.curatorHandles(db)) : null;
}

export function createInternalRoutes(opts: InternalRouteOptions = {}): Hono<InternalAppEnv> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? consoleLogger;
  const auth = (route: Parameters<typeof internalAuth>[0], maxBytes?: number) => internalAuth(route, { now, log, maxBytes });
  const app = new Hono<InternalAppEnv>();

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  // ---- Jobs ---------------------------------------------------------------------------------

  app.post("/jobs/lease", auth("leaseJobs"), async (c) => {
    const body = parseBody(c, JobLeaseRequestSchema);
    if (!body.ok) return body.res;
    const keyId = c.get("internalKeyId");
    const allowed = new Set<string>(leasableKinds(keyId));
    const outOfScope = body.data.kinds.filter((k) => !allowed.has(k));
    if (outOfScope.length > 0) {
      log("alert", "internal.lease_out_of_scope", { keyId, kinds: outOfScope.join(",") });
      return problemResponse(c, "forbidden");
    }
    const db = getDb(c.env.DB);
    const t = now();
    const leased = await jobs.leaseJobs(db, { kinds: body.data.kinds as JobKind[], max: body.data.max, leaseMs: body.data.leaseSeconds * 1000, owner: body.data.owner, now: t });
    // A lease is a sign of life even when the worker forgets its heartbeat.
    await jobs.heartbeat(db, "pipeline", t, { keyId, via: "lease" });
    return c.json({ jobs: leased });
  });

  app.post("/jobs/:id/complete", auth("completeJob"), async (c) => {
    const body = parseBody(c, JobCompleteSchema);
    if (!body.ok) return body.res;
    const id = c.req.param("id");
    const keyId = c.get("internalKeyId");
    const db = getDb(c.env.DB);
    const job = await jobs.getJob(db, id);
    if (!job) return problemResponse(c, "not_found");
    if (!mayHandleKind(keyId, job.kind)) return problemResponse(c, "forbidden");
    if (job.status === "done") return c.json({ status: "already_done" });
    if (job.status !== "leased" || job.leaseOwner !== body.data.owner) return problemResponse(c, "conflict", "job is not leased by this owner");
    const t = now();
    // A fetch completion carries the next check time computed in Python (s04's cadence).
    if (job.kind === "fetch" && typeof job.payload.sourceId === "string" && "nextCheckAt" in body.data.result) {
      const next = body.data.result.nextCheckAt;
      const nextMs = typeof next === "string" ? Date.parse(next) : null;
      if (next === null || (nextMs !== null && Number.isFinite(nextMs))) await registry.setSourceSchedule(db, job.payload.sourceId, nextMs, t);
    }
    const done = await jobs.completeJob(db, id, body.data.owner, t);
    if (!done) return problemResponse(c, "conflict", "lease expired");
    const runId = await jobs.startJobRun(db, { kind: job.kind, trigger: "lease", jobId: id }, t);
    await jobs.finishJobRun(db, runId, "ok", 1, t);
    return c.json({ status: "done" });
  });

  app.post("/jobs/:id/fail", auth("failJob"), async (c) => {
    const body = parseBody(c, JobFailSchema);
    if (!body.ok) return body.res;
    const id = c.req.param("id");
    const keyId = c.get("internalKeyId");
    const db = getDb(c.env.DB);
    const job = await jobs.getJob(db, id);
    if (!job) return problemResponse(c, "not_found");
    if (!mayHandleKind(keyId, job.kind)) return problemResponse(c, "forbidden");
    const t = now();
    const result = await jobs.failJob(db, id, body.data.owner, body.data.errorClass, body.data.disposition, t);
    if (result === "not_leased") return problemResponse(c, "conflict", "job is not leased by this owner");
    if (result === "dead") log("alert", "job.dead", { kind: job.kind, jobId: id, errorClass: body.data.errorClass.slice(0, 80) });
    const runId = await jobs.startJobRun(db, { kind: job.kind, trigger: "lease", jobId: id }, t);
    await jobs.finishJobRun(db, runId, result === "deferred" ? "deferred" : "failed", 0, t, body.data.errorClass);
    return c.json({ status: result });
  });

  app.post("/tick/catch-up", auth("tickCatchUp"), async (c) => {
    const body = parseBody(c, z.object({}).strict());
    if (!body.ok) return body.res;
    const res = await catchUp(c.env, { now, log });
    return c.json({ ran: res.ran, lastStarted: res.lastStarted });
  });

  app.post("/heartbeats", auth("heartbeat"), async (c) => {
    const body = parseBody(c, HeartbeatSchema);
    if (!body.ok) return body.res;
    const db = getDb(c.env.DB);
    const t = now();
    const detail = { keyId: c.get("internalKeyId"), version: body.data.version, leasedJobs: body.data.leasedJobs, reportedAt: body.data.at };
    await jobs.heartbeat(db, `pipeline:${body.data.worker}`, t, detail);
    await jobs.heartbeat(db, "pipeline", t, { ...detail, worker: body.data.worker });
    return c.json({ ok: true });
  });

  // ---- Review tasks and extractions ----------------------------------------------------------

  app.post("/review-tasks", auth("createReviewTask"), async (c) => {
    const body = parseBody(c, CreateReviewTaskInputSchema);
    if (!body.ok) return body.res;
    const db = getDb(c.env.DB);
    const res = await review.createReviewTask(db, body.data, now(), { createdBy: actorForInternalKey(c.get("internalKeyId")).ref });
    if (!res.ok) return problemResponse(c, res.error === "invalid" ? "validation_failed" : "conflict", res.detail);
    const task = await reviewTaskById(db, res.value.id);
    if (!task) return problemResponse(c, "internal");
    return c.json(task, res.value.created ? 201 : 200);
  });

  app.post("/extractions", auth("ingestExtraction"), async (c) => {
    const body = parseBody(c, ExtractionIngestSchema);
    if (!body.ok) return body.res;
    const keyId = c.get("internalKeyId");
    const db = getDb(c.env.DB);
    const snap = await getSnapshot(db, body.data.snapshotId);
    if (!snap) return problemResponse(c, "not_found", "snapshot not found");
    // A model must never have read a page whose host signals no AI input.
    if (!snap.aiInputAllowed && keyFamily(keyId) === "llm") return unprocessable(c, "snapshot is not allowed as model input");
    const source = await getSource(db, snap.sourceId);
    if (!source?.programId) return unprocessable(c, "snapshot is not linked to a program");
    const { payload, ...meta } = body.data;
    const res = await review.createReviewTask(
      db,
      { kind: "cycle_update", subject: { type: "program", id: source.programId }, reasonCodes: ["extraction_change"], evidence: [], priority: 5, dueAt: null },
      now(),
      { extraction: { ...meta, payload }, extractedBy: actorForInternalKey(keyId).ref },
    );
    if (!res.ok) return problemResponse(c, "conflict", res.detail);
    return c.json({ reviewTaskId: res.value.id, created: res.value.created }, res.value.created ? 201 : 200);
  });

  // ---- Snapshots and sources -----------------------------------------------------------------

  app.put("/snapshots/raw/:sha256", auth("putSnapshotRaw", MAX_RAW_BYTES), async (c) => {
    const sha = c.req.param("sha256");
    if (!SHA256_RE.test(sha) || sha !== c.get("bodySha256")) return unprocessable(c, "content address mismatch");
    const chain = (c.req.header("x-novus-url-chain") ?? "").split(/\s+/).filter(Boolean);
    if (chain.length === 0) return problemResponse(c, "bad_request", "x-novus-url-chain header required");
    const db = getDb(c.env.DB);
    const decision = checkUrlChain(chain, await storedHostPolicies(db, chain.map((u) => hostOf(u) ?? "")));
    if (!decision.allowed) {
      log("alert", "internal.host_policy_refused", { keyId: c.get("internalKeyId"), host: decision.refusedHost, policy: decision.refusedPolicy });
      return unprocessable(c, "host policy forbids storing this content");
    }
    if (!c.env.STORE) return problemResponse(c, "unavailable", "object store not bound");
    const key = `${RAW_PREFIX}${sha}`;
    if (await c.env.STORE.head(key)) return c.json({ key, stored: false });
    await c.env.STORE.put(key, c.get("rawBody"), { sha256: sha, httpMetadata: { contentType: c.req.header("content-type") ?? "application/octet-stream" } });
    return c.json({ key, stored: true }, 201);
  });

  app.get("/snapshots/raw/:sha256", auth("getSnapshotRaw"), async (c) => {
    const sha = c.req.param("sha256");
    if (!SHA256_RE.test(sha)) return problemResponse(c, "not_found");
    if (!c.env.STORE) return problemResponse(c, "unavailable", "object store not bound");
    const obj = await c.env.STORE.get(`${RAW_PREFIX}${sha}`);
    if (!obj) return problemResponse(c, "not_found");
    return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream", "cache-control": "no-store" } });
  });

  app.get("/snapshots/:id", auth("getSnapshot"), async (c) => {
    const db = getDb(c.env.DB);
    const snap = await getSnapshot(db, c.req.param("id"));
    if (!snap) return problemResponse(c, "not_found");
    return c.json({
      id: snap.id,
      finalUrl: snap.finalUrl,
      rawSha256: snap.rawSha256,
      contentType: snap.contentType,
      fetchedAt: new Date(snap.fetchedAt).toISOString(),
      hostPolicy: snap.hostPolicy,
      aiInputAllowed: snap.aiInputAllowed,
      cycleKey: null,
      officialDomains: [],
      volatilePatterns: [],
    });
  });

  app.post("/snapshots", auth("ingestSnapshot"), async (c) => {
    const body = parseBody(c, SnapshotIngestSchema);
    if (!body.ok) return body.res;
    const snap = body.data;
    const keyId = c.get("internalKeyId");
    const db = getDb(c.env.DB);
    const t = now();

    const urls = [snap.requestedUrl, ...snap.redirectChain, snap.finalUrl];
    const decision = checkUrlChain(urls, await storedHostPolicies(db, urls.map((u) => hostOf(u) ?? "")));
    const existingSource = snap.sourceId ? await getSource(db, snap.sourceId) : await getSourceByUrl(db, snap.requestedUrl);
    if (snap.sourceId && !existingSource) return problemResponse(c, "not_found", "source not found");
    if (!decision.allowed) {
      log("alert", "internal.host_policy_refused", { keyId, host: decision.refusedHost, policy: decision.refusedPolicy });
      if (existingSource?.programId) {
        await review.createReviewTask(db, { kind: "source_broken", subject: { type: "program", id: existingSource.programId }, reasonCodes: ["policy_blocked"], evidence: [], priority: 3, dueAt: null }, t, {
          sourceId: existingSource.id,
          refusedHost: decision.refusedHost,
        });
      }
      return unprocessable(c, "host policy forbids storing this content");
    }

    const fetchedAt = Date.parse(snap.fetchedAt);
    if (existingSource) {
      const dup = await findSnapshot(db, existingSource.id, snap.rawSha256, snap.normalizerVersion, fetchedAt);
      if (dup) return c.json({ snapshotId: dup.id, changeClass: (dup.changeClass as "none" | "cosmetic" | "minor" | "key" | null) ?? null, stored: false });
    }

    if (!c.env.STORE) return problemResponse(c, "unavailable", "object store not bound");
    const rawKey = `${RAW_PREFIX}${snap.rawSha256}`;
    if (snap.rawBase64 !== null) {
      const bytes = base64Decode(snap.rawBase64);
      if (!bytes || (await sha256Hex(bytes)) !== snap.rawSha256) return unprocessable(c, "raw bytes do not match rawSha256");
      if (!(await c.env.STORE.head(rawKey))) await c.env.STORE.put(rawKey, bytes, { sha256: snap.rawSha256, httpMetadata: { contentType: snap.contentType } });
    } else if (!(await c.env.STORE.head(rawKey))) {
      return c.json({ ...problem("precondition_failed", { detail: "upload the raw bytes first (PUT snapshots/raw/{sha256})" }) }, 412);
    }
    let textKey: string | null = null;
    if (snap.mainText !== null && snap.mainTextSha256) {
      textKey = `${TEXT_PREFIX}${snap.mainTextSha256}.${snap.normalizerVersion}.json`;
      if (!(await c.env.STORE.head(textKey))) await c.env.STORE.put(textKey, JSON.stringify({ text: snap.mainText }), { httpMetadata: { contentType: "application/json" } });
    }

    let sourceId = existingSource?.id ?? null;
    if (!sourceId) {
      // A Source first seen here starts unapproved, so no fetch is scheduled until a Curator
      // approves it; the host row keeps any stricter policy already in D1.
      const policy = await sourcePolicyFor(db, snap.requestedUrl);
      if (!policy) return problemResponse(c, "validation_failed", "requestedUrl must be http(s)");
      sourceId = await registry.upsertSource(
        db,
        { url: snap.requestedUrl, kind: snap.sourceKind, host: hostOf(snap.requestedUrl) as string, hostPolicy: policy.policy, policySource: policy.policySource },
        t,
      );
    }
    const previous = await latestSnapshotOfSource(db, sourceId);
    // The Worker only recognizes identical content; the pipeline's classifier decides the rest.
    const changeClass = previous ? (previous.rawSha256 === snap.rawSha256 ? "none" : snap.mainTextSha256 && previous.mainTextSha256 === snap.mainTextSha256 ? "cosmetic" : null) : null;
    const snapshotId = await registry.recordSnapshot(
      db,
      {
        sourceId,
        fetchedAt,
        requestedUrl: snap.requestedUrl,
        finalUrl: snap.finalUrl,
        redirectChain: snap.redirectChain,
        httpStatus: snap.httpStatus,
        contentType: snap.contentType,
        rawSha256: snap.rawSha256,
        mainTextSha256: snap.mainTextSha256,
        normalizerVersion: snap.normalizerVersion,
        rawKey,
        textKey,
        changeClass,
        hostPolicy: decision.finalPolicy,
        aiInputAllowed: snap.aiInputAllowed,
      },
      t,
    );
    return c.json({ snapshotId, changeClass, stored: true }, 201);
  });

  app.post("/sources/upsert", auth("upsertSource"), async (c) => {
    const body = parseBody(c, SourceUpsertSchema);
    if (!body.ok) return body.res;
    const db = getDb(c.env.DB);
    const host = hostOf(body.data.url);
    const policy = await sourcePolicyFor(db, body.data.url);
    if (!host || !policy) return problemResponse(c, "validation_failed", "url must be http(s)");
    // Fetchable Sources only on allowed/api_only hosts; manual Sources on manual_only hosts; none
    // on link_only or never hosts (plan 2.3.7).
    if (!FETCHABLE_POLICIES.has(policy.policy) && policy.policy !== "manual_only") return unprocessable(c, "host policy forbids a source on this host");
    const existing = await getSourceByUrl(db, body.data.url);
    const sourceId = await registry.upsertSource(
      db,
      {
        url: body.data.url,
        kind: body.data.kind,
        host,
        hostPolicy: policy.policy,
        policySource: policy.policySource,
        // The repo's upsert overwrites links; a body that omits them must not unlink a Source.
        programId: body.data.programId ?? existing?.programId ?? null,
        organizationId: body.data.organizationId ?? existing?.organizationId ?? null,
        // No check time here: a Curator's approval schedules the first fetch.
        nextCheckAt: existing?.nextCheckAt ?? null,
      },
      now(),
    );
    return c.json({ sourceId, hostPolicy: policy.policy });
  });

  // ---- Phase 2 and not-yet-built routes -------------------------------------------------------

  app.post("/llm-calls", auth("llmCalls"), async (c) => {
    const body = parseBody(c, LlmCallRecordSchema);
    if (!body.ok) return body.res;
    if (!c.env.EVENTS_DB) return problemResponse(c, "unavailable", "events database not bound");
    const id = await events.recordLlmCall(getEventsDb(c.env.EVENTS_DB), body.data, now());
    return c.json({ id }, 201);
  });

  app.post("/curation-patches", auth("ingestCurationPatch"), async (c) => {
    const body = parseBody(c, CurationPatchSchema);
    if (!body.ok) return body.res;
    // Applying a patch needs organization upserts and Curator Ed25519 signature checks that the
    // repos and schema do not have yet; the body is validated so the CLI can be tested against it.
    return notImplemented(c, "curation patch apply is not available yet; the patch is valid");
  });

  app.post("/cycles/rollover", auth("cyclesRollover"), (c) => notImplemented(c, "cycle rollover lands in phase 2"));

  app.notFound((c) => problemResponse(c, "not_found"));
  app.onError((err, c) => {
    log("error", "internal.unhandled", { errorClass: err.name || "Error", path: new URL(c.req.url).pathname });
    return problemResponse(c, "internal");
  });

  return app;
}
