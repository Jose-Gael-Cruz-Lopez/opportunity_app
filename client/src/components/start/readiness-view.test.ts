import { describe, expect, it } from "vitest";
import { FORBIDDEN_STUDENT_SCORE_FIELDS } from "@shared/contracts";
import { buildSamplePrograms } from "./fixtures";
import { buildReadinessView, daysBetween, eligibilityRows, evalLogic, requirementRows, ruleVerdict } from "./readiness-view";

const NOW = new Date("2026-11-11T15:00:00Z");
const samples = buildSamplePrograms(NOW);
const coastal = samples.find((s) => s.card.slug === "sample-coastal-data-fellowship")!;

describe("on-device JsonLogic subset", () => {
  it("evaluates in, ==, and, or, ! and comparisons", () => {
    expect(ruleVerdict({ in: [{ var: "classYear" }, ["first_year", "second_year"]] }, { classYear: "first_year" })).toBe("met");
    expect(ruleVerdict({ in: [{ var: "classYear" }, ["first_year"]] }, { classYear: "third_year" })).toBe("not_met");
    expect(ruleVerdict({ "==": [{ var: "a" }, 1] }, { a: 1 })).toBe("met");
    expect(ruleVerdict({ "!": [{ "==": [{ var: "a" }, 1] }] }, { a: 1 })).toBe("not_met");
    expect(ruleVerdict({ ">=": [{ var: "gpaMin" }, 3] }, { gpaMin: 3.25 })).toBe("met");
  });

  it("is three-valued: missing or 'prefer not' answers stay unknown, never met", () => {
    expect(ruleVerdict({ in: [{ var: "citizenship" }, ["us_citizen"]] }, {})).toBe("unknown");
    expect(ruleVerdict({ in: [{ var: "citizenship" }, ["us_citizen"]] }, { citizenship: "prefer_not" })).toBe("unknown");
    // and: a false operand decides; or: a true operand decides, even next to unknown
    expect(ruleVerdict({ and: [{ var: "x" }, false] }, {})).toBe("not_met");
    expect(ruleVerdict({ or: [{ var: "x" }, true] }, {})).toBe("met");
    expect(ruleVerdict({ and: [{ var: "x" }, true] }, {})).toBe("unknown");
  });

  it("returns unknown for operators outside the subset", () => {
    expect(ruleVerdict({ substr: ["abc", 1] }, {})).toBe("unknown");
    expect(ruleVerdict({ a: 1, b: 2 }, {})).toBe("unknown");
    expect(evalLogic(5, {})).toBe(5);
  });
});

describe("eligibility rows", () => {
  it("checks standing from the quiz and citizenship from private memory", () => {
    const before = eligibilityRows(coastal.card.rules, "first_year", {});
    expect(before.map((r) => [r.id, r.verdict, r.private, r.needs])).toEqual([
      ["standing.early", "met", false, []],
      ["citizenship.us", "unknown", true, ["citizenship"]],
    ]);
    const after = eligibilityRows(coastal.card.rules, "first_year", { citizenship: "permanent_resident" });
    expect(after[1].verdict).toBe("met");
    expect(after[1].needs).toEqual([]);
    expect(eligibilityRows(coastal.card.rules, "first_year", { citizenship: "f1" })[1].verdict).toBe("not_met");
  });

  it("returns no rows when a program has no rule set", () => {
    expect(eligibilityRows(null, "first_year", {})).toEqual([]);
  });
});

describe("requirements and the full view", () => {
  it("schedules each requirement backward from the deadline", () => {
    const rows = requirementRows(coastal.requirements, "2026-12-26", "2026-11-11", true);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]));
    expect(byKind.resume.state).toBe("met");
    expect(byKind.resume.startBy).toBeNull();
    // letter: 21 days lead + 1 day effort
    expect(byKind.recommendation.startBy).toBe("2026-12-04");
    expect(byKind.recommendation.severity).toBe("planned");
    // essay: 3 h at one hour a day
    expect(byKind.essay.startBy).toBe("2026-12-23");
  });

  it("flags late and soon start dates", () => {
    const rows = requirementRows(coastal.requirements, "2026-11-20", "2026-11-11", false);
    const letter = rows.find((r) => r.kind === "recommendation")!;
    expect(letter.severity).toBe("late");
    const essay = rows.find((r) => r.kind === "essay")!;
    expect(essay.severity).toBe("soon");
  });

  it("counts days between ISO dates", () => {
    expect(daysBetween("2026-11-11", "2026-12-02")).toBe(21);
    expect(daysBetween("2026-12-02", "2026-11-11")).toBe(-21);
  });

  it("builds four parts with no score anywhere", () => {
    const view = buildReadinessView({
      rules: coastal.card.rules,
      requirements: coastal.requirements,
      deadline: coastal.card.deadlines[0].localDate,
      today: "2026-11-11",
      classYear: "first_year",
      privateAnswers: {},
      haveResume: false,
      steps: [
        { id: "save", title: "Save", kind: "save", minutes: 1, due: null, doneDuringOnboarding: true },
        { id: "submit", title: "Submit", kind: "submit", minutes: 15, due: "2026-12-24", doneDuringOnboarding: false },
      ],
      doneStepIds: new Set(["save"]),
    });
    expect(Object.keys(view)).toEqual(["eligibility", "requirements", "competitiveness", "nextActions"]);
    expect(view.eligibility.status).toBe("check");
    expect(view.requirements).toMatchObject({ met: 0, total: 3 });
    expect(view.competitiveness.status).toBe("insufficient_data");
    expect(view.nextActions.map((a) => a.id)).toEqual(["submit"]);
    const keys = JSON.stringify(view).match(/"[A-Za-z]+":/g)!.map((k) => k.slice(1, -2));
    for (const f of FORBIDDEN_STUDENT_SCORE_FIELDS) expect(keys).not.toContain(f);
    expect(JSON.stringify(view)).not.toMatch(/\d+(\.\d+)?\s*%/);
  });

  it("never repeats a private answer in its output", () => {
    const view = buildReadinessView({
      rules: coastal.card.rules,
      requirements: [],
      deadline: null,
      today: "2026-11-11",
      classYear: "first_year",
      privateAnswers: { citizenship: "daca" },
      haveResume: true,
      steps: [],
      doneStepIds: new Set(),
    });
    expect(view.eligibility.status).toBe("not_eligible");
    expect(JSON.stringify(view)).not.toContain("daca");
  });
});
