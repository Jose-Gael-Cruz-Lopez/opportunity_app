import { describe, expect, it, vi } from "vitest";
import {
  buildReminders,
  buildRoadmapItems,
  deadlinePassed,
  defaultNameInMessages,
  MAX_REMINDERS,
  selectCycle,
  trackingConsentKind,
} from "./first-door";
import { SAMPLE_IDS, sampleCatalog, sampleCycle, sampleProgram } from "./fixtures.sample";
import { toProfilePatch, toStoredSignals } from "./index";
import type { FirstApplicationPlan, MatchSet } from "./ports";
import { cleanTerms, projectFirstDoor, projectMatches, sanitizeAiProfile } from "./project";
import { checkAiRateLimit, WindowLimiter } from "./rate-limit";
import { OnboardingPreferencesSchema, OnboardingSignalsSchema, toExperienceKinds } from "./schemas";
import { MatchSignalsSchema, ServerPreferencesSchema, toServerPreferences } from "@shared/onboarding";
import { buildSamplePrograms, runPersona, SAMPLE_PERSONAS } from "@shared/onboarding/sample";
import { makePreferences } from "@shared/onboarding/testing";
import { RoadmapItemSchema } from "@shared/contracts";

describe("WindowLimiter", () => {
  it("allows up to the limit, then blocks with a retry time", () => {
    const limiter = new WindowLimiter([{ limit: 2, windowMs: 60_000 }]);
    expect(limiter.check("u", 0).allowed).toBe(true);
    expect(limiter.check("u", 1_000).allowed).toBe(true);
    expect(limiter.check("u", 2_000)).toEqual({ allowed: false, retryAfterSeconds: 58 });
    expect(limiter.check("u", 60_001).allowed).toBe(true);
  });

  it("applies the daily ceiling across minute windows", () => {
    const limiter = new WindowLimiter([
      { limit: 3, windowMs: 60_000 },
      { limit: 4, windowMs: 86_400_000 },
    ]);
    for (let i = 0; i < 4; i++) expect(limiter.check("u", i * 120_000).allowed).toBe(true);
    expect(limiter.check("u", 10 * 120_000).allowed).toBe(false);
  });

  it("keeps keys separate", () => {
    const limiter = new WindowLimiter([{ limit: 1, windowMs: 60_000 }]);
    expect(limiter.check("a", 0).allowed).toBe(true);
    expect(limiter.check("b", 0).allowed).toBe(true);
  });
});

describe("checkAiRateLimit", () => {
  it("blocks when the binding says no, and fails closed when it throws", async () => {
    const fresh = () => new WindowLimiter([{ limit: 10, windowMs: 60_000 }]);
    const no = { limit: vi.fn().mockResolvedValue({ success: false }) };
    expect((await checkAiRateLimit("u", 0, no, fresh())).allowed).toBe(false);
    expect(no.limit).toHaveBeenCalledWith({ key: "onboarding-ai:u" });
    const broken = { limit: vi.fn().mockRejectedValue(new Error("down")) };
    expect((await checkAiRateLimit("u", 0, broken, fresh())).allowed).toBe(false);
    const yes = { limit: vi.fn().mockResolvedValue({ success: true }) };
    expect((await checkAiRateLimit("u", 0, yes, fresh())).allowed).toBe(true);
    expect((await checkAiRateLimit("u", 0, undefined, fresh())).allowed).toBe(true);
  });
});

