import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  AskResponseSchema,
  ConsentRecordSchema,
  FORBIDDEN_STUDENT_SCORE_FIELDS,
  MeSessionResponseSchema,
  NotificationPrefsSchema,
  ProblemDetailsSchema,
  ReadinessExplainResponseSchema,
  ReadinessResponseSchema,
  RoadmapSchema,
  StatementFeedbackResponseSchema,
  StudentProfileSchema,
  TrackerItemSchema,
  type InboxItem,
} from "@shared/contracts";
import { applyItemKey } from "@shared/readiness";
import { createAi, createMockProvider, MemoryLedger, type MockStep } from "@server/ai";
import type { WindowRule } from "@server/lib/rate-limit";
import type { AppEnv, SessionUser } from "@server/env";
import { createStudentRoutes } from "./routes";
import {
  MemoryStudentStore,
  SAMPLE_CYCLE_ID,
  SAMPLE_GPA_CYCLE_ID,
  SAMPLE_INSTITUTION,
  SAMPLE_PROGRAM_ID,
  SAMPLE_SENSITIVE_CYCLE_ID,
  SAMPLE_SENSITIVE_SOURCE,
  SAMPLE_SOURCE,
  sampleId,
} from "./testing";

const NOW = Date.parse("2026-11-11T16:00:00Z");
const ORIGIN = "https://novus.example.org";
const CALENDAR_TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const ADULT = "2000-03";
const MINOR = "2010-05";

function user(id: string): SessionUser {
  return {
    id,
    publicId: `Pub${id.replace(/[^A-Za-z0-9]/g, "")}`.padEnd(20, "0").slice(0, 32),
    email: `${id}@example.org`,
    displayName: null,
    roles: ["student"],
    onboarded: true,
    grants: [{ role: "student", scope: { kind: "global" } }],
    sessionId: `sess-${id}`,
    sessionExpiresAt: NOW + 86_400_000,
    surface: "app",
    secondFactor: { enrolled: false, verified: false },
  };
}

interface SetupOptions {
  readonly steps?: MockStep[];
  readonly noKey?: boolean;
  readonly rules?: readonly WindowRule[];
  readonly store?: MemoryStudentStore;
}

