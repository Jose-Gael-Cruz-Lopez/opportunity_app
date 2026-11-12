import { describe, expect, it } from "vitest";
import { STAGES } from "./flow";
import { HISTORY_KEY, STAGE_TITLES, backAction, stageFromHistoryState, withStage } from "./nav";

describe("onboarding navigation", () => {
  it("names every stage in the document title", () => {
    for (const s of STAGES) expect(STAGE_TITLES[s]).toMatch(/· Novus$/);
    expect(new Set(Object.values(STAGE_TITLES)).size).toBe(STAGES.length);
  });

  it("reads only its own history entries and keeps other routers' state", () => {
    expect(stageFromHistoryState(null)).toBeNull();
    expect(stageFromHistoryState({ [HISTORY_KEY]: "admin" })).toBeNull();
    expect(stageFromHistoryState({ [HISTORY_KEY]: "matches" })).toBe("matches");
    expect(withStage({ other: 1 }, "door")).toEqual({ other: 1, [HISTORY_KEY]: "door" });
    expect(withStage("x", "quiz")).toEqual({ [HISTORY_KEY]: "quiz" });
  });

  it("reopens the last question when going back to a finished quiz, so it cannot bounce forward", () => {
    expect(backAction("matches", "quiz")).toBe("pop_answer");
    expect(backAction("resume", "quiz")).toBe("pop_answer");
    expect(backAction("door", "matches")).toBe("show");
    expect(backAction("quiz", "welcome")).toBe("show");
    expect(backAction("quiz", "matches")).toBe("show");
  });
});
