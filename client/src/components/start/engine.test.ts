import { describe, expect, it } from "vitest";
import { FORBIDDEN_STUDENT_SCORE_FIELDS } from "@shared/contracts";

/*
 * End-to-end through the seam with the real @shared/onboarding engine and the SAMPLE
 * fixtures. Parsing and redaction (@shared/resume) are covered by that module's own tests.
 */
const engine = await import("./engine");
const { buildSamplePrograms } = await import("./fixtures");
const { normalizeSignals } = await import("./resume-view");

const NOW = new Date("2026-11-11T15:00:00Z");
const bundles = buildSamplePrograms(NOW);

function answerAll(answers: Record<string, unknown>) {
  const order: string[] = [];
  const saved: Record<string, string | string[] | number | null> = {};
  const signals = normalizeSignals({ skills: ["Python"], fields: ["computing"], experienceTypes: ["research"], graduationYear: 2030 });
  // Walk the quiz the way the page does: ask nextQuestion, answer or skip, replay.
  for (let i = 0; i < 30; i++) {
    const state = engine.replayQuiz(saved, order, { bundles, signals, timeZone: "America/New_York", now: NOW });
    const q = engine.nextQuestionView(state);
    if (!q) return { state, order, saved };
    const value = (q.id in answers ? answers[q.id] : null) as string | string[] | number | null;
    if (q.id !== "resume") engine.answer(state, q.id, value); // throws if the engine rejects it
    saved[q.id] = value;
    order.push(q.id);
  }
  throw new Error("quiz did not finish");
}

describe("onboarding seam with the real engine", () => {
  it("lists quiz questions with the resume step third", () => {
    const qs = engine.quizQuestions();
    expect(qs.length).toBeGreaterThan(8);
    expect(qs[2].kind).toBe("resume");
    expect(qs.find((q) => q.id === "target")?.private).toBe(true);
    expect(qs.find((q) => q.id === "weekly_hours")?.kind).toBe("slider");
  });

  it("runs quiz, matches, first door and plan without any score", () => {
    const { state, order } = answerAll({
      looking_for: ["research", "fellowships"],
      interests: ["ai_data", "climate"],
      resume: "paste",
      class_year: "first_year",
      major: "computing",
      pay: "prefer",
    });
    expect(order[0]).toBe("looking_for");
    expect(order).toContain("resume");

    const prefs = engine.preferencesOf(state);
    expect(prefs.categories).toEqual(["research", "fellowships"]);
    expect(prefs.hasResume).toBe(true);

    const signals = normalizeSignals({ skills: ["Python"], fields: ["computing"], experienceTypes: ["research"], graduationYear: 2030 });
    const run = engine.runMatches(prefs, signals, bundles, NOW);
    expect(run.views.length).toBeGreaterThanOrEqual(3);
    const tiers = run.views.map((v) => v.tier);
    expect([...tiers].sort((a, b) => ["strong", "good", "stretch"].indexOf(a) - ["strong", "good", "stretch"].indexOf(b))).toEqual(tiers);
    for (const v of run.views) {
      expect(v.reasons.length).toBeGreaterThan(0);
      expect(bundles.some((b) => b.card.programId === v.programId)).toBe(true);
    }
    const json = JSON.stringify(run.views);
    for (const f of FORBIDDEN_STUDENT_SCORE_FIELDS) expect(json).not.toContain(`"${f}"`);
    expect(json).not.toMatch(/\d+(\.\d+)?\s*%/);

    const doors = engine.firstDoors(run.raw, prefs, NOW);
    expect(doors.length).toBeGreaterThan(0);
    expect(doors.length).toBeLessThanOrEqual(3);

    const chosen = bundles.find((b) => b.card.programId === doors[0].programId)!;
    const plan = engine.planFor(chosen, signals, NOW, prefs, false);
    expect(plan.steps.length).toBeGreaterThan(2);
    expect(plan.steps.some((s) => s.doneDuringOnboarding)).toBe(true);
    for (const s of plan.steps) if (s.due) expect(s.due >= "2026-11-11").toBe(true);
  });

  it("keeps the device-only target answer out of server preferences", () => {
    const { state } = answerAll({ goal: "specific", target: "Sample Program X" });
    const prefs = engine.preferencesOf(state) as unknown as Record<string, unknown>;
    expect(prefs.target).toBe("Sample Program X");
    expect(engine.serverPreferencesOf(engine.preferencesOf(state))).not.toHaveProperty("target");
  });

  it("sends exactly the server's schemas: one shared vocabulary for preferences and signals", async () => {
    const { MatchSignalsSchema, ServerPreferencesSchema } = await import("@shared/onboarding");
    const { OnboardingPreferencesSchema, OnboardingSignalsSchema } = await import("../../../../server/api/v1/onboarding/schemas");
    const { state } = answerAll({});
    const prefs = engine.serverPreferencesOf(engine.preferencesOf(state));
    expect(ServerPreferencesSchema.safeParse(prefs).success).toBe(true);
    expect(OnboardingPreferencesSchema.safeParse(prefs).success).toBe(true);
    const signals = engine.serverSignalsOf(normalizeSignals({ skills: ["Python", "SQL"], fields: ["computing"], coursework: ["Statistics"], experienceTypes: ["research"], graduationYear: 2030 }));
    expect(MatchSignalsSchema.safeParse(signals).success).toBe(true);
    expect(OnboardingSignalsSchema.safeParse(signals).success).toBe(true);
    expect(signals).toMatchObject({ skills: expect.arrayContaining(["python"]), fields: ["computing"], experience: ["research"], graduationYear: 2030 });
    expect(engine.serverSignalsOf(null)).toBeNull();
  });

  it("drops answers the quiz no longer accepts when replaying", () => {
    const state = engine.replayQuiz({ looking_for: ["not_a_category"], class_year: "first_year" }, ["looking_for", "class_year"], { bundles, signals: null, timeZone: null, now: NOW });
    expect(engine.preferencesOf(state).categories).toEqual([]);
    expect(engine.preferencesOf(state).classYear).toBe("first_year");
  });

  it("names interest topics for the practice draft", () => {
    expect(engine.interestLabel("climate")).toBe("Climate and environment");
    expect(engine.interestLabel("nope")).toBeNull();
    expect(engine.interestLabel(undefined)).toBeNull();
  });
});
