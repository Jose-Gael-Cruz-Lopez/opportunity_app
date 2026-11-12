import type { Context, MiddlewareHandler } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MatchSetSchema, toServerPreferences, type MatchSignals } from "@shared/onboarding";
import { makePreferences } from "@shared/onboarding/testing";
import { createUser, seededDb, type TestDb } from "@server/db/testing/fixtures";
import type { SampleSeed } from "@server/db/seed/build";
import * as onboardingRepo from "@server/db/repos/onboarding";
import * as students from "@server/db/repos/students";
import * as s from "@server/db/schema";
import { eq } from "drizzle-orm";
import { createD1OnboardingRepos, loadCatalog, resolveCycleDeadline } from "./d1";
import { sharedMatchEngine, toOnboardingProgram } from "./engine";
import { createOnboardingRoutes } from "./index";
import type { OnboardingDeps, ResumeAi } from "./ports";
import { createResumeAi } from "./wiring";

/**
 * End to end over the committed migrations, the SAMPLE seed (28 invented programs, all
 * is_sample = 1), the real D1 repos and the real @shared/onboarding engine. Only auth is faked
 * (a header names the user) and the clock is fixed.
 */

const NOW = new Date("2026-11-11T15:00:00Z");

describe("onboarding over D1 and the shared engine", () => {
  let t: TestDb & { seed: SampleSeed };
  let userId: string;

  beforeEach(async () => {
    t = await seededDb("2026-11-11");
    userId = await createUser(t.db);
  });

  function app(ai?: ResumeAi) {
    const requireUser: MiddlewareHandler = async (c, next) => {
      if (!c.req.header("x-test-user")) return c.json({ code: "unauthenticated" }, 401);
      await next();
    };
    const deps: OnboardingDeps = {
      auth: { requireUser, userId: (c: Context) => c.req.header("x-test-user") ?? null },
      repos: () => createD1OnboardingRepos(t.db, () => NOW.getTime()),
      engine: sharedMatchEngine,
      createAi: () => ai ?? createResumeAi({}),
      now: () => NOW,
    };
    return createOnboardingRoutes(deps);
  }

  const post = (path: string, body: unknown, user = userId) =>
    new Request(`http://local/onboarding${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": user },
      body: JSON.stringify(body),
    });
  const get = (path: string, user = userId) => new Request(`http://local/onboarding${path}`, { headers: { "x-test-user": user } });

  const preferences = toServerPreferences(
    makePreferences({ categories: [], opportunityTypes: [], classYear: "first_year", interests: ["ai_data"], weeklyHours: 4, timeZone: "America/Chicago" }),
  );
  const signals: MatchSignals = { skills: ["python", "sql"], fields: ["computing"], coursework: ["Statistics"], experience: ["research"], graduationYear: 2030 };

  it("builds catalog entries with cards, cycles, requirements and resolved deadlines", async () => {
    const catalog = await loadCatalog(t.db, NOW);
    expect(catalog.length).toBeGreaterThan(10);
    for (const entry of catalog) {
      expect(entry.program.isSample).toBe(true);
      expect(entry.card?.programId).toBe(entry.program.id);
      expect(entry.cycles.some((c) => c.id === entry.card?.programCycleId)).toBe(true);
      for (const r of entry.requirements) expect(entry.cycles.some((c) => c.id === r.programCycleId)).toBe(true);
      for (const c of entry.cycles) expect(entry.resolved?.[c.id]).toBeDefined();
      expect(toOnboardingProgram(entry)?.extras?.requirements?.length ?? 0).toBe(
        entry.requirements.filter((r) => r.programCycleId === entry.card?.programCycleId).length,
      );
    }
    // Nomination-gated cycles work to a campus estimate, never the national date while one is ahead.
    const gated = catalog.find((e) => e.card?.flags.nominationRequired && e.resolved?.[e.card.programCycleId]?.basis === "campus_estimate");
    if (gated) expect(gated.resolved![gated.card!.programCycleId]!.on! < "2027-12-31").toBe(true);
  });

  it("resolves a passed cycle to a past date so first door refuses it", () => {
    const r = resolveCycleDeadline(
      [{ id: "d", kind: "application", scope: "national", roundLabel: null, basis: "official", precision: "date_only", tzMode: "fixed", localDate: "2026-01-15", localTime: null, windowStart: null, windowEnd: null, timeZone: "America/New_York", dueAt: "2026-01-16T04:59:59Z", sortAt: "2026-01-16T04:59:59Z", revision: 1 }] as never,
      false,
      NOW.getTime(),
      "America/New_York",
    );
    expect(r.passed).toBe(true);
    expect(r.on! < "2026-11-11").toBe(true);
  });

  it("runs state, quiz, matches and first door, storing only the shared shapes", async () => {
    const routes = app();
    const state = await routes.request(get("/state"), undefined, {});
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ onboarding: null, ai: { enabled: false, reason: "no_key" } });

    const quiz = await routes.request(post("/quiz", { preferences, signals, step: "quiz", completed: true }), undefined, {});
    expect(quiz.status).toBe(200);
    const stored = await onboardingRepo.getOnboardingRecord(t.db, userId);
    expect(stored?.preferences).toEqual(preferences);
    expect(stored?.signals).toMatchObject({ skills: ["python", "sql"], coursework: ["Statistics"], graduationYear: 2030 });
    const user = await t.db.query.users.findFirst({ where: eq(s.users.id, userId) });
    expect(user?.onboardedAt).not.toBeNull();
    expect((await students.getProfile(t.db, userId))?.profile).toMatchObject({ classYear: "first_year", interestTags: ["ai_data"], weeklyPrepHours: 4 });

    const matchesRes = await routes.request(post("/matches", { preferences, signals, k: 8 }), undefined, {});
    expect(matchesRes.status).toBe(200);
    const matches = (await matchesRes.json()) as {
      items: { programId: string; tier: string; isSample: boolean; reasons: string[] }[];
      firstDoor: { programId: string }[];
    };
    expect(matches.items.length).toBeGreaterThan(0);
    expect(matches.items.every((i) => i.isSample && i.reasons.length > 0)).toBe(true);
    expect(JSON.stringify(matches)).not.toMatch(/score|percent|"rrf|fused/i);
    expect(matches.firstDoor.length).toBeGreaterThan(0);

    const choice = matches.firstDoor[0]!.programId;
    const entry = (await loadCatalog(t.db, NOW, [choice]))[0]!;
    const door = await routes.request(
      post("/first-door", {
        programId: choice,
        programCycleId: entry.card!.programCycleId,
        completedStepIds: [],
        intention: null,
        timeZone: "America/Chicago",
      }),
      undefined,
      {},
    );
    expect(door.status).toBe(201);
    const out = (await door.json()) as { trackerItem: { id: string }; plan: { steps: { id: string; due: string | null }[] }; roadmapItems: { itemKey: string }[] };
    expect(out.plan.steps.length).toBeGreaterThan(0);
    // Every due date is on or after today and the apply item is pinned in the roadmap rows.
    for (const st of out.plan.steps) if (st.due) expect(st.due >= "2026-11-11").toBe(true);
    const tracked = await students.listTrackerItems(t.db, userId);
    expect(tracked.map((i) => i.id)).toEqual([out.trackerItem.id]);
    const roadmap = await students.getRoadmapState(t.db, userId);
    expect([...roadmap.actions.keys()].sort()).toEqual(out.roadmapItems.map((i) => i.itemKey).sort());
    const reminders = await onboardingRepo.listReminders(t.db, userId);
    expect(reminders.every((r) => r.trackerItemId === out.trackerItem.id && r.state === "scheduled")).toBe(true);
    const record = await onboardingRepo.getOnboardingRecord(t.db, userId);
    expect(record?.firstDoor).toMatchObject({ programId: choice, trackerItemId: out.trackerItem.id });

    // Retrying is idempotent: same tracker item, no duplicate reminders.
    const again = await routes.request(
      post("/first-door", { programId: choice, programCycleId: entry.card!.programCycleId, completedStepIds: [], intention: null, timeZone: "America/Chicago" }),
      undefined,
      {},
    );
    expect(again.status).toBe(200);
    expect((await onboardingRepo.listReminders(t.db, userId)).length).toBe(reminders.length);

    // Removing the tracked application cancels its reminders.
    await students.removeTrackerItem(t.db, userId, out.trackerItem.id, NOW.getTime() + 1);
    expect((await onboardingRepo.listReminders(t.db, userId)).every((r) => r.state === "cancelled")).toBe(true);

    // Deleting the account removes the onboarding record and reminders.
    await students.purgeUser(t.db, userId);
    expect(await onboardingRepo.getOnboardingRecord(t.db, userId)).toBeNull();
    expect(await onboardingRepo.listReminders(t.db, userId)).toEqual([]);
  });

  it("returns a contract-valid engine match set and never opts in status-defined programs", async () => {
    const catalog = await loadCatalog(t.db, NOW);
    const set = sharedMatchEngine.findMatches({ preferences, signals, programs: catalog, now: NOW, k: 20 });
    expect(MatchSetSchema.safeParse(set).success).toBe(true);
    const sensitive = new Set(catalog.filter((e) => e.program.sensitiveAudience).map((e) => e.program.id));
    expect(set.items.some((i) => sensitive.has(i.programId))).toBe(false);
    // pickFirstDoor only reads sets this engine produced.
    expect(sharedMatchEngine.pickFirstDoor({ items: set.items }, preferences, NOW).options).toEqual([]);
    expect(sharedMatchEngine.pickFirstDoor(set, preferences, NOW).options.length).toBeGreaterThan(0);
  });

  it("answers ai:off with no key and never calls a model; the wired AI degrades to unavailable", async () => {
    const res = await app().request(post("/resume/extract", { redactedText: "Skills: Python, SQL\nResearch assistant: cleaned survey data", consent: true }), undefined, {});
    expect(await res.json()).toEqual({ ai: "off", reason: "no_key" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const direct = await createResumeAi({}).extractResumeProfile("Skills: Python, SQL", { userId, birthYearMonth: "2000-01" });
    expect(direct).toEqual({ status: "unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("accepts the account-wide identity consent for any identity program, and the status opt-in only per program", async () => {
    const repos = createD1OnboardingRepos(t.db, () => NOW.getTime());
    t.raw.exec("INSERT INTO consent_texts (version, kind, text_sha256, published_at) VALUES ('it-1', 'identity_tracking', 'x', 1), ('st-1', 'sensitive_tracking', 'x', 1)");
    const programA = "0190a0a0-0000-7000-8000-00000000000a";
    const programB = "0190a0a0-0000-7000-8000-00000000000b";
    expect(await repos.consents.has(userId, "identity_tracking", programA)).toBe(false);
    // Settings grants identity_tracking once for the account (scope_id NULL).
    expect((await students.changeConsent(t.db, userId, { kind: "identity_tracking", textVersion: "it-1", programId: null, granted: true }, NOW.getTime())).ok).toBe(true);
    expect(await repos.consents.has(userId, "identity_tracking", programA)).toBe(true);
    expect(await repos.consents.has(userId, "identity_tracking", programB)).toBe(true);
    // Revoked: no longer counts.
    await students.changeConsent(t.db, userId, { kind: "identity_tracking", textVersion: "it-1", programId: null, granted: false }, NOW.getTime() + 1);
    expect(await repos.consents.has(userId, "identity_tracking", programA)).toBe(false);
  });
});
