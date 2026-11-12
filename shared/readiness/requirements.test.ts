import { describe, expect, it } from "vitest";
import { LEAD_TIME_TABLE } from "./config";
import {
  analyzeRequirement,
  effortDays,
  effortHoursFor,
  gapText,
  isolatedLatestStart,
  leadDaysFor,
  prepDays,
  progressMap,
  requirementQuantity,
  scheduleTasks,
  severityFor,
  targetLeadDaysFor,
  toChecklistItem,
  type AnalyzeContext,
  type RequirementLike,
} from "./requirements";
import { ChecklistItemSchema } from "../contracts/readiness";
import type { EligibilityResult } from "../contracts/eligibility";
import { REQUIREMENT_KINDS } from "../taxonomy";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const req = (kind: RequirementLike["kind"], extra: Partial<RequirementLike> = {}): RequirementLike => ({ id: id(1), kind, label: `Sample ${kind}`, ...extra });

const ctx = (extra: Partial<AnalyzeContext> = {}): AnalyzeContext => ({
  dueDate: "2027-01-15",
  campusScoped: false,
  nominationGated: false,
  ownDeadlineDates: new Map(),
  progress: new Map(),
  eligibility: null,
  hoursPerDay: 1,
  ...extra,
});

describe("lead-time table and the plan's formulas (7.4.2)", () => {
  it("has an entry for every RequirementKind, informational kinds without numbers", () => {
    for (const kind of REQUIREMENT_KINDS) expect(LEAD_TIME_TABLE[kind]).toBeDefined();
    expect(effortHoursFor(req("coursework"))).toBeNull();
    expect(leadDaysFor(req("gpa_floor"))).toBeNull();
  });

  it("counts effort per unit and lets Curators override effort and lead", () => {
    expect(effortHoursFor(req("recommendation", { quantity: 3 }))).toBe(3);
    expect(effortHoursFor(req("essay", { quantity: 2 }))).toBe(12);
    expect(effortHoursFor(req("essay", { effortHours: 4 }))).toBe(4);
    expect(leadDaysFor(req("recommendation", { leadTimeDays: 30 }))).toBe(30);
    expect(requirementQuantity(req("essay", { quantity: 2.6 }))).toBe(3);
    expect(requirementQuantity(req("essay", { quantity: Number.NaN }))).toBe(1);
  });

  it("S07-012 fixture: two letters need 23 days, so a 15 Jan deadline reads start by 23 Dec", () => {
    const letters = req("recommendation", { quantity: 2 });
    expect(prepDays([letters])).toBe(23);
    const a = analyzeRequirement(letters, ctx());
    expect(a.taskDue).toBe("2026-12-25");
    expect(a.isolatedLatestStart).toBe("2026-12-23");
  });

  it("prepDays is the max over curated items and null (never 0) when nothing is curated", () => {
    expect(prepDays([req("recommendation", { quantity: 2 }), req("test_score")])).toBe(40);
    expect(prepDays([])).toBeNull();
    expect(prepDays([req("coursework"), req("gpa_floor")])).toBeNull();
  });

  it("campus nomination runs to the campus deadline: no lead once the plan is campus-scoped", () => {
    expect(leadDaysFor(req("campus_nomination"), { campusScoped: true, nominationGated: true })).toBe(0);
    expect(leadDaysFor(req("campus_nomination"), { campusScoped: false, nominationGated: true })).toBe(70);
  });

  it("target leads are never shorter than hard leads; campus-reviewed essays get 21 days", () => {
    expect(targetLeadDaysFor(req("recommendation"), { campusScoped: false, nominationGated: false })).toBe(35);
    expect(targetLeadDaysFor(req("essay"), { campusScoped: true, nominationGated: true })).toBe(21);
    expect(targetLeadDaysFor(req("essay", { leadTimeDays: 30 }), { campusScoped: true, nominationGated: true })).toBe(30);
    for (const kind of REQUIREMENT_KINDS) {
      const hard = leadDaysFor(req(kind), { campusScoped: true, nominationGated: true });
      const target = targetLeadDaysFor(req(kind), { campusScoped: true, nominationGated: true });
      if (hard !== null) expect(target!).toBeGreaterThanOrEqual(hard);
    }
  });

  it("a quarter-hour item still takes a day", () => {
    expect(effortDays(0.25)).toBe(1);
    expect(effortDays(0)).toBe(0);
    expect(effortDays(3, 1)).toBe(3);
    expect(effortDays(3, 2)).toBe(2);
    expect(isolatedLatestStart("2027-01-15", 6)).toBe("2027-01-09");
  });

  it("severity: late after the start-by date, soon within 14 days, planned beyond", () => {
    expect(severityFor("2026-11-10", "2026-11-11")).toBe("late");
    expect(severityFor("2026-11-11", "2026-11-11")).toBe("soon");
    expect(severityFor("2026-11-25", "2026-11-11")).toBe("soon");
    expect(severityFor("2026-11-26", "2026-11-11")).toBe("planned");
  });
});

