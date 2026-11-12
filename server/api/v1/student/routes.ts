import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import {
  AskRequestSchema,
  ConsentChangeSchema,
  CursorQuerySchema,
  EMPTY_STUDENT_PROFILE,
  IdSchema,
  ItemKeySchema,
  NotificationPrefsSchema,
  ReadinessExplainRequestSchema,
  RequirementProgressUpdateSchema,
  RoadmapItemActionSchema,
  StatementFeedbackRequestSchema,
  StudentProfileUpdateSchema,
  TrackerItemCreateSchema,
  TrackerItemUpdateSchema,
  type ApiErrorCode,
  type MeSessionResponse,
  type ReadinessResponse,
  type SessionUser as PublicSessionUser,
} from "@shared/contracts";
import { calendarTokenHash, newCalendarToken, userFeedPath } from "@server/cal/token";
import type { RepoResult } from "@server/db/repos/common";
import { sensitiveTagValues } from "@server/db/repos/students";
import { decodeCursor, encodeCursor } from "@server/db/util";
import type { AppEnv, Env, SessionUser } from "@server/env";
import { problemFor, type ProblemExtra } from "@server/lib/problem";
import type { WindowRule } from "@server/lib/rate-limit";
import { parseInput, queryToObject } from "@server/lib/validation";
import { byUser, rateLimit } from "@server/middleware/rate-limit";
import { ASK_MAX_CARDS, cardRefs, cardSources, programAskContext } from "./ask";
import type { StudentCtx, StudentDeps } from "./ports";
import { programSources, statesGpaRule, studentTimeZone } from "./readiness";
import { buildRoadmap, programIdFromItemKey } from "./roadmap";
import { loadBandedReadiness } from "./readiness-bands";

/**
 * Signed-in student routes, mounted at /api/v1 (shared/contracts/routes.ts, mount "student").
 *
 * Privacy by construction (rule 3):
 * - Every body is checked for status or identity keys before validation and refused with
 *   400 sensitive_field_rejected; the body is never parsed, stored or logged.
 * - The profile holds non-sensitive fields only (strict schema). Readiness evaluates eligibility
 *   on that profile, so status and identity rules come back "check privately on your device".
 * - Status-defined programs (sensitiveAudience) answer 404 on readiness and the assistant, so the
 *   server never computes anything that links a student to one.
 * - Responses never carry one composite score about a student (rule 4); readiness has four parts.
 *
 * Assistant routes are rate-limited per user here; the AI module adds the age gate, per-user daily
 * caps and monthly spend caps, and answers with deterministic text when no GEMINI_API_KEY is set.
 */

/** Burst limits per assistant route (judgment): a few questions a minute, a busy hour at most. */
export const DEFAULT_AI_RATE_RULES: readonly WindowRule[] = [
  { limit: 6, windowMs: 60_000 },
  { limit: 40, windowMs: 3_600_000 },
];

const EmptyBodySchema = z.object({}).strict();
const MAX_TZ_LENGTH = 64;

type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

function fail(c: StudentCtx, code: ApiErrorCode, extra: ProblemExtra = {}): Response {
  return problemFor(c, code, extra);
}

/** Maps an expected repository failure to its contract error. */
function fromRepo(c: StudentCtx, result: Extract<RepoResult<unknown>, { ok: false }>): Response {
  switch (result.error) {
    case "not_found":
      return fail(c, "not_found");
    case "version_conflict":
      return fail(c, "version_conflict");
    case "consent_required":
      return fail(c, "consent_required");
    case "invalid":
      // Repo details are field paths and fixed messages; a refused sensitive key keeps its code.
      return result.detail === "sensitive_field_rejected" ? fail(c, "sensitive_field_rejected") : fail(c, "validation_failed");
    case "already_applied":
    case "conflict":
      return fail(c, "conflict");
  }
}

/**
 * Reads a JSON body: sensitive keys are refused first, then the strict schema runs with fixed
 * error messages (server/lib/validation). `optional` treats a missing body as `{}`.
 */
