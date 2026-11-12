import { describe, expect, it } from "vitest";
import {
  groupByTier,
  normalizeFirstDoor,
  normalizeMatchItem,
  normalizeMatchSet,
  normalizePlan,
  normalizePlanMeta,
  normalizeQuestion,
  normalizeQuizSpec,
  quickSteps,
} from "./normalize";

describe("normalizeQuestion", () => {
  it("reads the agreed shape", () => {
    const q = normalizeQuestion({
      id: "looking_for",
      prompt: "What are you looking for?",
      kind: "multi",
      max: 3,
      options: [{ value: "internships", label: "Internships", hint: "Paid work" }, "research"],
    });
    expect(q).toEqual({
      id: "looking_for",
      prompt: "What are you looking for?",
      help: undefined,
      kind: "multi",
      options: [
        { value: "internships", label: "Internships", hint: "Paid work" },
        { value: "research", label: "research" },
      ],
      max: 3,
      optional: false,
      private: false,
      prefill: undefined,
    });
  });

  it("accepts common synonyms and infers the kind", () => {
    const q = normalizeQuestion({ key: "pay", title: "Pay?", type: "radio", choices: [{ id: "paid", text: "Must be paid" }], skippable: true });
    expect(q?.kind).toBe("single");
    expect(q?.options[0]).toEqual({ value: "paid", label: "Must be paid", hint: undefined });
    expect(q?.optional).toBe(true);
    expect(normalizeQuestion({ id: "x", prompt: "Pick", maxSelections: 2, options: ["a"] })?.kind).toBe("multi");
    expect(normalizeQuestion({ id: "school", prompt: "School?", kind: "typeahead" })?.kind).toBe("text");
    expect(normalizeQuestion({ id: "pair_style", prompt: "Which?", kind: "this_or_that", options: ["a", "b"] })?.kind).toBe("pair");
    expect(normalizeQuestion({ id: "r", prompt: "Resume", kind: "upload" })?.kind).toBe("resume");
  });

  it("unwraps nextQuestion results: suggested value, per-student options and progress", () => {
    const q = normalizeQuestion({
      question: { id: "skills", kind: "multi", prompt: "Which skills?", options: [{ value: "excel", label: "Excel" }], prefill: "skills", maxSelections: 12 },
      mode: "confirm",
      suggested: ["python"],
      options: [{ value: "python", label: "Python", hint: "From your resume" }, { value: "excel", label: "Excel" }],
      progress: { step: 5, of: 12 },
    });
    expect(q?.id).toBe("skills");
    expect(q?.prefill).toEqual(["python"]);
    expect(q?.options.map((o) => o.value)).toEqual(["python", "excel"]);
    expect(q?.options[0].hint).toBe("From your resume");
    expect(q?.progress).toEqual({ step: 5, of: 12 });
  });

  it("does not read a bare question's prefill source tag as a value", () => {
    expect(normalizeQuestion({ id: "class_year", prompt: "Year?", prefill: "classYear", options: ["first_year"] })?.prefill).toBeUndefined();
  });

  it("reads sliders, exclusive options and short text limits", () => {
    const slider = normalizeQuestion({ id: "weekly_hours", kind: "slider", prompt: "Hours?", slider: { min: 1, max: 10, step: 1, defaultValue: 3, unit: "h a week", maxLabel: "10+" }, optional: true });
    expect(slider?.kind).toBe("slider");
    expect(slider?.slider).toEqual({ min: 1, max: 10, step: 1, defaultValue: 3, unit: "h a week", maxLabel: "10+" });
    expect(normalizeQuestion({ id: "s", kind: "slider", prompt: "x", slider: { min: 5, max: 1 } })?.slider).toBeUndefined();
    const multi = normalizeQuestion({ id: "looking_for", kind: "multi", prompt: "x", exclusiveOption: "not_sure", options: ["a", "not_sure"] });
    expect(multi?.exclusive).toBe("not_sure");
    const text = normalizeQuestion({ id: "target", kind: "short_text", prompt: "x", maxLength: 80, placeholder: "e.g.", deviceOnly: true });
    expect(text).toMatchObject({ kind: "text", maxLength: 80, placeholder: "e.g.", private: true });
  });

  it("marks private questions and rejects incomplete ones", () => {
    expect(normalizeQuestion({ id: "o2", prompt: "Private", sensitive: true })?.private).toBe(true);
    expect(normalizeQuestion({ prompt: "no id" })).toBeNull();
    expect(normalizeQuestion(null)).toBeNull();
    expect(normalizeQuestion("q")).toBeNull();
  });

  it("reads a spec object or a bare array", () => {
    const qs = [{ id: "a", prompt: "A" }, { bad: true }, { id: "b", prompt: "B" }];
    expect(normalizeQuizSpec({ questions: qs }).map((q) => q.id)).toEqual(["a", "b"]);
    expect(normalizeQuizSpec(qs)).toHaveLength(2);
    expect(normalizeQuizSpec(undefined)).toEqual([]);
  });
});