describe("first-door rules", () => {
  it("needs consent to track sensitive, identity or health audiences", () => {
    expect(trackingConsentKind(sampleProgram())).toBeNull();
    expect(trackingConsentKind(sampleProgram({ sensitiveAudience: true }))).toBe("sensitive_tracking");
    expect(trackingConsentKind(sampleProgram({ identityAudience: ["gender_identity"] }))).toBe("identity_tracking");
    expect(trackingConsentKind(sampleProgram({ identityAudience: ["health"], sensitiveAudience: true }))).toBe("health_tracking");
    expect(defaultNameInMessages(sampleProgram())).toBe(true);
    expect(defaultNameInMessages(sampleProgram({ sensitiveAudience: true }))).toBe(false);
  });

  it("selects only an applyable cycle of a published, active program", () => {
    const [entry] = sampleCatalog();
    expect(selectCycle(entry!, SAMPLE_IDS.cycleA)?.id).toBe(SAMPLE_IDS.cycleA);
    expect(selectCycle(entry!, SAMPLE_IDS.cycleAClosed)).toBeNull();
    expect(selectCycle(entry!, SAMPLE_IDS.cycleB)).toBeNull();
    expect(selectCycle({ ...entry!, program: sampleProgram({ isPublished: false }) }, SAMPLE_IDS.cycleA)).toBeNull();
    expect(selectCycle({ ...entry!, program: sampleProgram({ lifecycle: "ended" }) }, SAMPLE_IDS.cycleA)).toBeNull();
  });

  it("knows when a deadline has passed in the student's today", () => {
    const [entry] = sampleCatalog();
    expect(deadlinePassed(entry!, SAMPLE_IDS.cycleA, "2026-11-11")).toBe(false);
    expect(deadlinePassed(entry!, SAMPLE_IDS.cycleA, "2027-01-16")).toBe(true);
    expect(deadlinePassed(entry!, "unknown", "2030-01-01")).toBe(false);
  });
});

const PLAN: FirstApplicationPlan = {
  steps: [
    { id: "save", title: "Save to Tracker", kind: "save", minutes: 1, doneDuringOnboarding: true },
    { id: "why", title: "Draft your why-this-program answer", kind: "practice", minutes: 5 },
    { id: "tailor", title: "Tailor your resume", kind: "resume", minutes: 30, due: "2026-11-14" },
    { id: "letter", title: "Ask for a letter", kind: "recommendation", minutes: 20, due: "2026-11-11" },
    { id: "late", title: "Something already overdue", kind: "other", minutes: 10, due: "2026-11-01" },
    { id: "submit", title: "Submit", kind: "submit", minutes: 30, due: "2027-01-13" },
    { id: "bad", title: "Bad date", kind: "other", minutes: 5, due: "2027-02-30" },
  ],
};

describe("buildRoadmapItems", () => {
  const items = buildRoadmapItems({
    program: sampleProgram(),
    cycle: sampleCycle(),
    plan: PLAN,
    completedStepIds: ["why"],
    today: "2026-11-11",
  });

  it("produces contract-valid student items with stable keys", () => {
    for (const item of items) expect(RoadmapItemSchema.safeParse(item).success, item.itemKey).toBe(true);
    expect(items.map((i) => i.itemKey)).toContain(`apply:${SAMPLE_IDS.programA}:summer-2027`);
    expect(items.find((i) => i.kind === "apply")?.pinned).toBe(true);
    expect(items.every((i) => i.source === "student")).toBe(true);
  });

  it("marks steps done in the session and drops invalid dates", () => {
    const state = Object.fromEntries(items.map((i) => [i.itemKey.split(":").pop(), i.state]));
    expect(state.save).toBe("done");
    expect(state.why).toBe("done");
    expect(state.tailor).toBe("open");
    const bad = items.find((i) => i.itemKey.endsWith(":bad"));
    expect(bad?.dueOn).toBeNull();
    expect(bad?.term).toBe("fall-2026");
    expect(items.find((i) => i.kind === "apply")?.term).toBe("spring-2027");
  });
});

