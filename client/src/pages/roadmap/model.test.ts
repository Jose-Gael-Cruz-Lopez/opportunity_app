import { describe, expect, it } from "vitest";
import { ItemKeySchema, NextActionSchema, RoadmapSchema, type Roadmap, type RoadmapItem } from "@shared/contracts";
import { FORBIDDEN_STUDENT_SCORE_FIELDS } from "@shared/contracts";
import { sampleNextActions, sampleRoadmap } from "./fixtures";
import {
  academicYearLabel,
  academicYearOfTerm,
  applyActionToRoadmap,
  buildPlan,
  itemDateLine,
  itemTone,
  layoutYears,
  nextActionItemKey,
  nextDeadline,
  planStats,
  requirementSubject,
  termKeyFor,
  thisSeason,
  toggleAction,
  yearOfStudy,
  type NextActionContext,
} from "./model";

const TODAY = "2026-11-11";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function item(over: Partial<RoadmapItem> & Pick<RoadmapItem, "itemKey" | "term">): RoadmapItem {
  return {
    kind: "apply",
    title: over.itemKey,
    detail: null,
    programId: null,
    programSlug: null,
    programCycleId: null,
    cycleKey: null,
    dueOn: null,
    startBy: null,
    dateConfidence: "official",
    state: "open",
    pinned: false,
    reasonCodes: [],
    source: "rule",
    ...over,
  };
}

function roadmapOf(items: RoadmapItem[]): Roadmap {
  const terms = new Map<string, Roadmap["terms"][number]>();
  for (const i of items) {
    const t = terms.get(i.term) ?? { term: i.term, apply: [], prepare: [], milestones: [], more: 0, capacityWarning: null };
    (i.kind === "apply" ? t.apply : i.kind === "prepare" ? t.prepare : t.milestones).push(i);
    terms.set(i.term, t);
  }
  return { generatedAt: "2026-11-11T12:00:00Z", algoVersion: "test", templateKey: null, terms: [...terms.values()], changedSinceLastVisit: [] };
}

describe("academic years", () => {
  it("puts fall in its own year and later seasons in the year before", () => {
    expect(academicYearOfTerm("fall-2026")).toBe(2026);
    expect(academicYearOfTerm("winter-2027")).toBe(2026);
    expect(academicYearOfTerm("spring-2027")).toBe(2026);
    expect(academicYearOfTerm("summer-2027")).toBe(2026);
    expect(termKeyFor(2026, "spring")).toBe("spring-2027");
    expect(termKeyFor(2026, "fall")).toBe("fall-2026");
    expect(academicYearLabel(2026)).toBe("2026–27");
    expect(academicYearLabel(2099)).toBe("2099–00");
  });

  it("numbers years of study from the class year", () => {
    expect(yearOfStudy(2026, "second_year", TODAY)).toBe(2);
    expect(yearOfStudy(2025, "second_year", TODAY)).toBe(1);
    expect(yearOfStudy(2028, "second_year", TODAY)).toBe(4);
    expect(yearOfStudy(2026, "first_year", TODAY)).toBe(1);
    expect(yearOfStudy(2027, "incoming_first_year", TODAY)).toBe(1);
    expect(yearOfStudy(2026, "graduate", TODAY)).toBeNull();
    expect(yearOfStudy(2026, null, TODAY)).toBeNull();
  });
});

describe("item tone and dates", () => {
  it("marks soon, due, planned, done and missed", () => {
    expect(itemTone(item({ itemKey: "apply:a", term: "fall-2026", dueOn: "2026-11-20" }), TODAY)).toBe("soon");
    expect(itemTone(item({ itemKey: "apply:a", term: "spring-2027", dueOn: "2027-01-28" }), TODAY)).toBe("due");
    expect(itemTone(item({ itemKey: "ms:a", term: "spring-2027", kind: "milestone" }), TODAY)).toBe("plan");
    expect(itemTone(item({ itemKey: "apply:a", term: "fall-2026", dueOn: "2026-11-01" }), TODAY)).toBe("missed");
    expect(itemTone(item({ itemKey: "apply:a", term: "fall-2026", state: "done", dueOn: "2026-11-01" }), TODAY)).toBe("done");
    // Start-by drives "soon" even when the due date is far away.
    expect(itemTone(item({ itemKey: "prep:a", term: "fall-2026", kind: "prepare", startBy: "2026-11-15", dueOn: "2027-01-10" }), TODAY)).toBe("soon");
  });

  it("says how sure a date is", () => {
    expect(itemDateLine(item({ itemKey: "apply:a", term: "spring-2027", dueOn: "2027-01-28", dateConfidence: "expected" }))).toBe(
      "Due 28 Jan (expected; may change)",
    );
    expect(itemDateLine(item({ itemKey: "ms:a", term: "spring-2027", kind: "milestone" }))).toBeNull();
  });
});

