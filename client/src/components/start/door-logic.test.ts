import { describe, expect, it } from "vitest";
import { doneCount, fallbackDoors, fallbackPlan, nextOpenStep, reminderTarget, serverStepIds, widgetFor } from "./door-logic";
import { buildSamplePrograms } from "./fixtures";

const NOW = new Date("2026-11-11T15:00:00Z");
const samples = buildSamplePrograms(NOW);
const coastal = samples.find((s) => s.card.slug === "sample-coastal-data-fellowship")!;
const sprint = samples.find((s) => s.card.slug === "sample-open-source-starter-sprint")!;

describe("widgetFor", () => {
  it("maps the planner's step kinds to inline widgets", () => {
    const w = (kind: string, title = "x", id = "s") => widgetFor({ kind, title, id });
    expect(w("save")).toBe("tracker");
    expect(w("eligibility")).toBe("eligibility");
    expect(w("draft")).toBe("draft");
    expect(w("recommenders")).toBe("letters");
    expect(w("letters")).toBe("letters");
    expect(w("reminder")).toBe("reminder");
    expect(w("resume")).toBe("resume");
    expect(w("submit")).toBe("submit");
    expect(w("open_application")).toBe("open");
    expect(w("nomination")).toBe("plain");
  });

  it("falls back to the title when a kind is unfamiliar", () => {
    expect(widgetFor({ kind: "step", title: "Practise rep: draft 'Why this program'", id: "s3" })).toBe("draft");
    expect(widgetFor({ kind: "step", title: "Implementation intention", id: "s6" })).toBe("reminder");
  });
});

describe("fallback plan", () => {
  it("schedules backward from the deadline with letters and a T-2 submit", () => {
    const plan = fallbackPlan(coastal.requirements, "2026-12-26", "2026-11-11");
    expect(plan.map((s) => s.id)).toEqual(["save", "confirm-eligibility", "practice", "tailor-resume", "ask-letters", "intention", "submit"]);
    expect(plan.find((s) => s.id === "ask-letters")?.due).toBe("2026-12-05");
    expect(plan.find((s) => s.id === "submit")?.due).toBe("2026-12-24");
    expect(plan.find((s) => s.id === "tailor-resume")?.due).toBe("2026-11-14");
  });

  it("skips letters when none are required and never schedules before today", () => {
    const plan = fallbackPlan(sprint.requirements, null, "2026-11-11");
    expect(plan.some((s) => s.id === "ask-letters")).toBe(false);
    expect(plan.find((s) => s.id === "submit")?.due).toBeNull();
    const tight = fallbackPlan(coastal.requirements, "2026-11-20", "2026-11-11");
    expect(tight.find((s) => s.id === "ask-letters")?.due).toBe("2026-11-11");
  });

  it("counts progress and finds the next open step", () => {
    const plan = fallbackPlan(coastal.requirements, "2026-12-26", "2026-11-11");
    const done = new Set(["save", "practice"]);
    expect(doneCount(plan, done)).toBe(2);
    expect(nextOpenStep(plan, done)?.id).toBe("confirm-eligibility");
    expect(reminderTarget(plan, done)?.id).toBe("tailor-resume");
    expect(nextOpenStep(plan, new Set(plan.map((s) => s.id)))).toBeNull();
  });

  it("never makes the 'pick a time' step its own reminder target, and keeps the quick steps within four minutes", () => {
    const plan = fallbackPlan(coastal.requirements, "2027-01-15", "2026-11-11");
    const allButSubmit = new Set(plan.filter((s) => s.kind !== "submit").map((s) => s.id));
    expect(reminderTarget(plan, allButSubmit)?.id).toBe("submit");
    expect(plan.filter((s) => s.doneDuringOnboarding).reduce((n, s) => n + s.minutes, 0)).toBeLessThanOrEqual(4);
    expect(plan.find((s) => s.id === "intention")?.doneDuringOnboarding).toBe(false);
  });
});

describe("server step ids and fallback doors", () => {
  it("keeps only ids the server pattern accepts, at most ten", () => {
    expect(serverStepIds(["save", "Bad Id", "ask-letters", "x".repeat(41)])).toEqual(["save", "ask-letters"]);
    expect(serverStepIds(Array.from({ length: 12 }, (_, i) => `s${i}`))).toHaveLength(10);
  });

  it("prefers feasible strong and good matches, then stretches", () => {
    const doors = fallbackDoors([
      { programId: "a", enoughTime: false, tier: "strong" },
      { programId: "b", enoughTime: true, tier: "stretch" },
      { programId: "c", enoughTime: true, tier: "good" },
      { programId: "d", enoughTime: true, tier: "strong" },
    ]);
    expect(doors.map((d) => d.programId)).toEqual(["c", "d", "b"]);
    expect(doors[0].rationale).toBe("Best match for your answers");
  });
});