async function readJson<S extends z.ZodTypeAny>(c: StudentCtx, schema: S, optional = false): Promise<Parsed<z.output<S>>> {
  let raw: unknown;
  const text = await c.req.text();
  if (text.trim() === "" && optional) raw = {};
  else {
    try {
      raw = JSON.parse(text);
    } catch {
      return { ok: false, response: fail(c, "bad_request", { detail: "Send a JSON body." }) };
    }
  }
  const outcome = parseInput(schema, raw);
  if (!outcome.ok) return { ok: false, response: fail(c, outcome.code, { errors: outcome.errors }) };
  return { ok: true, data: outcome.data };
}

function readParam<S extends z.ZodTypeAny>(c: StudentCtx, schema: S, value: string | undefined): Parsed<z.output<S>> {
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, response: fail(c, "not_found") };
}

/** 401 unless signed in; marks the response private (same contract as server/auth's requireUser). */
export const requireSignedIn: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user")) return problemFor(c, "unauthenticated");
  await next();
  try {
    c.res.headers.set("cache-control", "no-store");
  } catch {
    // An immutable response (a proxied asset) already carries its own policy.
  }
};

function currentUser(c: StudentCtx): SessionUser {
  const user = c.get("user");
  // requireStudent runs first on every route that calls this.
  if (!user) throw new Error("student route reached without a session");
  return user;
}

/** The strict public shape of the session user (the internal id never leaves the server). */
export function publicSessionUser(user: SessionUser): PublicSessionUser {
  return { publicId: user.publicId, email: user.email, displayName: user.displayName, roles: user.roles, onboarded: user.onboarded };
}

function browserZone(c: StudentCtx): string | null {
  const tz = c.req.query("tz");
  return tz && tz.length <= MAX_TZ_LENGTH ? tz : null;
}