describe("next actions", () => {
  const ctx: NextActionContext = {
    programCycleId: ID(1),
    programSlug: "sample-program",
    programName: "Sample Program",
    cycleKey: "spring-2027",
    actions: [
      { id: "essay", label: "Draft the essay", detail: null, dueOn: "2026-12-01", severity: "soon", source: "gap", roadmapItemKey: null, relatesTo: "kind:essay" },
      { id: "linked", label: "Ask for letters", detail: null, dueOn: "2026-11-20", severity: "soon", source: "gap", roadmapItemKey: "prep:letters", relatesTo: null },
      { id: "undated", label: "Check the campus deadline", detail: null, dueOn: null, severity: null, source: "nomination", roadmapItemKey: null, relatesTo: null },
    ],
  };

  it("adds unlinked actions as prepare items in the right term and skips linked ones", () => {
    const roadmap = roadmapOf([item({ itemKey: "prep:letters", term: "fall-2026", kind: "prepare", dueOn: "2026-11-20" })]);
    const plan = buildPlan(roadmap, [ctx], TODAY);
    const all = plan.terms.flatMap((t) => t.items);
    expect(all.map((i) => i.itemKey).sort()).toEqual(
      ["prep:letters", nextActionItemKey(ID(1), "essay"), nextActionItemKey(ID(1), "undated")].sort(),
    );
    const essay = all.find((i) => i.title === "Draft the essay");
    expect(essay?.term).toBe("fall-2026");
    expect(essay?.origin).toBe("next_action");
    expect(essay?.relatesTo).toBe("kind:essay");
    expect(essay?.dateConfidence).toBe("estimated");
    expect(all.find((i) => i.title === "Check the campus deadline")?.dateConfidence).toBe("unknown");
  });

  it("is idempotent when the same contexts are merged twice", () => {
    const plan = buildPlan(roadmapOf([]), [ctx, ctx], TODAY);
    expect(plan.terms.flatMap((t) => t.items)).toHaveLength(3);
  });

  it("builds keys the roadmap contract accepts", () => {
    expect(ItemKeySchema.safeParse(nextActionItemKey(ID(1), "essay")).success).toBe(true);
    expect(ItemKeySchema.safeParse(nextActionItemKey(ID(1), "weird id/with spaces?")).success).toBe(true);
    expect(ItemKeySchema.safeParse(nextActionItemKey(ID(1), "x".repeat(200))).success).toBe(true);
  });

  it("completes through requirement progress only for checklist subjects", () => {
    expect(requirementSubject("kind:essay")).toBe("kind:essay");
    expect(requirementSubject(`req:${ID(9)}`)).toBe(`req:${ID(9)}`);
    expect(requirementSubject("rule:citizenship")).toBeNull();
    expect(requirementSubject(null)).toBeNull();
  });
});

