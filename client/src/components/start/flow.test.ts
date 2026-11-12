import { describe, expect, it } from "vitest";
import { fallbackPlan } from "./door-logic";
import { buildSamplePrograms } from "./fixtures";
import * as engine from "./engine";
import {
  DOOR_QUICK_MINUTES,
  ENDOWED_START,
  STAGE_BUDGET_SECONDS,
  STAGES,
  TO_MATCHES_SECONDS,
  TOTAL_BUDGET_SECONDS,
  isStage,
  minutesLeft,
  nextStage,
  previousStage,
  progressFraction,
  timeLeftLabel,
} from "./flow";

describe("flow budgets", () => {
  it("reaches matches within the five minutes the welcome screen promises", () => {
    expect(TO_MATCHES_SECONDS).toBeLessThanOrEqual(300);
    expect(TOTAL_BUDGET_SECONDS).toBe(TO_MATCHES_SECONDS + DOOR_QUICK_MINUTES * 60);
  });

  it("budgets the door for exactly the quick steps the plan asks for now", () => {
    const now = new Date("2026-11-11T15:00:00Z");
    const quick = (steps: ReadonlyArray<{ minutes: number; doneDuringOnboarding: boolean }>) =>
      steps.filter((s) => s.doneDuringOnboarding).reduce((n, s) => n + s.minutes, 0);
    expect(quick(fallbackPlan([], "2027-01-15", "2026-11-11")) * 60).toBeLessThanOrEqual(STAGE_BUDGET_SECONDS.door);
    for (const bundle of buildSamplePrograms(now)) {
      const plan = engine.planFor(bundle, null, now, null, false);
      expect(quick(plan.steps) * 60, bundle.card.name).toBeLessThanOrEqual(STAGE_BUDGET_SECONDS.door);
    }
  });

  it("starts partly filled (endowed progress) and ends at 1", () => {
    expect(progressFraction("welcome", 0)).toBeCloseTo(ENDOWED_START);
    expect(progressFraction("done")).toBe(1);
  });

  it("never moves backwards through the stages", () => {
    let last = -1;
    for (const s of STAGES) {
      for (const w of [0, 0.5, 1]) {
        const p = progressFraction(s, w);
        expect(p).toBeGreaterThanOrEqual(last);
        last = p;
      }
    }
  });

  it("clamps out-of-range and non-finite progress within a stage", () => {
    expect(progressFraction("quiz", 5)).toBe(progressFraction("quiz", 1));
    expect(progressFraction("quiz", -1)).toBe(progressFraction("quiz", 0));
    expect(progressFraction("quiz", Number.NaN)).toBe(progressFraction("quiz", 0));
  });

  it("estimates whole minutes left, rounding up", () => {
    expect(minutesLeft("welcome", 0)).toBe(9); // 495 s
    expect(minutesLeft("quiz", 0)).toBe(8); // 480 s left
    expect(minutesLeft("matches", 0)).toBe(5); // 270 s
    expect(minutesLeft("door", 0)).toBe(4); // the four quick-step minutes
    expect(minutesLeft("door", 1)).toBe(1);
    expect(minutesLeft("done")).toBe(0);
  });

  it("words the estimate", () => {
    expect(timeLeftLabel("quiz", 0)).toBe("About 8 min left");
    expect(timeLeftLabel("door", 0)).toBe("About 4 min left");
    expect(timeLeftLabel("door", 0.9)).toBe("Under a minute left");
    expect(timeLeftLabel("done")).toBe("All done");
  });

  it("steps through stages and stops at the ends", () => {
    expect(nextStage("welcome")).toBe("quiz");
    expect(nextStage("done")).toBe("done");
    expect(previousStage("welcome")).toBe("welcome");
    expect(previousStage("resume")).toBe("quiz");
  });

  it("recognises stages", () => {
    expect(isStage("door")).toBe(true);
    expect(isStage("admin")).toBe(false);
    expect(isStage(3)).toBe(false);
  });
});