export function createStudentRoutes(deps: StudentDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const signedIn = deps.requireStudent ?? requireSignedIn;
  const makeToken = deps.newCalendarToken ?? newCalendarToken;
  const methodologyUrl = (c: StudentCtx): string => `${deps.origin(c).replace(/\/$/, "")}/methods`;

  /** One limiter per assistant route, keyed by internal user id (never logged). */
  const aiLimit = (name: string): MiddlewareHandler<AppEnv> =>
    rateLimit({
      name: `ai_${name}`,
      key: byUser,
      rules: deps.aiRateRules ?? DEFAULT_AI_RATE_RULES,
      // Tests run without bindings, so the env object itself may be absent.
      binding: deps.aiRateBinding ?? ((env: Env | undefined) => env?.RATE_LIMIT_AI),
      now: deps.now,
    });

  // ---- Session and profile -----------------------------------------------------------------

  app.get("/me/session", async (c) => {
    const user = c.get("user");
    c.header("cache-control", "no-store");
    if (!user) return c.json({ user: null, profile: null } satisfies MeSessionResponse);
    const profile = (await deps.store(c).getProfile(user.id)) ?? EMPTY_STUDENT_PROFILE;
    return c.json({ user: publicSessionUser(user), profile } satisfies MeSessionResponse);
  });

  app.get("/me/profile", signedIn, async (c) => {
    const profile = await deps.store(c).getProfile(currentUser(c).id);
    return c.json(profile ?? EMPTY_STUDENT_PROFILE);
  });

  app.patch("/me/profile", signedIn, async (c) => {
    const body = await readJson(c, StudentProfileUpdateSchema);
    if (!body.ok) return body.response;
    // Keys were checked by readJson; free-text tag values can still state a status ("first gen").
    if (sensitiveTagValues(body.data.interestTags ?? []).length > 0) return fail(c, "sensitive_field_rejected");
    const result = await deps.store(c).updateProfile(currentUser(c).id, body.data, deps.now());
    return result.ok ? c.json(result.value) : fromRepo(c, result);
  });

  // ---- Account: deletion and data export --------------------------------------------------------

  /**
   * Deletes the account: hidden at once (users.deleted_at), every session and calendar feed
   * revoked in the same batch, and the daily `deletion.process` job purges the rows after the
   * undo window. The browser is told to drop its cookies.
   */
  app.delete("/me", signedIn, async (c) => {
    const body = await readJson(c, EmptyBodySchema, true);
    if (!body.ok) return body.response;
    await deps.store(c).deleteAccount(currentUser(c).id, deps.now());
    c.header("clear-site-data", '"cookies"');
    return c.body(null, 204);
  });

  /**
   * Data export needs an export job, an emailed single-use link and storage for the file, none of
   * which exist yet. Answering 503 keeps the promise honest: "queued" would claim work that never
   * runs. The route is mounted so clients get a clear problem instead of a bare 404.
   */
  app.post("/me/export", signedIn, async (c) => {
    const body = await readJson(c, EmptyBodySchema, true);
    if (!body.ok) return body.response;
    return fail(c, "unavailable", { detail: "Data export is not available yet. Email the Novus team to request a copy of your data." });
  });

  // ---- Tracker -------------------------------------------------------------------------------

  app.get("/me/tracker", signedIn, async (c) => c.json({ items: await deps.store(c).listTracker(currentUser(c).id) }));

  app.post("/me/tracker", signedIn, async (c) => {
    const body = await readJson(c, TrackerItemCreateSchema);
    if (!body.ok) return body.response;
    const result = await deps.store(c).addTracker(currentUser(c).id, body.data, deps.now());
    return result.ok ? c.json(result.value, 201) : fromRepo(c, result);
  });

  app.patch("/me/tracker/:id", signedIn, async (c) => {
    const id = readParam(c, IdSchema, c.req.param("id"));
    if (!id.ok) return id.response;
    const body = await readJson(c, TrackerItemUpdateSchema);
    if (!body.ok) return body.response;
    const result = await deps.store(c).updateTracker(currentUser(c).id, id.data, body.data, deps.now());
    return result.ok ? c.json(result.value) : fromRepo(c, result);
  });

  app.delete("/me/tracker/:id", signedIn, async (c) => {
    const id = readParam(c, IdSchema, c.req.param("id"));
    if (!id.ok) return id.response;
    const removed = await deps.store(c).removeTracker(currentUser(c).id, id.data, deps.now());
    return removed ? c.body(null, 204) : fail(c, "not_found");
  });

  // ---- Notification preferences, consents, calendar feed ------------------------------------

  app.get("/me/notification-prefs", signedIn, async (c) => c.json(await deps.store(c).getNotificationPrefs(currentUser(c).id)));

  app.put("/me/notification-prefs", signedIn, async (c) => {
    const body = await readJson(c, NotificationPrefsSchema);
    if (!body.ok) return body.response;
    const store = deps.store(c);
    const userId = currentUser(c).id;
    await store.saveNotificationPrefs(userId, body.data, deps.now());
    return c.json(await store.getNotificationPrefs(userId));
  });

  app.get("/me/consents", signedIn, async (c) => c.json({ items: await deps.store(c).listConsents(currentUser(c).id) }));

  app.post("/me/consents", signedIn, async (c) => {
    const body = await readJson(c, ConsentChangeSchema);
    if (!body.ok) return body.response;
    const store = deps.store(c);
    const userId = currentUser(c).id;
    const result = await store.changeConsent(userId, body.data, deps.now());
    if (!result.ok) return fromRepo(c, result);
    const matching = (await store.listConsents(userId)).filter((r) => r.kind === body.data.kind && r.programId === body.data.programId);
    const latest = matching.sort((a, b) => (a.grantedAt < b.grantedAt ? 1 : -1))[0];
    return latest ? c.json(latest) : fail(c, "not_found");
  });

  app.post("/me/calendar-feed/rotate", signedIn, async (c) => {
    const body = await readJson(c, EmptyBodySchema, true);
    if (!body.ok) return body.response;
    const token = makeToken();
    await deps.store(c).rotateCalendarFeed(currentUser(c).id, await calendarTokenHash(token), deps.now());
    // The token is shown once, inside the URL; only its hash is stored.
    return c.json({ url: `${deps.origin(c).replace(/\/$/, "")}${userFeedPath(token)}` });
  });

  // ---- Requirement progress and roadmap -------------------------------------------------------

  app.get("/me/requirement-progress", signedIn, async (c) =>
    c.json({ items: await deps.store(c).listRequirementProgress(currentUser(c).id) }),
  );

  app.put("/me/requirement-progress", signedIn, async (c) => {
    const body = await readJson(c, RequirementProgressUpdateSchema);
    if (!body.ok) return body.response;
    const result = await deps.store(c).setRequirementProgress(currentUser(c).id, body.data, deps.now());
    return result.ok ? c.json(result.value) : fromRepo(c, result);
  });

  app.get("/me/roadmap", signedIn, async (c) => {
    const store = deps.store(c);
    const userId = currentUser(c).id;
    const now = deps.now();
    const [profile, tracked, state] = await Promise.all([store.getProfile(userId), store.trackedCycles(userId), store.getRoadmapState(userId)]);
    const { roadmap, shownKeys } = buildRoadmap({
      tracked,
      actions: state.actions,
      lastShownItemKeys: state.lastShownItemKeys,
      templateKey: state.templateKey,
      planSteps: state.planSteps ?? [],
      profile: { institutionId: profile?.institutionId ?? null },
      now,
      timeZone: studentTimeZone(profile, browserZone(c)),
    });
    await store.saveRoadmapVisit(userId, shownKeys, state.templateKey, now);
    return c.json(roadmap);
  });

  app.patch("/me/roadmap/items/:itemKey", signedIn, async (c) => {
    const key = readParam(c, ItemKeySchema, c.req.param("itemKey"));
    if (!key.ok) return key.response;
    const body = await readJson(c, RoadmapItemActionSchema);
    if (!body.ok) return body.response;
    const result = await deps.store(c).recordRoadmapAction(currentUser(c).id, key.data, body.data.action, programIdFromItemKey(key.data), deps.now());
    return result.ok ? c.json({ itemKey: key.data, pinned: result.value.pinned, state: result.value.state }) : fromRepo(c, result);
  });

  // ---- Readiness -------------------------------------------------------------------------------

  app.get("/me/readiness/:programCycleId", signedIn, async (c) => {
    const id = readParam(c, IdSchema, c.req.param("programCycleId"));
    if (!id.ok) return id.response;
    const loaded = await loadBandedReadiness(deps.store(c), deps.bands?.(c), currentUser(c).id, id.data, {
      now: deps.now(),
      browserTimeZone: browserZone(c),
      methodologyUrl: methodologyUrl(c),
    });
    if (!loaded) return fail(c, "not_found");
    return c.json({ report: loaded.detail.report } satisfies ReadinessResponse);
  });

  // ---- Inbox -----------------------------------------------------------------------------------

  app.get("/me/activity", signedIn, async (c) => {
    const query = parseInput(CursorQuerySchema, queryToObject(new URL(c.req.url).searchParams));
    if (!query.ok) return fail(c, query.code, { errors: query.errors });
    const cursor = query.data.cursor ? decodeCursor(query.data.cursor) : null;
    if (query.data.cursor && (!cursor || typeof cursor.k !== "number")) return fail(c, "bad_request", { detail: "Invalid cursor." });
    const before = cursor && typeof cursor.k === "number" ? { createdAt: cursor.k, id: cursor.id } : null;
    const items = await deps.store(c).listInbox(currentUser(c).id, deps.now(), { limit: query.data.limit, before });
    const last = items[items.length - 1];
    const nextCursor = items.length === query.data.limit && last ? encodeCursor({ k: Date.parse(last.createdAt), id: last.id }) : null;
    return c.json({ items, page: { nextCursor, limit: query.data.limit } });
  });

  app.post("/me/activity/:id/read", signedIn, async (c) => {
    const id = readParam(c, IdSchema, c.req.param("id"));
    if (!id.ok) return id.response;
    const body = await readJson(c, EmptyBodySchema, true);
    if (!body.ok) return body.response;
    // Idempotent and uninformative: another student's alert id and an already-read one look alike.
    await deps.store(c).markInboxRead(currentUser(c).id, id.data, deps.now());
    return c.body(null, 204);
  });

  // ---- Assistant (Gemini through server/ai) -----------------------------------------------------

  app.post("/me/readiness/:programCycleId/explain", signedIn, aiLimit("readiness_explain"), async (c) => {
    const id = readParam(c, IdSchema, c.req.param("programCycleId"));
    if (!id.ok) return id.response;
    const body = await readJson(c, ReadinessExplainRequestSchema, true);
    if (!body.ok) return body.response;
    const user = currentUser(c);
    const loaded = await loadBandedReadiness(deps.store(c), deps.bands?.(c), user.id, id.data, {
      now: deps.now(),
      browserTimeZone: browserZone(c),
      methodologyUrl: methodologyUrl(c),
    });
    if (!loaded) return fail(c, "not_found");
    const res = await deps.ai(c).explainReadiness({
      viewer: { userId: user.id, birthYearMonth: loaded.profile.birthYearMonth },
      report: loaded.detail.report,
      profile: loaded.profile,
      request: body.data,
      programSources: programSources(loaded.source, deps.origin(c)).slice(0, 8),
      programName: loaded.source.program.name,
      includeGpaBand: statesGpaRule(loaded.source),
    });
    return c.json(res);
  });

  app.post("/me/statement-feedback", signedIn, aiLimit("statement_feedback"), async (c) => {
    const body = await readJson(c, StatementFeedbackRequestSchema);
    if (!body.ok) return body.response;
    const store = deps.store(c);
    const user = currentUser(c);
    let sources: ReturnType<typeof programSources> = [];
    if (body.data.programCycleId) {
      const source = await store.readinessSource(body.data.programCycleId);
      if (!source || source.program.sensitiveAudience) return fail(c, "not_found");
      sources = programSources(source, deps.origin(c), { essayOnly: true });
    }
    const profile = await store.getProfile(user.id);
    const res = await deps.ai(c).statementFeedback({
      viewer: { userId: user.id, birthYearMonth: profile?.birthYearMonth ?? null },
      request: body.data,
      programSources: sources,
    });
    return c.json(res);
  });

  app.post("/me/ask", signedIn, aiLimit("ask"), async (c) => {
    const body = await readJson(c, AskRequestSchema);
    if (!body.ok) return body.response;
    const store = deps.store(c);
    const user = currentUser(c);
    const origin = deps.origin(c);
    let context: ReturnType<typeof programAskContext>;
    if (body.data.programSlug) {
      const source = await store.readinessSourceBySlug(body.data.programSlug);
      // Same rule as readiness and explain: a question tied to a status-defined program would
      // link this student to that status, so the server never processes it.
      if (!source || source.program.sensitiveAudience) return fail(c, "not_found");
      context = programAskContext(source, origin);
    } else {
      // Over-fetch, then drop status-defined programs so they never enter a signed-in prompt.
      const found = await store.searchCards(body.data.question, deps.now(), ASK_MAX_CARDS * 2);
      const cards = found.filter((card) => !card.flags.sensitiveAudience).slice(0, ASK_MAX_CARDS);
      context = { sources: cardSources(cards, origin), programRefs: cardRefs(cards) };
    }
    const profile = await store.getProfile(user.id);
    const res = await deps.ai(c).ask({
      viewer: { userId: user.id, birthYearMonth: profile?.birthYearMonth ?? null },
      request: body.data,
      sources: context.sources,
      programRefs: context.programRefs,
    });
    return c.json(res);
  });

  return app;
}
