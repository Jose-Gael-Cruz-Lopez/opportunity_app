import { describe, expect, it } from "vitest";
import type { QuestionView } from "./normalize";
import { arrowTarget, canContinue, exclusiveValues, initialDraft, keyToIndex, rovingTabStop, toggleMulti, toggleMultiExclusive } from "./quiz-logic";

const q = (patch: Partial<QuestionView>): QuestionView => ({
  id: "q",
  prompt: "Q",
  kind: "single",
  options: [],
  optional: false,
  private: false,
  ...patch,
});

describe("quiz logic", () => {
  it("maps 1-9 to option indexes only", () => {
    expect(keyToIndex("1")).toBe(0);
    expect(keyToIndex("9")).toBe(8);
    expect(keyToIndex("0")).toBeNull();
    expect(keyToIndex("a")).toBeNull();
    expect(keyToIndex("12")).toBeNull();
  });

  it("toggles multi-select values within the limit", () => {
    expect(toggleMulti([], "a")).toEqual(["a"]);
    expect(toggleMulti(["a"], "a")).toEqual([]);
    expect(toggleMulti(["a", "b", "c"], "d", 3)).toEqual(["a", "b", "c"]);
    expect(toggleMulti(["a", "b"], "c", 3)).toEqual(["a", "b", "c"]);
  });

  it("treats 'not sure' style options as exclusive", () => {
    const ex = exclusiveValues(q({ kind: "multi", options: [{ value: "internships", label: "I" }, { value: "not_sure", label: "Not sure" }] }));
    expect([...ex]).toEqual(["not_sure"]);
    expect(toggleMultiExclusive(["internships"], "not_sure", ex)).toEqual(["not_sure"]);
    expect(toggleMultiExclusive(["not_sure"], "internships", ex)).toEqual(["internships"]);
    expect(toggleMultiExclusive(["not_sure"], "not_sure", ex)).toEqual([]);
  });

  it("prefers the quiz's named exclusive option", () => {
    const ex = exclusiveValues(q({ kind: "multi", exclusive: "none_yet", options: [{ value: "none_yet", label: "None" }, { value: "any", label: "Any" }] }));
    expect([...ex]).toEqual(["none_yet"]);
  });

  it("starts sliders at their default and accepts numbers", () => {
    const s = q({ kind: "slider", slider: { min: 1, max: 10, step: 1, defaultValue: 3, unit: "h" } });
    expect(initialDraft(s, undefined)).toBe(3);
    expect(canContinue(s, 3)).toBe(true);
    expect(canContinue(s, Number.NaN)).toBe(false);
  });

  it("knows when an answer can be submitted", () => {
    expect(canContinue(q({ kind: "multi" }), [])).toBe(false);
    expect(canContinue(q({ kind: "multi" }), ["a"])).toBe(true);
    expect(canContinue(q({ kind: "text" }), "  ")).toBe(false);
    expect(canContinue(q({ kind: "text" }), "Biology")).toBe(true);
    expect(canContinue(q({ kind: "single" }), "a")).toBe(true);
    expect(canContinue(q({ kind: "single" }), undefined)).toBe(false);
    expect(canContinue(q({ kind: "single" }), null)).toBe(false);
  });

  it("starts from the previous answer, then the resume prefill", () => {
    expect(initialDraft(q({ kind: "single", prefill: "first_year" }), undefined)).toBe("first_year");
    expect(initialDraft(q({ kind: "single", prefill: "first_year" }), "second_year")).toBe("second_year");
    expect(initialDraft(q({ kind: "multi", prefill: ["a", 3, "b"] }), undefined)).toEqual(["a", "b"]);
    expect(initialDraft(q({ kind: "multi" }), undefined)).toEqual([]);
    expect(initialDraft(q({ kind: "text" }), null)).toBeUndefined();
  });
});

describe("answer list keyboard", () => {
  it("moves focus with arrows, Home and End, wrapping at the ends", () => {
    expect(arrowTarget("ArrowDown", 0, 3)).toBe(1);
    expect(arrowTarget("ArrowRight", 2, 3)).toBe(0);
    expect(arrowTarget("ArrowUp", 0, 3)).toBe(2);
    expect(arrowTarget("ArrowLeft", 1, 3)).toBe(0);
    expect(arrowTarget("Home", 2, 3)).toBe(0);
    expect(arrowTarget("End", 0, 3)).toBe(2);
    // Focus not on an option yet: start from the first.
    expect(arrowTarget("ArrowDown", -1, 3)).toBe(1);
  });

  it("ignores other keys, including Backspace, which no longer goes back", () => {
    expect(arrowTarget("Backspace", 1, 3)).toBeNull();
    expect(arrowTarget("a", 1, 3)).toBeNull();
    expect(arrowTarget("ArrowDown", 0, 0)).toBeNull();
  });

  it("gives the radio group one tab stop: the chosen answer, else the first", () => {
    expect(rovingTabStop(["a", "b", "c"], "b")).toBe(1);
    expect(rovingTabStop(["a", "b", "c"], undefined)).toBe(0);
    expect(rovingTabStop(["a", "b", "c"], "zzz")).toBe(0);
    expect(rovingTabStop(["a", "b"], ["a"])).toBe(0);
  });
});