describe("layout", () => {
  const roadmap = roadmapOf([
    item({ itemKey: "ms:y1", term: "fall-2025", kind: "milestone", state: "done" }),
    item({ itemKey: "apply:now", term: "fall-2026", dueOn: "2026-11-20", pinned: true }),
    item({ itemKey: "apply:later", term: "spring-2027", dueOn: "2027-02-01" }),
    item({ itemKey: "prep:start", term: "spring-2027", kind: "prepare", startBy: "2026-11-25", dueOn: "2027-01-10" }),
    item({ itemKey: "ms:y4", term: "spring-2029", kind: "milestone" }),
  ]);
  const plan = buildPlan(roadmap, [], TODAY);

  it("lays out every academic year from the first to the last, three seasons without winter", () => {
    const years = layoutYears(plan, { today: TODAY, classYear: "second_year" });
    expect(years.map((y) => y.startYear)).toEqual([2025, 2026, 2027, 2028]);
    expect(years.map((y) => y.yearOfStudy)).toEqual([1, 2, 3, 4]);
    expect(years[1]?.seasons.map((s) => s.season)).toEqual(["fall", "spring", "summer"]);
    expect(years[0]?.isPast).toBe(true);
    const now = years.flatMap((y) => y.seasons).filter((s) => s.isNow);
    expect(now.map((s) => s.term)).toEqual(["fall-2026"]);
  });

  it("shows winter when the plan has a winter term", () => {
    const withWinter = buildPlan(roadmapOf([item({ itemKey: "apply:w", term: "winter-2027", dueOn: "2027-01-05" })]), [], TODAY);
    const years = layoutYears(withWinter, { today: TODAY, classYear: null });
    expect(years[0]?.seasons.map((s) => s.season)).toEqual(["fall", "winter", "spring", "summer"]);
  });

  it("picks this season's items: current term, pinned, and work starting soon", () => {
    expect(thisSeason(plan, TODAY).map((i) => i.itemKey)).toEqual(["apply:now", "prep:start"]);
  });

  it("counts tasks and finds the next deadline", () => {
    expect(planStats(plan, TODAY)).toEqual({ openThisSeason: 1, doneThisSeason: 0, dueWithin30: 1, pinned: 1 });
    expect(nextDeadline(plan, TODAY)?.itemKey).toBe("apply:now");
  });

  it("returns no rows for an empty plan", () => {
    expect(layoutYears(buildPlan(roadmapOf([]), [], TODAY), { today: TODAY, classYear: null })).toEqual([]);
  });
});

describe("actions", () => {
  it("applies pin, dismiss, complete and their reverses", () => {
    let r = roadmapOf([item({ itemKey: "apply:a", term: "fall-2026", pinned: true })]);
    const get = () => r.terms[0]?.apply[0];
    r = applyActionToRoadmap(r, "apply:a", "complete");
    expect(get()?.state).toBe("done");
    expect(toggleAction(get() as RoadmapItem)).toBe("reopen");
    r = applyActionToRoadmap(r, "apply:a", "reopen");
    r = applyActionToRoadmap(r, "apply:a", "dismiss");
    expect(get()).toMatchObject({ state: "dismissed", pinned: false });
    r = applyActionToRoadmap(r, "apply:a", "restore");
    r = applyActionToRoadmap(r, "apply:a", "pin");
    expect(get()).toMatchObject({ state: "open", pinned: true });
    r = applyActionToRoadmap(r, "apply:other", "unpin");
    expect(get()?.pinned).toBe(true);
  });
});

describe("sample data", () => {
  it("matches the roadmap and next-action contracts", () => {
    const parsed = RoadmapSchema.safeParse(sampleRoadmap(TODAY));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    for (const ctx of sampleNextActions(TODAY)) for (const a of ctx.actions) expect(NextActionSchema.safeParse(a).success).toBe(true);
  });

  it("names only invented sample programs and carries no score field", () => {
    const json = JSON.stringify([sampleRoadmap(TODAY), sampleNextActions(TODAY)]);
    for (const m of json.matchAll(/"programSlug":"([^"]+)"/g)) expect(m[1]).toMatch(/^sample-/);
    for (const field of FORBIDDEN_STUDENT_SCORE_FIELDS) expect(json).not.toContain(`"${field}"`);
  });

  it("builds a plan that spans four years for a second-year student", () => {
    const plan = buildPlan(sampleRoadmap(TODAY), sampleNextActions(TODAY), TODAY);
    const years = layoutYears(plan, { today: TODAY, classYear: "second_year" });
    expect(years.map((y) => y.yearOfStudy)).toEqual([1, 2, 3, 4]);
    expect(thisSeason(plan, TODAY).length).toBeGreaterThan(0);
  });
});
