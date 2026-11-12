import type { Context, MiddlewareHandler } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_STUDENT_PROFILE, type StudentProfile, type TrackerItemCreate } from "@shared/contracts";
import { SAMPLE_IDS, sampleCatalog, sampleTracker } from "./fixtures.sample";
import { createOnboardingRoutes, onboardingRoutes } from "./index";
import { toServerPreferences, type MatchSignals } from "@shared/onboarding";
import { makePreferences } from "@shared/onboarding/testing";
import { CONTACT_LEAKS, SENSITIVE_LEAKS } from "@shared/resume/__fixtures__/leaks.sample";
import type {
  FirstApplicationPlan,
  MatchEngine,
  OnboardingDeps,
  OnboardingEnv,
  OnboardingRecord,
  OnboardingRepos,
  ResumeAi,
} from "./ports";

// SAMPLE programs and text only. Repos, the engine and the AI are mocks.

const NOW = new Date("2026-11-11T15:00:00Z");

const requireUser: MiddlewareHandler = async (c, next) => {
  if (!c.req.header("x-test-user")) return c.json({ code: "unauthenticated" }, 401);
  await next();
};

const PLAN: FirstApplicationPlan = {
  steps: [
    { id: "save", title: "Save to Tracker", kind: "save", minutes: 1, doneDuringOnboarding: true },
    { id: "why", title: "Draft your why-this-program answer", kind: "practice", minutes: 5 },
    { id: "tailor", title: "Tailor your resume", kind: "resume", minutes: 30, due: "2026-11-14" },
    { id: "submit", title: "Submit", kind: "submit", minutes: 30, due: "2027-01-13" },
  ],
};

function setup(
  opts: { now?: Date; ai?: ResumeAi; consent?: boolean; existingTracker?: boolean; birthYearMonth?: string | null } = {},
) {
  // An adult by default, so the AI path is reachable; the age-gate test overrides it.
  let profile: StudentProfile = {
    ...EMPTY_STUDENT_PROFILE,
    birthYearMonth: opts.birthYearMonth === undefined ? "2005-01" : opts.birthYearMonth,
  };
  let record: OnboardingRecord | null = null;
  const catalog = sampleCatalog();
  const repos: OnboardingRepos = {
    profiles: {
      get: vi.fn(async () => profile),
      update: vi.fn(async (_u, patch) => (profile = { ...profile, ...patch })),
      getOnboarding: vi.fn(async () => record),
      saveOnboarding: vi.fn(async (_u, r) => void (record = r)),
      markOnboarded: vi.fn(async () => undefined),
    },
    programs: {
      listMatchable: vi.fn(async () => catalog),
      getEntry: vi.fn(async (id: string) => catalog.find((e) => e.program.id === id) ?? null),
    },
    tracker: {
      findByCycle: vi.fn(async () => (opts.existingTracker ? sampleTracker() : null)),
      create: vi.fn(async (_u: string, input: TrackerItemCreate) =>
        sampleTracker({ programCycleId: input.programCycleId, nameInMessages: input.nameInMessages, status: input.status }),
      ),
    },
    consents: { has: vi.fn(async () => opts.consent === true) },
    roadmap: { upsertStudentItems: vi.fn(async () => undefined) },
    reminders: { schedule: vi.fn(async () => undefined) },
  };
  const engine: MatchEngine = {
    findMatches: vi.fn(() => ({
      items: [
        {
          programId: SAMPLE_IDS.programB,
          tier: "good" as const,
          reasons: ["Open to first-years"],
          feasibility: { startBy: "2027-02-01", daysLeft: 90, enoughTime: true },
          requirementsMet: { met: 0, total: 0 },
        },
        {
          programId: SAMPLE_IDS.programA,
          tier: "strong" as const,
          reasons: ["Uses Python from your resume", "Matches your interest in data"],
          feasibility: { startBy: "2026-12-02", daysLeft: 65, enoughTime: true },
          requirementsMet: { met: 1, total: 1 },
          score: 0.031,
        },
      ],
    })),
    pickFirstDoor: vi.fn(() => ({ options: [{ programId: SAMPLE_IDS.programA, rationale: "Quickest to start" }] })),
    planFirstApplication: vi.fn(() => PLAN),
  };
  const ai: ResumeAi = opts.ai ?? {
    extractResumeProfile: vi.fn(async () => ({
      status: "ok" as const,
      profile: { skills: ["Python", "SQL"], fields: ["Data science"], courseworkKeywords: [], experienceKinds: ["research"] },
    })),
  };
  const createAi = vi.fn((_env: OnboardingEnv) => ai);
  const deps: OnboardingDeps = {
    auth: { requireUser, userId: (c: Context) => c.req.header("x-test-user") ?? null },
    repos: () => repos,
    engine,
    createAi,
    now: () => opts.now ?? NOW,
  };
  const app = createOnboardingRoutes(deps);
  return { app, repos, engine, ai, createAi, getRecord: () => record };
}