describe("buildReminders", () => {
  const base = {
    trackerItemId: SAMPLE_IDS.tracker,
    plan: PLAN,
    completedStepIds: [] as string[],
    intention: null,
    today: "2026-11-11",
    timeZone: "America/Chicago",
    neutral: false,
  };

  it("schedules the day before each open dated step, never in the past", () => {
    const reminders = buildReminders(base);
    expect(reminders.map((r) => [r.stepId, r.sendOn, r.kind])).toEqual([
      ["letter", "2026-11-11", "step_due"],
      ["tailor", "2026-11-13", "step_due"],
      ["submit", "2027-01-12", "submit_buffer"],
    ]);
    expect(reminders.every((r) => r.at === "09:00" && r.timeZone === "America/Chicago")).toBe(true);
  });

  it("adds a valid intention and ignores one for an unknown step or a past day", () => {
    const withIntention = buildReminders({ ...base, intention: { stepId: "tailor", on: "2026-11-12", at: "18:30" } });
    expect(withIntention.find((r) => r.kind === "intention")).toMatchObject({ sendOn: "2026-11-12", at: "18:30" });
    expect(buildReminders({ ...base, intention: { stepId: "nope", on: "2026-11-12", at: "18:30" } }).some((r) => r.kind === "intention")).toBe(false);
    expect(buildReminders({ ...base, intention: { stepId: "tailor", on: "2026-11-10", at: "18:30" } }).some((r) => r.kind === "intention")).toBe(false);
  });

  it("keeps the intention under the cap and carries the neutral flag", () => {
    const many: FirstApplicationPlan = {
      steps: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, title: `Step ${i}`, kind: "other", minutes: 5, due: "2026-12-01" })),
    };
    const reminders = buildReminders({ ...base, plan: many, neutral: true, intention: { stepId: "s3", on: "2026-12-20", at: "07:00" } });
    expect(reminders).toHaveLength(MAX_REMINDERS);
    expect(reminders.some((r) => r.kind === "intention")).toBe(true);
    expect(reminders.every((r) => r.neutral)).toBe(true);
  });
});

describe("projectMatches", () => {
  const catalog = sampleCatalog();
  const item = (programId: string, tier: "strong" | "good" | "stretch") => ({
    programId,
    tier,
    reasons: ["Matches your interest in data", "Open to first-years", "Paid", "A fourth reason"],
    feasibility: { startBy: "2026-12-02", daysLeft: 65.7, enoughTime: true },
    requirementsMet: { met: 2, total: 3 },
    score: 0.0321,
    rrf: 0.5,
  });

  it("projects field by field, so no score leaves the server", () => {
    const set = { items: [item(SAMPLE_IDS.programB, "good"), item(SAMPLE_IDS.programA, "strong")] } as unknown as MatchSet;
    const cards = projectMatches(set, catalog, 10);
    expect(cards.map((c) => c.programId)).toEqual([SAMPLE_IDS.programA, SAMPLE_IDS.programB]);
    expect(JSON.stringify(cards)).not.toMatch(/score|rrf|0\.0321/);
    expect(cards[0]?.reasons).toHaveLength(3);
    expect(cards[0]?.feasibility.daysLeft).toBe(65);
    expect(cards[0]?.isSample).toBe(true);
  });

  it("drops unknown programs, duplicates and invalid tiers, and honours k", () => {
    const set = {
      items: [
        item("00000000-0000-4000-8000-000000000999", "strong"),
        item(SAMPLE_IDS.programA, "strong"),
        item(SAMPLE_IDS.programA, "good"),
        { ...item(SAMPLE_IDS.programB, "good"), tier: "best" },
        item(SAMPLE_IDS.programSensitive, "stretch"),
      ],
    } as unknown as MatchSet;
    expect(projectMatches(set, catalog, 10).map((c) => c.programId)).toEqual([SAMPLE_IDS.programA, SAMPLE_IDS.programSensitive]);
    expect(projectMatches(set, catalog, 1)).toHaveLength(1);
  });

  it("keeps first-door options that point at returned cards, at most three", () => {
    const cards = projectMatches({ items: [item(SAMPLE_IDS.programA, "strong")] }, catalog, 10);
    const options = projectFirstDoor(
      {
        options: [
          { programId: SAMPLE_IDS.programA, rationale: "Quickest to start" },
          { programId: SAMPLE_IDS.programA, rationale: "dup" },
          { programId: SAMPLE_IDS.programB, rationale: "not in cards" },
        ],
      },
      cards,
    );
    expect(options).toEqual([{ programId: SAMPLE_IDS.programA, rationale: "Quickest to start" }]);
  });
});