describe("normalizeMatchItem", () => {
  const item = {
    programId: "p1",
    tier: "strong",
    reasons: ["Matches your interest in climate", "Uses Python from your resume"],
    feasibility: { startBy: "2026-12-02", daysLeft: 45, enoughTime: true, label: "Start by Dec 2 · about 3 h of prep" },
    requirementsMet: { met: 3, total: 5 },
    missing: ["One letter of recommendation"],
    evidence: ["Open to first-years"],
    name: "Sample A",
    organizationName: "Sample Org",
  };

  it("keeps tiers, reasons and counts", () => {
    expect(normalizeMatchItem(item)).toEqual({
      programId: "p1",
      tier: "strong",
      reasons: item.reasons,
      startBy: "2026-12-02",
      daysLeft: 45,
      enoughTime: true,
      met: 3,
      total: 5,
      missing: ["One letter of recommendation"],
      feasibilityLabel: "Start by Dec 2 · about 3 h of prep",
      evidence: ["Open to first-years"],
      name: "Sample A",
      organizationName: "Sample Org",
    });
  });

  it("never carries a numeric score through, even if the engine adds one (rule 4)", () => {
    const v = normalizeMatchItem({ ...item, score: 0.93, fitScore: 87, rrf: 0.03 }) as unknown as Record<string, unknown>;
    for (const key of ["score", "fitScore", "rrf", "matchPercent", "probability"]) expect(v[key]).toBeUndefined();
    expect(Object.values(v).some((x) => typeof x === "number" && !Number.isInteger(x))).toBe(false);
  });

  it("repairs odd values", () => {
    const v = normalizeMatchItem({ programId: "p2", tier: "excellent", requirementsMet: { met: 4, total: 2 }, feasibility: {} });
    expect(v?.tier).toBe("stretch");
    expect(v?.total).toBe(4);
    expect(v?.startBy).toBeNull();
    expect(v?.enoughTime).toBe(true);
    expect(normalizeMatchItem({ tier: "good" })).toBeNull();
  });

  it("reads a MatchSet and groups by tier in order", () => {
    const views = normalizeMatchSet({
      items: [
        { programId: "a", tier: "good" },
        { programId: "b", tier: "strong" },
        { programId: "c", tier: "good" },
      ],
    });
    expect(views.map((v) => v.programId)).toEqual(["a", "b", "c"]);
    const g = groupByTier(views);
    expect(g.strong.map((v) => v.programId)).toEqual(["b"]);
    expect(g.good.map((v) => v.programId)).toEqual(["a", "c"]);
    expect(normalizeMatchSet(null)).toEqual([]);
  });
});

describe("first door and plan", () => {
  it("reads up to three distinct options with rationales", () => {
    const doors = normalizeFirstDoor({
      options: [
        { programId: "a", rationale: "Quickest to start" },
        { programId: "a", rationale: "dup" },
        { programId: "b", reason: "Best match for your interests" },
        { match: { programId: "c" } },
        { programId: "d", rationale: "fourth" },
      ],
    });
    expect(doors).toEqual([
      { programId: "a", rationale: "Quickest to start" },
      { programId: "b", rationale: "Best match for your interests" },
      { programId: "c", rationale: "A good place to start" },
    ]);
  });

  it("reads plan steps and the quick ones", () => {
    const steps = normalizePlan({
      steps: [
        { id: "save", title: "Save to Tracker", kind: "save", minutes: 1, doneDuringOnboarding: true },
        { id: "letters", title: "Ask for a letter", kind: "letters", minutes: 10, due: "2026-12-01" },
        { title: "no id" },
      ],
    });
    expect(steps).toHaveLength(2);
    expect(steps[1]).toEqual({ id: "letters", title: "Ask for a letter", kind: "letters", minutes: 10, due: "2026-12-01", doneDuringOnboarding: false });
    expect(quickSteps(steps).map((s) => s.id)).toEqual(["save"]);
  });

  it("keeps the planner's detail, safe url and late flag", () => {
    const [open, bad] = normalizePlan({
      steps: [
        { id: "open_application", title: "Bookmark the official page", kind: "open_application", minutes: 3, url: "https://example.org/apply", detail: "Applications are not open yet; they open 2027-01-05.", late: true },
        { id: "x", title: "X", kind: "other", minutes: 1, url: "javascript:alert(1)" },
      ],
    });
    expect(open).toMatchObject({ url: "https://example.org/apply", detail: "Applications are not open yet; they open 2027-01-05.", late: true });
    expect(bad?.url).toBeUndefined();
  });

  it("reads the plan's draft template and missing keywords", () => {
    expect(normalizePlanMeta({ draft: { template: "I want to [x]." }, missingKeywords: ["SQL"] })).toEqual({ draftTemplate: "I want to [x].", missingKeywords: ["SQL"] });
    expect(normalizePlanMeta(null)).toEqual({ draftTemplate: null, missingKeywords: [] });
  });
});