let userSeq = 0;
const freshUser = () => `user-${++userSeq}`;

function req(path: string, body?: unknown, user: string | null = "user-main", raw?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (user) headers["x-test-user"] = user;
  return new Request(`http://local${path}`, {
    method: body === undefined && raw === undefined ? "GET" : "POST",
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

const KEY_ENV: OnboardingEnv = { GEMINI_API_KEY: "test-key-not-real" };
const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  for (const m of ["log", "info", "warn", "error", "debug"] as const) consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  // No handler may log anything: request bodies and resume text must never reach a log line.
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  consoleSpies.splice(0).forEach((s) => s.mockRestore());
});

describe("auth and defaults", () => {
  it("requires a user on every route", async () => {
    const { app } = setup();
    for (const [path, body] of [
      ["/onboarding/state", undefined],
      ["/onboarding/quiz", { preferences: {} }],
      ["/onboarding/resume/extract", { redactedText: "x", consent: true }],
      ["/onboarding/matches", { preferences: {} }],
      ["/onboarding/first-door", { programId: SAMPLE_IDS.programA, programCycleId: SAMPLE_IDS.cycleA }],
    ] as const) {
      expect((await app.request(req(path, body, null))).status, path).toBe(401);
    }
  });

  it("the wired default export answers 401 without a session and reads nothing", async () => {
    const res = await onboardingRoutes.request(req("/onboarding/state", undefined, null));
    expect(res.status).toBe(401);
  });

  it("marks responses no-store and reports AI as off without a key", async () => {
    const { app } = setup();
    const off = await app.request(req("/onboarding/state"), undefined, {});
    expect(off.headers.get("cache-control")).toBe("no-store");
    expect(await off.json()).toMatchObject({ ai: { enabled: false, reason: "no_key" }, onboarding: null });
    const on = await app.request(req("/onboarding/state"), undefined, KEY_ENV);
    expect(await on.json()).toMatchObject({ ai: { enabled: true } });
  });
});

/** The browser's toServerPreferences output: the one shared vocabulary. */
const preferences = toServerPreferences(
  makePreferences({
    categories: ["research"],
    opportunityTypes: ["research_program"],
    classYear: "first_year",
    interests: ["climate", "ai_data"],
    experience: ["independent_project"],
    weeklyHours: 4,
    timing: ["next_summer"],
    pay: "prefer",
    timeZone: null,
  }),
);
const signalsOf = (over: Partial<MatchSignals> = {}): MatchSignals => ({ skills: [], fields: [], coursework: [], experience: [], graduationYear: null, ...over });

describe("POST /onboarding/quiz", () => {

  it("stores answered profile fields and approved signals, not resume text", async () => {
    const { app, repos, getRecord } = setup();
    const res = await app.request(
      req("/onboarding/quiz", {
        preferences,
        signals: signalsOf({ skills: ["python", "sql"], experience: ["leadership"], graduationYear: 2030 }),
        step: "resume",
        completed: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(repos.profiles.update).toHaveBeenCalledWith("user-main", {
      classYear: "first_year",
      weeklyPrepHours: 4,
      interestTags: ["climate", "ai_data"],
      preferredOpportunityTypes: ["research_program"],
      priorExperience: ["independent_project", "leadership"],
    });
    expect(getRecord()).toMatchObject({
      preferences,
      step: "resume",
      completedAt: NOW.toISOString(),
      signals: { skills: ["python", "sql"], experience: ["leadership"], graduationYear: 2030 },
    });
    expect(repos.profiles.markOnboarded).toHaveBeenCalledWith("user-main");
  });

  it("refuses sensitive keys before validation", async () => {
    const { app, repos } = setup();
    const res = await app.request(req("/onboarding/quiz", { preferences: { ...preferences, citizenship: "us_citizen" } }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "sensitive_field_rejected" });
    expect(repos.profiles.update).not.toHaveBeenCalled();
  });

  it("refuses unknown keys such as a name, without echoing values", async () => {
    const { app } = setup();
    const res = await app.request(req("/onboarding/quiz", { preferences, name: "Sample Person" }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("validation_failed");
    expect(text).not.toContain("Sample Person");
  });

  it("refuses an invalid enum without quoting it back", async () => {
    const { app } = setup();
    const res = await app.request(req("/onboarding/quiz", { preferences: { ...preferences, classYear: "secret-value-xyz" } }));
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("secret-value-xyz");
  });

  it("refuses terms that carry a sensitive statement, without naming the category", async () => {
    const { app, repos } = setup();
    const res = await app.request(req("/onboarding/quiz", { preferences, signals: signalsOf({ skills: ["python", "x:hillel board"] }) }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toMatchObject({ code: "unredacted_content", kinds: ["sensitive"] });
    expect(JSON.stringify(body)).not.toMatch(/religion|Hillel/i);
    expect(repos.profiles.saveOnboarding).not.toHaveBeenCalled();
  });

  it("refuses malformed JSON", async () => {
    const { app } = setup();
    expect((await app.request(req("/onboarding/quiz", undefined, "user-main", "{nope"))).status).toBe(400);
  });
});

describe("POST /onboarding/resume/extract", () => {
  const CLEAN = "Skills: Python, SQL, pandas\nResearch assistant: cleaned survey data\nTreasurer, [removed]\nContact: [email]";

  it("requires explicit consent:true", async () => {
    const { app, createAi } = setup();
    for (const body of [{ redactedText: CLEAN }, { redactedText: CLEAN, consent: false }, { redactedText: CLEAN, consent: "yes" }]) {
      const res = await app.request(req("/onboarding/resume/extract", body, freshUser()), undefined, KEY_ENV);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "consent_required" });
    }
    expect(createAi).not.toHaveBeenCalled();
  });

  it("rejects extra keys such as email, and sensitive keys", async () => {
    const { app } = setup();
    const extra = await app.request(req("/onboarding/resume/extract", { redactedText: CLEAN, consent: true, email: "x" }, freshUser()), undefined, KEY_ENV);
    expect(extra.status).toBe(400);
    const sensitive = await app.request(
      req("/onboarding/resume/extract", { redactedText: CLEAN, consent: true, firstGen: true }, freshUser()),
      undefined,
      KEY_ENV,
    );
    expect(await sensitive.json()).toMatchObject({ code: "sensitive_field_rejected" });
  });

  it("returns 422 for unredacted contact details or sensitive statements and never calls the model", async () => {
    const { app, createAi } = setup();
    const cases: [string, string[]][] = [
      ["Email sample.person@example.com", ["email"]],
      ["Call 555-010-0142", ["phone"]],
      ["Lives at 12 Sample Street", ["address"]],
      ["Vice president, Muslim Students Association", ["sensitive"]],
    ];
    for (const [text, kinds] of cases) {
      const res = await app.request(req("/onboarding/resume/extract", { redactedText: text, consent: true }, freshUser()), undefined, KEY_ENV);
      expect(res.status, text).toBe(422);
      const body = await res.text();
      expect(JSON.parse(body)).toMatchObject({ code: "unredacted_content", kinds });
      expect(body).not.toContain(text);
    }
    expect(createAi).not.toHaveBeenCalled();
  });

  it("refuses every known leak sample with 422, using the shared detectors as well as its own", async () => {
    const { app, createAi } = setup();
    for (const text of [...CONTACT_LEAKS, ...SENSITIVE_LEAKS]) {
      const res = await app.request(req("/onboarding/resume/extract", { redactedText: text, consent: true }, freshUser()), undefined, KEY_ENV);
      expect(res.status, text).toBe(422);
      expect(await res.text()).not.toContain(text);
    }
    expect(createAi).not.toHaveBeenCalled();
  });

  it("answers ai:off without a key and never builds a client", async () => {
    const { app, createAi } = setup();
    const res = await app.request(req("/onboarding/resume/extract", { redactedText: CLEAN, consent: true }, freshUser()), undefined, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ai: "off", reason: "no_key" });
    expect(createAi).not.toHaveBeenCalled();
  });

  it("keeps AI off for students not known to be 18 or older", async () => {
    for (const birthYearMonth of [null, "2009-06", "2008-11"]) {
      const { app, createAi } = setup({ birthYearMonth });
      const res = await app.request(req("/onboarding/resume/extract", { redactedText: CLEAN, consent: true }, freshUser()), undefined, KEY_ENV);
      expect(await res.json(), String(birthYearMonth)).toEqual({ ai: "off", reason: "age" });
      expect(createAi).not.toHaveBeenCalled();
      const state = await app.request(req("/onboarding/state"), undefined, KEY_ENV);
      expect(await state.json()).toMatchObject({ ai: { enabled: false, reason: "age" } });
    }
    // Born October 2008: 18 from 2026-10-31, so allowed on 2026-11-11.
    const adult = setup({ birthYearMonth: "2008-10" });
    const ok = await adult.app.request(req("/onboarding/resume/extract", { redactedText: CLEAN, consent: true }, freshUser()), undefined, KEY_ENV);
    expect(await ok.json()).toMatchObject({ ai: "on" });
  });

  it("sends exactly the approved text and returns cleaned terms without storing anything", async () => {
    const { app, ai, repos } = setup();
    const res = await app.request(req("/onboarding/resume/extract", { redactedText: CLEAN, consent: true }, freshUser()), undefined, KEY_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ai: "on",
      profile: { skills: ["Python", "SQL"], fields: ["Data science"], courseworkKeywords: [], experienceKinds: ["research"] },
    });
    expect(ai.extractResumeProfile).toHaveBeenCalledWith(CLEAN, { userId: expect.any(String), birthYearMonth: "2005-01" });
    expect(repos.profiles.update).not.toHaveBeenCalled();
    expect(repos.profiles.saveOnboarding).not.toHaveBeenCalled();
  });

  it("degrades to ai:unavailable when the model fails or returns junk", async () => {
    const outcomes: ResumeAi["extractResumeProfile"][] = [
      async () => {
        throw new Error(`provider echoed: ${CLEAN}`);
      },
      async () => ({ status: "unavailable" }),
      async () => ({ status: "ok", profile: { skills: "not-a-list" } }),
    ];
    for (const extract of outcomes) {
      const { app } = setup({ ai: { extractResumeProfile: extract } });
      const res = await app.request(req("/onboarding/resume/extract", { redactedText: CLEAN, consent: true }, freshUser()), undefined, KEY_ENV);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ai: "unavailable" });
    }
  });

  it("rate-limits through the binding and the per-user window", async () => {
    const { app } = setup();
    const denied = await app.request(
      req("/onboarding/resume/extract", { redactedText: CLEAN, consent: true }, freshUser()),
      undefined,
      { ...KEY_ENV, ONBOARDING_AI_RATE_LIMITER: { limit: async () => ({ success: false }) } },
    );
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("60");

    const user = freshUser();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await app.request(req("/onboarding/resume/extract", { redactedText: CLEAN, consent: true }, user), undefined, KEY_ENV)).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("refuses bodies over the size limit", async () => {
    const { app } = setup();
    const res = await app.request(
      req("/onboarding/resume/extract", undefined, freshUser(), JSON.stringify({ redactedText: "a".repeat(70_000), consent: true })),
      undefined,
      KEY_ENV,
    );
    expect(res.status).toBe(413);
  });
});

describe("POST /onboarding/matches", () => {
  it("returns tiered cards with reasons and counts, and no score", async () => {
    const { app, engine } = setup();
    const res = await app.request(
      req("/onboarding/matches", { preferences, signals: signalsOf({ skills: ["python", "python"] }), k: 5 }),
    );
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (await res.json()) as any;
    expect(body.items.map((i: { programId: string; tier: string }) => [i.programId, i.tier])).toEqual([
      [SAMPLE_IDS.programA, "strong"],
      [SAMPLE_IDS.programB, "good"],
    ]);
    expect(body.counts).toEqual({ strong: 1, good: 1, stretch: 0 });
    expect(body.firstDoor).toEqual([{ programId: SAMPLE_IDS.programA, rationale: "Quickest to start" }]);
    expect(JSON.stringify(body)).not.toMatch(/score|0\.031|percent|%/);
    expect(body.items[0].isSample).toBe(true);
    const call = vi.mocked(engine.findMatches).mock.calls[0]![0];
    expect(call.signals?.skills).toEqual(["python"]);
    expect(call.k).toBe(5);
    expect(call.now).toEqual(NOW);
  });

  it("refuses unclean signals", async () => {
    const { app, engine } = setup();
    const res = await app.request(req("/onboarding/matches", { preferences, signals: signalsOf({ skills: ["x:github.com/sample"] }) }));
    expect(res.status).toBe(422);
    expect(engine.findMatches).not.toHaveBeenCalled();
  });
});

describe("POST /onboarding/first-door", () => {
  const body = {
    programId: SAMPLE_IDS.programA,
    programCycleId: SAMPLE_IDS.cycleA,
    completedStepIds: ["why"],
    intention: { stepId: "tailor", on: "2026-11-12", at: "18:30" },
  };

  it("creates a TrackerItem, roadmap items and reminders, and records the first door", async () => {
    const { app, repos, engine, getRecord } = setup();
    const res = await app.request(req("/onboarding/first-door", body));
    expect(res.status).toBe(201);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await res.json()) as any;
    expect(repos.tracker.create).toHaveBeenCalledWith("user-main", {
      programCycleId: SAMPLE_IDS.cycleA,
      status: "applying",
      nameInMessages: true,
    });
    expect(vi.mocked(engine.planFirstApplication).mock.calls[0]![0].requirements).toHaveLength(1);
    const keys = vi.mocked(repos.roadmap.upsertStudentItems).mock.calls[0]![1].map((i) => i.itemKey);
    expect(keys).toEqual([
      `prep:${SAMPLE_IDS.programA}:summer-2027:save`,
      `prep:${SAMPLE_IDS.programA}:summer-2027:why`,
      `prep:${SAMPLE_IDS.programA}:summer-2027:tailor`,
      `apply:${SAMPLE_IDS.programA}:summer-2027`,
    ]);
    const reminders = vi.mocked(repos.reminders.schedule).mock.calls[0]![1];
    expect(reminders.map((r) => [r.kind, r.sendOn, r.timeZone])).toEqual([
      ["intention", "2026-11-12", "America/Chicago"],
      ["step_due", "2026-11-13", "America/Chicago"],
      ["submit_buffer", "2027-01-12", "America/Chicago"],
    ]);
    expect(out.plan.steps.filter((s: { done: boolean }) => s.done).map((s: { id: string }) => s.id)).toEqual(["save", "why"]);
    expect(getRecord()?.firstDoor).toMatchObject({
      programId: SAMPLE_IDS.programA,
      programCycleId: SAMPLE_IDS.cycleA,
      trackerItemId: SAMPLE_IDS.tracker,
    });
    expect(getRecord()?.firstDoor?.steps?.map((st) => st.id)).toEqual(["save", "why", "tailor", "submit"]);
    // The plan works to the resolved deadline and knows the cycle is not nomination-gated.
    expect(vi.mocked(engine.planFirstApplication).mock.calls[0]![0]).toMatchObject({
      deadline: { on: "2027-01-15", basis: "official" },
      nominationRequired: false,
      timeZone: "America/Chicago",
    });
    expect(repos.profiles.markOnboarded).toHaveBeenCalledWith("user-main");
  });

  it("is idempotent when the cycle is already tracked", async () => {
    const { app, repos } = setup({ existingTracker: true });
    const res = await app.request(req("/onboarding/first-door", body));
    expect(res.status).toBe(200);
    expect(repos.tracker.create).not.toHaveBeenCalled();
    expect(repos.roadmap.upsertStudentItems).toHaveBeenCalled();
  });

  it("needs consent before linking a student to a sensitive-audience program", async () => {
    const sensitiveBody = { programId: SAMPLE_IDS.programSensitive, programCycleId: SAMPLE_IDS.cycleSensitive };
    const denied = setup({ consent: false });
    const res = await denied.app.request(req("/onboarding/first-door", sensitiveBody));
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain("consent_required");
    expect(text).not.toContain("Sample Status Scholarship");
    expect(denied.repos.tracker.create).not.toHaveBeenCalled();
    expect(denied.repos.roadmap.upsertStudentItems).not.toHaveBeenCalled();
    expect(denied.repos.consents.has).toHaveBeenCalledWith("user-main", "sensitive_tracking", SAMPLE_IDS.programSensitive);

    const allowed = setup({ consent: true });
    const ok = await allowed.app.request(req("/onboarding/first-door", sensitiveBody));
    expect(ok.status).toBe(201);
    expect(vi.mocked(allowed.repos.tracker.create).mock.calls[0]![1].nameInMessages).toBe(false);
    expect(vi.mocked(allowed.repos.reminders.schedule).mock.calls[0]![1].every((r) => r.neutral)).toBe(true);
  });

  it("answers 404 for an unknown program and 409 for a closed cycle or a passed deadline", async () => {
    const { app } = setup();
    expect((await app.request(req("/onboarding/first-door", { ...body, programId: "00000000-0000-4000-8000-000000000999" }))).status).toBe(404);
    expect((await app.request(req("/onboarding/first-door", { ...body, programCycleId: SAMPLE_IDS.cycleAClosed }))).status).toBe(409);
    const late = setup({ now: new Date("2027-02-01T15:00:00Z") });
    const res = await late.app.request(req("/onboarding/first-door", body));
    expect(res.status).toBe(409);
    expect(late.repos.tracker.create).not.toHaveBeenCalled();
  });

  it("turns repository failures into a bare 500", async () => {
    const { app, repos } = setup();
    vi.mocked(repos.roadmap.upsertStudentItems).mockRejectedValueOnce(new Error("db exploded with secret detail"));
    const res = await app.request(req("/onboarding/first-door", body));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("secret detail");
  });
});