function setup(opts: SetupOptions = {}) {
  const store = opts.store ?? new MemoryStudentStore({ participation: [`${SAMPLE_PROGRAM_ID}|${SAMPLE_INSTITUTION.id}`] });
  const provider = createMockProvider(opts.steps ?? []);
  const clock = { now: () => NOW };
  const ai = opts.noKey
    ? createAi({}, { clock, log: () => {} })
    : createAi({ GEMINI_API_KEY: "placeholder" }, { provider, ledger: new MemoryLedger(), clock, nonce: () => "n0nce0000000000000000000", log: () => {} });
  const app = new Hono<AppEnv>();
  // Stand-in for server/auth's sessionMiddleware: a bearer token names the test user.
  app.use("*", async (c, next) => {
    const token = c.req.header("authorization")?.replace("Bearer ", "");
    if (token) c.set("user", user(token));
    c.set("requestId", "req-test");
    await next();
  });
  app.route(
    "/api/v1",
    createStudentRoutes({
      store: () => store,
      ai: () => ai,
      now: () => NOW,
      origin: () => ORIGIN,
      aiRateRules: opts.rules,
      newCalendarToken: () => CALENDAR_TOKEN,
    }),
  );
  const call = (method: string, path: string, who: string | null, body?: unknown) =>
    app.request(`/api/v1${path}`, {
      method,
      headers: { ...(who ? { authorization: `Bearer ${who}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  return { app, store, provider, call };
}

async function problem(res: Response) {
  const body = await res.json();
  expect(ProblemDetailsSchema.safeParse(body).success).toBe(true);
  return body as { code: string; errors?: { path: string; message: string }[] };
}

/** Every object key in a JSON value (to prove no score-like field reaches a student). */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

describe("authentication", () => {
  it("answers 401 on every student route without a session", async () => {
    const { call } = setup();
    for (const [method, path] of [
      ["GET", "/me/profile"],
      ["PATCH", "/me/profile"],
      ["GET", "/me/tracker"],
      ["GET", `/me/readiness/${SAMPLE_CYCLE_ID}`],
      ["POST", `/me/readiness/${SAMPLE_CYCLE_ID}/explain`],
      ["POST", "/me/statement-feedback"],
      ["POST", "/me/ask"],
      ["GET", "/me/roadmap"],
      ["GET", "/me/notification-prefs"],
      ["DELETE", "/me"],
      ["POST", "/me/export"],
    ] as const) {
      const res = await call(method, path, null, method === "GET" ? undefined : {});
      expect(res.status, `${method} ${path}`).toBe(401);
      expect((await problem(res)).code).toBe("unauthenticated");
    }
  });

  it("serves /me/session to anyone, with the public user shape only", async () => {
    const { call } = setup();
    const anon = await call("GET", "/me/session", null);
    expect(await anon.json()).toEqual({ user: null, profile: null });

    const res = await call("GET", "/me/session", "u1");
    const body = await res.json();
    expect(MeSessionResponseSchema.safeParse(body).success).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sess-u1");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("marks signed-in responses no-store", async () => {
    const { call } = setup();
    const res = await call("GET", "/me/profile", "u1");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("privacy: sensitive keys are refused before anything runs", () => {
  it("rejects a profile update carrying a status key with 400 and never stores or echoes it", async () => {
    const { call, store } = setup();
    const res = await call("PATCH", "/me/profile", "u1", { classYear: "first_year", citizenship: "daca_recipient" });
    expect(res.status).toBe(400);
    const body = await problem(res);
    expect(body.code).toBe("sensitive_field_rejected");
    expect(JSON.stringify(body)).not.toContain("daca_recipient");
    expect(store.calls).not.toContain("updateProfile");
    expect(store.profiles.get("u1")).toBeUndefined();
  });

  it("rejects nested and identity keys on every body-taking route", async () => {
    const { call, store, provider } = setup();
    const attempts: [string, string, unknown][] = [
      ["PATCH", "/me/profile", { interestTags: ["robotics"], identity: { gender: "x" } }],
      ["POST", "/me/tracker", { programCycleId: SAMPLE_CYCLE_ID, firstGeneration: true }],
      ["POST", "/me/ask", { question: "When does it close?", programSlug: null, pell: "yes" }],
      ["POST", "/me/statement-feedback", { statement: "x".repeat(80), householdIncome: 1 }],
      ["POST", `/me/readiness/${SAMPLE_CYCLE_ID}/explain`, { focus: "overview", sensitiveAnswers: { citizenship: "us_citizen" } }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(method, path, "u1", body);
      expect(res.status, path).toBe(400);
      expect((await problem(res)).code, path).toBe("sensitive_field_rejected");
    }
    expect(store.calls).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it("rejects interest tags whose values state a status or identity, without storing or echoing them", async () => {
    const { call, store } = setup();
    for (const tags of [["robotics", "DACA recipient"], ["first gen"], ["pell grant"]]) {
      const res = await call("PATCH", "/me/profile", "u1", { classYear: "first_year", interestTags: tags });
      expect(res.status, tags.join(",")).toBe(400);
      const body = await problem(res);
      expect(body.code).toBe("sensitive_field_rejected");
      for (const t of tags) expect(JSON.stringify(body)).not.toContain(t);
    }
    expect(store.calls).not.toContain("updateProfile");
    expect(store.profiles.get("u1")).toBeUndefined();
  });

  it("rejects unknown non-sensitive keys as validation_failed (strict schemas)", async () => {
    const { call } = setup();
    const res = await call("PATCH", "/me/profile", "u1", { classYear: "first_year", favouriteColour: "green" });
    expect(res.status).toBe(400);
    const body = await problem(res);
    expect(body.code).toBe("validation_failed");
    expect(JSON.stringify(body)).not.toContain("green");
  });

  it("answers bad_request for a body that is not JSON", async () => {
    const { call } = setup();
    const res = await call("PATCH", "/me/profile", "u1", "{not json");
    expect((await problem(res)).code).toBe("bad_request");
  });
});

describe("profile", () => {
  it("returns the empty profile, applies a partial update and reads it back", async () => {
    const { call } = setup();
    const empty = await (await call("GET", "/me/profile", "u1")).json();
    expect(StudentProfileSchema.parse(empty).classYear).toBeNull();

    const res = await call("PATCH", "/me/profile", "u1", { classYear: "second_year", weeklyPrepHours: 6, interestTags: ["ecology"] });
    expect(res.status).toBe(200);
    const updated = StudentProfileSchema.parse(await res.json());
    expect(updated).toMatchObject({ classYear: "second_year", weeklyPrepHours: 6, interestTags: ["ecology"] });
    expect(StudentProfileSchema.parse(await (await call("GET", "/me/profile", "u1")).json())).toEqual(updated);
    // Another student sees nothing of it.
    expect(StudentProfileSchema.parse(await (await call("GET", "/me/profile", "u2")).json()).classYear).toBeNull();
  });
});

describe("account deletion and data export", () => {
  it("soft-deletes the signed-in account, asks the browser to drop cookies and answers 204", async () => {
    const { call, store } = setup();
    await call("POST", "/me/calendar-feed/rotate", "u1", {});
    const res = await call("DELETE", "/me", "u1");
    expect(res.status).toBe(204);
    expect(res.headers.get("clear-site-data")).toBe('"cookies"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(store.deleted.get("u1")).toBe(NOW);
    expect(store.feeds.get("u1")).toBeUndefined();
    expect(store.deleted.has("u2")).toBe(false);
  });

  it("refuses a deletion body with a status key or unknown fields", async () => {
    const { call, store } = setup();
    expect((await problem(await call("DELETE", "/me", "u1", { citizenship: "x" }))).code).toBe("sensitive_field_rejected");
    expect((await problem(await call("DELETE", "/me", "u1", { reason: "x" }))).code).toBe("validation_failed");
    expect(store.calls).not.toContain("deleteAccount");
  });

  it("answers export requests with 503 unavailable instead of claiming a queued job", async () => {
    const { call } = setup();
    const res = await call("POST", "/me/export", "u1", {});
    expect(res.status).toBe(503);
    expect((await problem(res)).code).toBe("unavailable");
  });
});

describe("tracker", () => {
  it("adds, lists, updates with optimistic versions and removes", async () => {
    const { call } = setup();
    const created = await call("POST", "/me/tracker", "u1", { programCycleId: SAMPLE_CYCLE_ID });
    expect(created.status).toBe(201);
    const item = TrackerItemSchema.parse(await created.json());
    expect(item).toMatchObject({ status: "interested", version: 1, programSlug: "sample-stem-research-award" });

    const list = await (await call("GET", "/me/tracker", "u1")).json();
    expect(list.items).toHaveLength(1);

    const patched = await call("PATCH", `/me/tracker/${item.id}`, "u1", { status: "applying", ownCampusDeadline: "2026-12-01", version: 1 });
    expect(patched.status).toBe(200);
    expect(TrackerItemSchema.parse(await patched.json())).toMatchObject({ status: "applying", version: 2 });

    const stale = await call("PATCH", `/me/tracker/${item.id}`, "u1", { status: "submitted", version: 1 });
    expect(stale.status).toBe(409);
    expect((await problem(stale)).code).toBe("version_conflict");

    expect((await call("DELETE", `/me/tracker/${item.id}`, "u2")).status).toBe(404);
    expect((await call("DELETE", `/me/tracker/${item.id}`, "u1")).status).toBe(204);
    expect((await call("DELETE", `/me/tracker/${item.id}`, "u1")).status).toBe(404);
  });

  it("answers 404 for an unknown cycle or a malformed id", async () => {
    const { call } = setup();
    expect((await call("POST", "/me/tracker", "u1", { programCycleId: sampleId(999) })).status).toBe(404);
    expect((await call("PATCH", "/me/tracker/not-a-uuid", "u1", { version: 1 })).status).toBe(404);
  });

  it("requires consent before tracking a status-defined program, then allows it", async () => {
    const { call } = setup();
    const refused = await call("POST", "/me/tracker", "u1", { programCycleId: SAMPLE_SENSITIVE_CYCLE_ID });
    expect(refused.status).toBe(409);
    expect((await problem(refused)).code).toBe("consent_required");

    const consent = await call("POST", "/me/consents", "u1", {
      kind: "sensitive_tracking",
      textVersion: "2026-11",
      programId: sampleId(303),
      granted: true,
    });
    expect(consent.status).toBe(200);
    expect(ConsentRecordSchema.parse(await consent.json())).toMatchObject({ kind: "sensitive_tracking", revokedAt: null });
    expect((await call("POST", "/me/tracker", "u1", { programCycleId: SAMPLE_SENSITIVE_CYCLE_ID })).status).toBe(201);
    expect((await (await call("GET", "/me/consents", "u1")).json()).items).toHaveLength(1);
  });
});

describe("notification preferences, progress, calendar and inbox", () => {
  it("returns defaults and replaces preferences", async () => {
    const { call } = setup();
    const defaults = NotificationPrefsSchema.parse(await (await call("GET", "/me/notification-prefs", "u1")).json());
    const next = { ...defaults, weeklyEmail: false, weeklyDay: 2, channels: { email: false, inApp: true, push: false } };
    const res = await call("PUT", "/me/notification-prefs", "u1", next);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(next);
    expect((await call("PUT", "/me/notification-prefs", "u1", { ...next, quietHoursStart: "late" })).status).toBe(400);
  });

  it("records requirement progress", async () => {
    const { call } = setup();
    const res = await call("PUT", "/me/requirement-progress", "u1", { subjectKey: "kind:resume", state: "met" });
    expect(res.status).toBe(200);
    const list = await (await call("GET", "/me/requirement-progress", "u1")).json();
    expect(list.items).toEqual([{ subjectKey: "kind:resume", state: "met", updatedAt: new Date(NOW).toISOString() }]);
  });

  it("rotates the private calendar URL and stores only a hash", async () => {
    const { call, store } = setup();
    const res = await call("POST", "/me/calendar-feed/rotate", "u1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: `${ORIGIN}/cal/u/${CALENDAR_TOKEN}.ics` });
    const stored = store.feeds.get("u1") ?? [];
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain(CALENDAR_TOKEN);
    expect(stored[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pages the inbox newest first and marks items read idempotently", async () => {
    const store = new MemoryStudentStore();
    const items: InboxItem[] = [1, 2, 3].map((n) => ({
      id: sampleId(700 + n),
      type: "deadline_changed",
      priority: "p1",
      title: `Sample alert ${n}`,
      body: "Sample text.",
      href: null,
      readAt: null,
      createdAt: new Date(NOW - n * 60_000).toISOString(),
    })) as InboxItem[];
    store.inbox.set("u1", items);
    const { call } = setup({ store });
    const first = await (await call("GET", "/me/activity?limit=2", "u1")).json();
    expect(first.items.map((i: InboxItem) => i.title)).toEqual(["Sample alert 1", "Sample alert 2"]);
    expect(first.page.nextCursor).toEqual(expect.any(String));
    const second = await (await call("GET", `/me/activity?limit=2&cursor=${first.page.nextCursor}`, "u1")).json();
    expect(second.items.map((i: InboxItem) => i.title)).toEqual(["Sample alert 3"]);
    expect(second.page.nextCursor).toBeNull();
    expect((await call("GET", "/me/activity?cursor=garbage", "u1")).status).toBe(400);

    expect((await call("POST", `/me/activity/${sampleId(701)}/read`, "u1")).status).toBe(204);
    expect((await call("POST", `/me/activity/${sampleId(701)}/read`, "u1")).status).toBe(204);
    expect(store.inbox.get("u1")?.[0]?.readAt).not.toBeNull();
  });
});

describe("readiness", () => {
  it("returns exactly four parts, with status rules marked 'check privately'", async () => {
    const { call } = setup();
    await call("PATCH", "/me/profile", "u1", { classYear: "second_year", enrollmentIntensity: "full_time", institutionId: SAMPLE_INSTITUTION.id });
    const res = await call("GET", `/me/readiness/${SAMPLE_CYCLE_ID}`, "u1");
    expect(res.status).toBe(200);
    const body = ReadinessResponseSchema.parse(await res.json());
    const { report } = body;
    expect(Object.keys(report).sort()).toEqual(
      ["algoVersion", "competitiveness", "cycleKey", "eligibility", "generatedAt", "nextActions", "programCycleId", "programSlug", "requirements"].sort(),
    );

    const citizenship = report.eligibility.rules.find((r) => r.ruleId === "citizenship");
    expect(citizenship).toMatchObject({ sensitive: true, verdict: "unknown", reasonCode: "SENSITIVE_ON_DEVICE", resolver: "student" });
    expect(citizenship?.reason).toMatch(/^Check this rule yourself on your device/);
    expect(report.eligibility.pending.some((p) => p.sensitive && p.resolver === "student")).toBe(true);
    expect(report.eligibility.sensitiveEvaluated).toBe(false);
    expect(report.eligibility.status).not.toBe("eligible");

    // Non-sensitive rules use the stored profile.
    expect(report.eligibility.rules.find((r) => r.ruleId === "enrollment")?.verdict).toBe("met");
    // Participation listed for the student's campus.
    expect(report.eligibility.rules.find((r) => r.ruleId === "institution")?.verdict).toBe("met");

    expect(report.requirements.items.map((i) => i.kind).sort()).toEqual(["campus_nomination", "essay", "recommendation"]);
    expect(report.competitiveness.band).toBeNull();
    const keys = allKeys(body);
    for (const forbidden of FORBIDDEN_STUDENT_SCORE_FIELDS) expect(keys.has(forbidden), forbidden).toBe(false);
  });

  it("uses the private campus date from the tracker and the student's progress", async () => {
    const { call } = setup();
    const created = TrackerItemSchema.parse(await (await call("POST", "/me/tracker", "u1", { programCycleId: SAMPLE_CYCLE_ID })).json());
    await call("PATCH", `/me/tracker/${created.id}`, "u1", { ownCampusDeadline: "2026-12-04", version: 1 });
    await call("PUT", "/me/requirement-progress", "u1", { subjectKey: `req:${sampleId(501)}`, state: "met" });
    const { report } = ReadinessResponseSchema.parse(await (await call("GET", `/me/readiness/${SAMPLE_CYCLE_ID}`, "u1")).json());
    expect(report.requirements.effectiveDeadline).toMatchObject({ date: "2026-12-04", basis: "student_entered", scope: "campus" });
    expect(report.requirements.items.find((i) => i.requirementId === sampleId(501))?.state).toBe("met");
  });

  it("answers 404 for status-defined programs, unknown cycles and malformed ids", async () => {
    const { call, store } = setup();
    expect((await call("GET", `/me/readiness/${SAMPLE_SENSITIVE_CYCLE_ID}`, "u1")).status).toBe(404);
    expect((await call("GET", `/me/readiness/${sampleId(998)}`, "u1")).status).toBe(404);
    expect((await call("GET", "/me/readiness/nope", "u1")).status).toBe(404);
    // A status-defined program never loads the student's records.
    expect(store.calls.filter((c) => c === "getProfile")).toHaveLength(0);
  });
});

describe("roadmap", () => {
  it("builds Apply items from tracked cycles, reports changes once and stores pins", async () => {
    const { call } = setup();
    await call("POST", "/me/tracker", "u1", { programCycleId: SAMPLE_CYCLE_ID });
    await call("POST", "/me/tracker", "u1", { programCycleId: SAMPLE_GPA_CYCLE_ID });

    const first = RoadmapSchema.parse(await (await call("GET", "/me/roadmap", "u1")).json());
    const applyKey = applyItemKey(SAMPLE_PROGRAM_ID, "ay-2026-27");
    const items = first.terms.flatMap((t) => t.apply);
    expect(items.map((i) => i.itemKey)).toContain(applyKey);
    // Nomination-gated with no known campus date: the item is due on the estimated campus
    // deadline, the same date readiness counts back from, not the national one.
    const apply = items.find((i) => i.itemKey === applyKey);
    expect(apply).toMatchObject({ state: "open", kind: "apply", source: "student", dateConfidence: "estimated" });
    expect(apply?.dueOn && apply.dueOn < "2027-01-29").toBe(true);
    expect(apply?.reasonCodes).toEqual(expect.arrayContaining(["tracked", "sample_record", "campus_deadline"]));
    const readiness = ReadinessResponseSchema.parse(await (await call("GET", `/me/readiness/${SAMPLE_CYCLE_ID}`, "u1")).json());
    expect(readiness.report.requirements.effectiveDeadline?.date).toBe(apply?.dueOn);
    expect(first.changedSinceLastVisit).toContain(applyKey);

    const second = RoadmapSchema.parse(await (await call("GET", "/me/roadmap", "u1")).json());
    expect(second.changedSinceLastVisit).toEqual([]);

    const pin = await call("PATCH", `/me/roadmap/items/${encodeURIComponent(applyKey)}`, "u1", { action: "pin" });
    expect(pin.status).toBe(200);
    expect(await pin.json()).toEqual({ itemKey: applyKey, pinned: true, state: "open" });
    const done = await call("PATCH", `/me/roadmap/items/${encodeURIComponent(applyKey)}`, "u1", { action: "complete" });
    expect(await done.json()).toMatchObject({ state: "done" });
    const third = RoadmapSchema.parse(await (await call("GET", "/me/roadmap", "u1")).json());
    expect(third.terms.flatMap((t) => t.apply).find((i) => i.itemKey === applyKey)).toMatchObject({ pinned: true, state: "done" });

    expect((await call("PATCH", "/me/roadmap/items/bogus", "u1", { action: "pin" })).status).toBe(404);
    expect((await call("PATCH", `/me/roadmap/items/${encodeURIComponent(applyKey)}`, "u1", { action: "explode" })).status).toBe(400);
  });
});

const explainOutput = {
  summary: "Your checklist has three items and one rule you check privately.",
  points: [
    { part: "eligibility", text: "One rule about status is checked only on your device.", sourceIds: ["s1"] },
    { part: "requirements", text: "The research essay is the longest item.", sourceIds: ["s1", "s3"] },
  ],
  suggestions: [],
  caveats: [],
};

describe("assistant: readiness explanation", () => {
  it("degrades to a clear deterministic explanation without GEMINI_API_KEY", async () => {
    const { call } = setup({ noKey: true });
    await call("PATCH", "/me/profile", "u1", { birthYearMonth: ADULT });
    const res = await call("POST", `/me/readiness/${SAMPLE_CYCLE_ID}/explain`, "u1");
    expect(res.status).toBe(200);
    const body = ReadinessExplainResponseSchema.parse(await res.json());
    expect(body.meta).toMatchObject({ status: "unavailable", degradedReason: "no_api_key", fallback: true, provider: "none" });
    expect(body.programCycleId).toBe(SAMPLE_CYCLE_ID);
    expect(body.summary.length).toBeGreaterThan(0);
  });

  it("calls the model for an adult with sources and no personal identifiers", async () => {
    const { call, provider } = setup({ steps: [{ json: explainOutput }] });
    await call("PATCH", "/me/profile", "u1", { birthYearMonth: ADULT, classYear: "second_year" });
    const res = await call("POST", `/me/readiness/${SAMPLE_CYCLE_ID}/explain`, "u1", { focus: "overview", question: null });
    const body = ReadinessExplainResponseSchema.parse(await res.json());
    expect(body.meta).toMatchObject({ status: "ok", fallback: false });
    expect(provider.calls).toHaveLength(1);
    const sent = JSON.stringify(provider.calls[0]);
    expect(sent).toContain("describe a research question");
    expect(sent).toContain("SAMPLE RECORD");
    expect(sent).not.toContain("u1@example.org");
    expect(sent).not.toContain(ADULT);
  });

  it("never calls the model for a student under 18 or of unknown age", async () => {
    const { call, provider } = setup({ steps: [{ json: explainOutput }] });
    await call("PATCH", "/me/profile", "minor", { birthYearMonth: MINOR });
    const minor = ReadinessExplainResponseSchema.parse(await (await call("POST", `/me/readiness/${SAMPLE_CYCLE_ID}/explain`, "minor")).json());
    const unknown = ReadinessExplainResponseSchema.parse(await (await call("POST", `/me/readiness/${SAMPLE_CYCLE_ID}/explain`, "nobirth")).json());
    expect(minor.meta.fallback).toBe(true);
    expect(unknown.meta.fallback).toBe(true);
    expect(provider.calls).toHaveLength(0);
  });

  it("answers 404 for a status-defined program without calling the model", async () => {
    const { call, provider } = setup({ steps: [{ json: explainOutput }] });
    const res = await call("POST", `/me/readiness/${SAMPLE_SENSITIVE_CYCLE_ID}/explain`, "u1");
    expect(res.status).toBe(404);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("assistant: statement feedback and Ask Novus", () => {
  const statement =
    "In my first-year lab course I designed a small experiment on soil moisture, wrote the protocol myself, and presented the results to my class.";

  it("degrades without a key and still returns deterministic facts", async () => {
    const { call } = setup({ noKey: true });
    const res = await call("POST", "/me/statement-feedback", "u1", { statement, wordLimit: 10 });
    const body = StatementFeedbackResponseSchema.parse(await res.json());
    expect(body.meta.status).toBe("unavailable");
    expect(body.overLimit).toBe(true);
  });

  it("sends the program's essay prompt as a source", async () => {
    const { call, provider } = setup({
      steps: [
        {
          json: {
            overall: "Clear and specific about what you did.",
            strengths: [{ aspect: "specificity", comment: "Names a concrete experiment.", excerpt: "designed a small experiment on soil moisture" }],
            improvements: [],
            promptCoverage: [],
            sourceIds: ["s1"],
          },
        },
      ],
    });
    await call("PATCH", "/me/profile", "u1", { birthYearMonth: ADULT });
    const res = await call("POST", "/me/statement-feedback", "u1", { statement, programCycleId: SAMPLE_CYCLE_ID });
    const body = StatementFeedbackResponseSchema.parse(await res.json());
    expect(body.meta.status).toBe("ok");
    expect(JSON.stringify(provider.calls[0])).toContain("describe a research question");
    expect((await call("POST", "/me/statement-feedback", "u1", { statement, programCycleId: SAMPLE_SENSITIVE_CYCLE_ID })).status).toBe(404);
  });

  it("answers a question about a named program from its record", async () => {
    const { call, provider } = setup({
      steps: [{ json: { answer: "It needs a research essay and two letters.", answerType: "answered", sourceIds: ["s1"], followUps: [] } }],
    });
    await call("PATCH", "/me/profile", "u1", { birthYearMonth: ADULT });
    const res = await call("POST", "/me/ask", "u1", { question: "What do I need to submit?", programSlug: SAMPLE_SOURCE.program.slug });
    const body = AskResponseSchema.parse(await res.json());
    expect(body.answerType).toBe("answered");
    expect(body.programRefs).toEqual([{ slug: "sample-stem-research-award", name: "Sample STEM Research Award" }]);
    expect(provider.calls).toHaveLength(1);
    expect((await call("POST", "/me/ask", "u1", { question: "What is due?", programSlug: "sample-missing" })).status).toBe(404);
  });

  it("answers 404 to a question about a status-defined program without calling the model", async () => {
    const { call, store, provider } = setup({
      steps: [{ json: { answer: "Sample answer.", answerType: "answered", sourceIds: ["s1"], followUps: [] } }],
    });
    await call("PATCH", "/me/profile", "u1", { birthYearMonth: ADULT });
    const res = await call("POST", "/me/ask", "u1", { question: "What is due?", programSlug: SAMPLE_SENSITIVE_SOURCE.program.slug });
    expect(res.status).toBe(404);
    expect((await problem(res)).code).toBe("not_found");
    expect(provider.calls).toHaveLength(0);
    expect(store.calls).not.toContain("searchCards");
  });

  it("drops status-defined programs from open-question retrieval", async () => {
    const { call, provider } = setup({
      steps: [{ json: { answer: "Sample answer.", answerType: "answered", sourceIds: ["s1"], followUps: [] } }],
    });
    await call("PATCH", "/me/profile", "u1", { birthYearMonth: ADULT });
    // "program" matches every sample name, including the status-defined one.
    const res = await call("POST", "/me/ask", "u1", { question: "Which sample program should I look at?" });
    expect(res.status).toBe(200);
    const body = AskResponseSchema.parse(await res.json());
    expect(body.programRefs.map((r) => r.slug)).not.toContain(SAMPLE_SENSITIVE_SOURCE.program.slug);
    expect(JSON.stringify(provider.calls)).not.toContain("Status-Defined");
  });

  it("retrieves cards for an open question and declines status questions without a model call", async () => {
    const { call, store, provider } = setup({ noKey: true });
    const open = AskResponseSchema.parse(await (await call("POST", "/me/ask", "u1", { question: "Tell me about the summer lab program" })).json());
    expect(store.calls).toContain("searchCards");
    expect(open.meta.status).toBe("unavailable");

    const { call: call2, provider: p2 } = setup({ steps: [] });
    await call2("PATCH", "/me/profile", "u1", { birthYearMonth: ADULT });
    const declined = AskResponseSchema.parse(await (await call2("POST", "/me/ask", "u1", { question: "Can I apply if I am undocumented?" })).json());
    expect(declined.answerType).toBe("declined_sensitive");
    expect(p2.calls).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("rate-limits each assistant route per user with 429 and Retry-After", async () => {
    const { call } = setup({ noKey: true, rules: [{ limit: 2, windowMs: 60_000 }] });
    for (let i = 0; i < 2; i++) expect((await call("POST", "/me/ask", "u1", { question: "What is open now?" })).status).toBe(200);
    const limited = await call("POST", "/me/ask", "u1", { question: "What is open now?" });
    expect(limited.status).toBe(429);
    expect((await problem(limited)).code).toBe("rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another student and another route have their own budgets.
    expect((await call("POST", "/me/ask", "u2", { question: "What is open now?" })).status).toBe(200);
    expect((await call("POST", "/me/statement-feedback", "u1", { statement })).status).toBe(200);
  });
});