describe("gap analysis", () => {
  it("open gaps get a plain-words gap and dates; met items do not", () => {
    const letters = req("recommendation", { quantity: 3 });
    const gap = analyzeRequirement(letters, ctx());
    expect(gap.state).toBe("gap");
    expect(gap.gap).toBe("Ask three recommenders for letters");
    expect(gap.open).toBe(true);
    const met = analyzeRequirement(letters, ctx({ progress: progressMap([{ subjectKey: `req:${letters.id}`, state: "met" }]) }));
    expect(met.state).toBe("met");
    expect(met.gap).toBeNull();
    expect(met.open).toBe(false);
  });

  it("a résumé marked met once counts for every program (kind:resume)", () => {
    const resume = req("resume", { id: id(9) });
    const a = analyzeRequirement(resume, ctx({ progress: progressMap([{ subjectKey: "kind:resume", state: "met" }]) }));
    expect(a.state).toBe("met");
    // Letters are never reusable across programs.
    const letters = analyzeRequirement(req("recommendation"), ctx({ progress: progressMap([{ subjectKey: "kind:recommendation", state: "met" }]) }));
    expect(letters.state).toBe("gap");
  });

  it("a requirement's own earlier deadline wins (letters due before the application)", () => {
    const letters = req("recommendation", { deadlineId: id(50) });
    const a = analyzeRequirement(letters, ctx({ ownDeadlineDates: new Map([[id(50), "2027-01-05"]]) }));
    expect(a.baseDate).toBe("2027-01-05");
    expect(a.taskDue).toBe("2026-12-15");
  });

  it("GPA floors read the evaluator's GPA rules instead of re-deriving them", () => {
    const rule = (verdict: "met" | "not_met" | "unknown") =>
      ({ rules: [{ dimension: "gpa", verdict }] }) as unknown as EligibilityResult;
    expect(analyzeRequirement(req("gpa_floor"), ctx({ eligibility: rule("not_met") })).state).toBe("gap");
    expect(analyzeRequirement(req("gpa_floor"), ctx({ eligibility: rule("met") })).state).toBe("met");
    expect(analyzeRequirement(req("gpa_floor"), ctx()).state).toBe("unknown");
    expect(gapText(req("gpa_floor"), "gap")).toBe("Your GPA band is below this requirement");
  });

  it("interviews and coursework are informational: unknown and never scheduled", () => {
    const interview = analyzeRequirement(req("interview"), ctx());
    expect(interview.state).toBe("unknown");
    expect(interview.taskDue).toBeNull();
    expect(scheduleTasks([interview], "s")).toEqual([]);
  });

  it("checklist items validate against the contract and drop dates for closed cycles", () => {
    const a = analyzeRequirement(req("essay"), ctx());
    const open = toChecklistItem(a, { today: "2026-11-11", filledLatestStart: "2026-12-20", closed: false });
    expect(ChecklistItemSchema.parse(open).startBy).toBe("2026-12-20"); // min(isolated 26 Dec, filled 20 Dec)
    expect(open.severity).toBe("planned");
    const closed = toChecklistItem(a, { today: "2026-11-11", filledLatestStart: null, closed: true });
    expect(closed.severity).toBeNull();
    expect(scheduleTasks([a], "scope")).toEqual([{ id: `scope::${a.key}`, effortHours: 6, due: "2027-01-01" }]);
  });

  it("gap text exists for every kind and fits the contract", () => {
    for (const kind of REQUIREMENT_KINDS) {
      const text = gapText(req(kind, { quantity: 2 }), "gap");
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(300);
    }
  });
});