describe("cleanTerms and sanitizeAiProfile", () => {
  it("dedupes case-insensitively and drops unclean terms", () => {
    expect(cleanTerms(["Python", "python", "  SQL  ", "", "NSBE", "jane@example.com"], 10)).toEqual(["Python", "SQL"]);
    expect(cleanTerms(["a", "b", "c"], 2)).toEqual(["a", "b"]);
  });

  it("cleans model output and rejects malformed output", () => {
    const profile = sanitizeAiProfile({
      skills: ["Python", "Hillel event planning", "SQL"],
      fields: ["Computer science"],
      courseworkKeywords: ["Data structures"],
      experienceKinds: ["research", "volunteer", "made-up"],
      name: "Sample Person",
    });
    expect(profile).toEqual({
      skills: ["Python", "SQL"],
      fields: ["Computer science"],
      courseworkKeywords: ["Data structures"],
      experienceKinds: ["research", "community_service"],
    });
    expect(JSON.stringify(profile)).not.toMatch(/Sample Person/);
    expect(sanitizeAiProfile("not an object")).toBeNull();
    expect(sanitizeAiProfile({ skills: "Python" })).toBeNull();
  });
});

describe("schemas and profile mapping", () => {
  it("rejects unknown keys such as name or email", () => {
    expect(OnboardingPreferencesSchema.safeParse({ name: "x" }).success).toBe(false);
    expect(OnboardingSignalsSchema.safeParse({ email: "x" }).success).toBe(false);
  });

  it("maps resume experience words to profile kinds", () => {
    expect(toExperienceKinds(["part-time", "club", "teaching", "research", "club"])).toEqual([
      "paid_work",
      "leadership",
      "teaching_or_tutoring",
      "research",
    ]);
  });

  it("patches only answered fields, in the shared vocabulary", () => {
    const prefs = OnboardingPreferencesSchema.parse(
      toServerPreferences(
        makePreferences({
          categories: ["research"],
          opportunityTypes: ["research_program", "research_program"],
          classYear: "first_year",
          interests: ["climate"],
          experience: ["leadership"],
          weeklyHours: 4,
          timeZone: null,
        }),
      ),
    );
    const signals = OnboardingSignalsSchema.parse({ skills: ["python"], fields: [], coursework: [], experience: ["community_service"], graduationYear: null });
    expect(toProfilePatch(prefs, signals)).toEqual({
      classYear: "first_year",
      weeklyPrepHours: 4,
      interestTags: ["climate"],
      preferredOpportunityTypes: ["research_program"],
      priorExperience: ["leadership", "community_service"],
    });
    const blank = OnboardingPreferencesSchema.parse(toServerPreferences(makePreferences({ timeZone: null })));
    expect(toProfilePatch(blank, null)).toEqual({ weeklyPrepHours: blank.weeklyHours });
    expect(toStoredSignals(signals).experience).toEqual(["community_service"]);
  });

  it("drops unlisted skills and coursework that fail the guard when storing signals", () => {
    const stored = toStoredSignals(
      OnboardingSignalsSchema.parse({ skills: ["python", "x:hillel board"], fields: ["computing"], coursework: ["Statistics"], experience: [], graduationYear: 2030 }),
    );
    expect(stored.skills).toEqual(["python"]);
    expect(stored.coursework).toEqual(["Statistics"]);
    expect(stored.graduationYear).toBe(2030);
  });
});

describe("one preferences vocabulary for browser and server", () => {
  it("is the shared schema itself, not a copy", () => {
    expect(OnboardingPreferencesSchema).toBe(ServerPreferencesSchema);
    expect(OnboardingSignalsSchema).toBe(MatchSignalsSchema);
  });

  it("accepts what every SAMPLE persona's browser would send, without any device-only answer", () => {
    const programs = buildSamplePrograms("2026-11-11T15:00:00Z");
    for (const persona of SAMPLE_PERSONAS) {
      const prefs = runPersona(persona, { now: "2026-11-11T15:00:00Z", programs }).preferences;
      const sent = toServerPreferences(prefs);
      expect(OnboardingPreferencesSchema.safeParse(sent).success, persona.id).toBe(true);
      expect(Object.keys(sent)).not.toContain("target");
      // A device-only answer would be refused, not dropped.
      expect(OnboardingPreferencesSchema.safeParse({ ...sent, target: "x" }).success).toBe(false);
    }
  });
});
