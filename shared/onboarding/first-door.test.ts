import { describe, expect, it } from "vitest";
import { ProgramCycleSchema, ProgramSchema, RequirementSchema, type Program, type ProgramCycle, type Requirement } from "../contracts/registry";
import { RoadmapItemSchema } from "../contracts/roadmap";
import { addDays } from "../time/iso";
import { FirstDoorClosedError, pickFirstDoor, planFirstApplication, planReminders, planToRoadmapItems } from "./first-door";
import { findMatches } from "./match";
import { SAMPLE_PERSONAS, buildSamplePrograms, runPersona } from "./sample";
import type { PrepModel } from "./schedule";
import { makeCard, makePreferences } from "./testing";
import { FirstApplicationPlanSchema, FirstDoorChoiceSchema, type OnboardingProgram } from "./types";

const NOW = "2026-11-11T15:00:00Z";
const TODAY = "2026-11-11";
const programs = buildSamplePrograms(NOW);
const bySlug = (slug: string): OnboardingProgram => programs.find((p) => p.slug === slug) as OnboardingProgram;

function personaMatches(id: string) {
  const persona = SAMPLE_PERSONAS.find((p) => p.id === id)!;
  const run = runPersona(persona, { now: NOW, programs });
  return { persona, prefs: run.preferences, set: findMatches({ preferences: run.preferences, signals: persona.signals, programs, now: NOW }) };
}

describe("pickFirstDoor", () => {
  it("offers up to three feasible options with one-line rationales and never pre-selects", () => {
    const { prefs, set } = personaMatches("maya");
    const door = pickFirstDoor(set, prefs, NOW);
    expect(FirstDoorChoiceSchema.parse(door)).toEqual(door);
    expect(door.options.length).toBe(3);
    expect(new Set(door.options.map((o) => o.programId)).size).toBe(3);
    for (const o of door.options) {
      expect(o.feasibility.enoughTime).toBe(true);
      expect(o.rationale.length).toBeGreaterThan(0);
      expect(o.firstStep.minutes).toBeLessThanOrEqual(30);
    }
    expect(JSON.stringify(door)).not.toMatch(/selected|chosen|default/i);
  });

  it("always includes the best match, and shows the quickest first for 'get my first yes'", () => {
    const { prefs, set } = personaMatches("maya");
    const door = pickFirstDoor(set, prefs, NOW);
    expect(door.options.some((o) => o.slug === "sample-civic-data-internship" && o.role === "best_match")).toBe(true);
    expect(door.options[0]?.role).toBe("quickest");
  });

  it("puts the program the student named first", () => {
    const { prefs, set } = personaMatches("chris");
    const door = pickFirstDoor(set, prefs, NOW);
    expect(door.options[0]).toMatchObject({ role: "named", slug: "sample-public-policy-fellows", rationale: "The one you named" });
  });

  it("says 'quickest' only when it is true", () => {
    for (const persona of SAMPLE_PERSONAS) {
      const { prefs, set } = personaMatches(persona.id);
      const door = pickFirstDoor(set, prefs, NOW);
      const quick = door.options.find((o) => o.role === "quickest");
      if (!quick) continue;
      const hours = (slug: string) => {
        const item = set.items.find((i) => i.slug === slug)!;
        return item.prep.hours ?? item.feasibility.prepDays ?? Infinity;
      };
      for (const o of door.options) if (o !== quick) expect(hours(quick.slug)).toBeLessThanOrEqual(hours(o.slug));
    }
  });

  it("skips tight and community-specific programs while others exist", () => {
    for (const persona of SAMPLE_PERSONAS) {
      const { prefs, set } = personaMatches(persona.id);
      const door = pickFirstDoor(set, prefs, NOW);
      const general = set.items.some((i) => i.feasibility.enoughTime && !i.audience.identity);
      for (const o of door.options) {
        expect(o.feasibility.enoughTime).toBe(true);
        if (general) expect(set.items.find((i) => i.programId === o.programId)?.audience.identity).toBe(false);
      }
    }
  });

  it("returns an empty, honest choice when nothing is feasible", () => {
    const door = pickFirstDoor({ ...personaMatches("maya").set, items: [] }, makePreferences(), NOW);
    expect(door.options).toEqual([]);
    expect(door.fallback).toBe(true);
  });

  it("calls an option 'a different direction' only when it is another kind of opportunity", () => {
    for (const persona of SAMPLE_PERSONAS) {
      const { prefs, set } = personaMatches(persona.id);
      const door = pickFirstDoor(set, prefs, NOW);
      const different = door.options.find((o) => o.rationale === "A different direction worth a look");
      if (!different) continue;
      const cats = (id: string) => set.items.find((i) => i.programId === id)?.categories ?? [];
      const others = new Set(door.options.filter((o) => o !== different).flatMap((o) => cats(o.programId)));
      expect(cats(different.programId).some((c) => !others.has(c))).toBe(true);
    }
    const internshipsOnly = makePreferences({ categories: ["internships"], opportunityTypes: ["summer_internship"], classYear: "first_year" });
    const door = pickFirstDoor(findMatches({ preferences: internshipsOnly, programs, now: NOW }), internshipsOnly, NOW);
    expect(door.options.some((o) => o.rationale === "A different direction worth a look")).toBe(false);
  });

  it("backs every 'best match' line with the card's own evidence", () => {
    const { prefs, set } = personaMatches("maya");
    expect(pickFirstDoor(set, prefs, NOW).options.find((o) => o.role === "best_match")?.rationale).toBe("Best match for your interests");
    // A student who skipped everything gets picks to explore, never "the best match for your interests".
    const nothing = makePreferences();
    const explore = pickFirstDoor(findMatches({ preferences: nothing, programs, now: NOW }), nothing, NOW);
    expect(explore.options.length).toBeGreaterThan(0);
    for (const o of explore.options) expect(o.rationale).not.toMatch(/your interests|your skills|your major/);
  });
});

describe("planFirstApplication", () => {
  const civic = bySlug("sample-civic-data-internship");

  it("builds micro-steps for now and dated steps scheduled backward from the deadline", () => {
    const plan = planFirstApplication({
      program: civic,
      requirements: [{ kind: "resume" }, { kind: "essay" }, { kind: "recommendation", quantity: 2 }],
      signals: { skills: ["Python"] },
      preferences: makePreferences({ classYear: "first_year", majorFamily: "computing", interests: ["ai_data"], skills: ["python"] }),
      now: NOW,
    });
    expect(FirstApplicationPlanSchema.parse(plan)).toEqual(plan);
    const ids = plan.steps.map((s) => s.id);
    expect(ids.slice(0, 3)).toEqual(["save", "eligibility", "draft"]);
    expect(ids).toEqual(expect.arrayContaining(["recommenders", "reminder", "open_application"]));
    expect(ids[ids.length - 1]).toBe("submit");
    expect(plan.doableNow).toBe(3);
    for (const s of plan.steps.slice(0, 3)) expect(s.doneDuringOnboarding).toBe(true);
    // Only the quick steps count toward the five minutes; everything after them is dated.
    for (const s of plan.steps.slice(3)) {
      expect(s.doneDuringOnboarding).toBeUndefined();
      expect(s.due).toBeDefined();
    }
    const quickMinutes = plan.steps.filter((s) => s.doneDuringOnboarding).reduce((n, s) => n + s.minutes, 0);
    expect(quickMinutes).toBeLessThanOrEqual(4);

    const deadline = addDays(TODAY, 40);
    expect(plan.deadline).toBe(deadline);
    const letters = plan.steps.find((s) => s.id === "letters");
    expect(letters?.due).toBe(addDays(deadline, -23)); // 21 days of lead plus one hour per letter
    expect(plan.steps.find((s) => s.id === "submit")?.due).toBe(addDays(deadline, -2));
    expect(plan.steps.find((s) => s.id === "resume")?.due).toBe(addDays(TODAY, 3));
    expect(plan.startBy).toBe(addDays(deadline, -23));
  });

  it("never dates a step before today and marks late steps", () => {
    const tight = bySlug("sample-ai-research-experience"); // due in 20 days, two letters need 23
    const plan = planFirstApplication({ program: tight, requirements: tight.extras?.requirements ?? [], now: NOW });
    for (const s of plan.steps) if (s.due) expect(s.due >= TODAY).toBe(true);
    expect(plan.steps.find((s) => s.id === "letters")).toMatchObject({ due: TODAY, late: true });
    for (const s of plan.steps) if (s.due && plan.deadline) expect(s.due <= plan.deadline).toBe(true);
  });

  it("drafts two sentences from labels only, with AI off unless available and consented", () => {
    const plan = planFirstApplication({
      program: civic,
      requirements: [{ kind: "essay" }],
      signals: { skills: ["Python", "SQL"] },
      preferences: makePreferences({ classYear: "first_year", majorFamily: "computing", interests: ["ai_data"] }),
      now: NOW,
    });
    expect(plan.draft.template).toContain("I'm a first-year computing student who wants to work on AI and data");
    expect(plan.draft.template).toContain("Python and SQL");
    expect(plan.draft.template).toContain(civic.name);
    expect(plan.draft.ai).toBe("off");
    expect(planFirstApplication({ program: civic, requirements: [], now: NOW, ai: { available: true } }).draft.ai).toBe("off");
    expect(planFirstApplication({ program: civic, requirements: [], now: NOW, ai: { available: true, consented: true } }).draft.ai).toBe("on");
  });

  it("asks for the requirement list when Novus has not checked it, and handles rolling admission", () => {
    const rolling = makeCard({ today: TODAY, deadlineIn: "rolling" });
    const plan = planFirstApplication({ program: rolling, requirements: [], now: NOW });
    expect(plan.deadline).toBeNull();
    expect(plan.deadlineBasis).toBe("rolling");
    expect(plan.steps.some((s) => s.id === "list_requirements")).toBe(true);
    expect(plan.steps.find((s) => s.id === "submit")?.detail).toBe("Rolling admission: earlier is better.");
  });

  it("adds the campus step for nomination-gated programs and keeps community programs on the device", () => {
    const nominated = bySlug("sample-goldfinch-science-scholarship");
    const plan = planFirstApplication({ program: nominated, requirements: nominated.extras?.requirements ?? [], now: NOW });
    expect(plan.steps.some((s) => s.id === "nomination" && !s.doneDuringOnboarding && s.due !== undefined)).toBe(true);
    expect(plan.deadlineBasis).toBe("campus_estimate");

    const community = bySlug("sample-women-in-engineering-fellowship");
    expect(planFirstApplication({ program: community, requirements: [], now: NOW }).privacy.deviceOnly).toBe(true);
    expect(planFirstApplication({ program: civic, requirements: [], now: NOW }).privacy.deviceOnly).toBe(false);
  });

  it("refuses a program whose deadlines have all passed", () => {
    expect(() => planFirstApplication({ program: bySlug("sample-analytics-internship-passed"), requirements: [], now: NOW })).toThrow(FirstDoorClosedError);
  });

  it("lists missing keywords for the resume step without echoing resume text", () => {
    const plan = planFirstApplication({ program: civic, requirements: [{ kind: "resume" }], signals: { skills: ["Python"] }, now: NOW });
    expect(plan.missingKeywords).toEqual(expect.arrayContaining(["SQL", "Data analysis"]));
    expect(plan.missingKeywords).not.toContain("Python");
    expect(plan.steps.find((s) => s.id === "resume")?.detail).toMatch(/^Add these if you have them:/);
  });

  it("names the practice draft after what the application asks for", () => {
    const withEssay = planFirstApplication({ program: civic, requirements: [{ kind: "essay" }], now: NOW });
    const without = planFirstApplication({ program: civic, requirements: [{ kind: "resume" }], now: NOW });
    expect(withEssay.steps.find((s) => s.id === "draft")?.title).toBe("Draft the first two sentences of your essay");
    expect(without.steps.find((s) => s.id === "draft")?.title).toBe("Draft two sentences on why you want this");
  });

  it("dates rolling programs the way the match card does: start-by never before today", () => {
    const rolling = makeCard({ today: TODAY, deadlineIn: "rolling", extras: { requirements: [{ kind: "recommendation", quantity: 2 }, { kind: "essay" }] } });
    const plan = planFirstApplication({ program: rolling, requirements: rolling.extras?.requirements ?? [], now: NOW });
    const card = findMatches({ preferences: makePreferences({ categories: ["internships"], opportunityTypes: ["summer_internship"] }), programs: [rolling], now: NOW }).items[0];
    expect(plan.startBy >= TODAY).toBe(true);
    expect(plan.startBy).toBe(card?.feasibility.startBy);
  });

  it("uses the PrepModel it is given, so its dates agree with findMatches's", () => {
    // Five days of lead instead of the table's 21: the letter step moves from deadline - 23 to deadline - 6.
    const shortLead: PrepModel = { leadDays: () => 5, effortHours: (r) => (r.kind === "recommendation" ? 1 : null) };
    const deadline = addDays(TODAY, 40);
    const plan = planFirstApplication({ program: civic, requirements: [{ kind: "recommendation" }], now: NOW, prepModel: shortLead });
    expect(plan.steps.find((s) => s.id === "letters")?.due).toBe(addDays(deadline, -6));
    expect(plan.startBy).toBe(addDays(deadline, -6));
    const table = planFirstApplication({ program: civic, requirements: [{ kind: "recommendation" }], now: NOW });
    expect(table.steps.find((s) => s.id === "letters")?.due).toBe(addDays(deadline, -22));
  });
});

describe("planFirstApplication with the contract's Program, ProgramCycle and Requirements (the server's call)", () => {
  const ids = (n: number) => `00000000-0000-4000-a000-${String(n).padStart(12, "0")}`;
  const program: Program = ProgramSchema.parse({
    id: ids(1),
    slug: "sample-contract-scholarship",
    name: "Sample: Contract-Shaped Scholarship",
    organizationId: ids(2),
    summary: "A sample award for students who research climate questions.",
    officialUrl: "https://example.org/sample/contract-scholarship",
    recurrence: "annual",
    lifecycle: "active",
    opportunityTypes: ["national_scholarship"],
    sensitiveAudience: false,
    identityAudience: [],
    isPublished: true,
    isSample: true,
    version: 1,
  });
  const cycle: ProgramCycle = ProgramCycleSchema.parse({
    id: ids(3),
    programId: program.id,
    cycleKey: "ay-2027-28",
    termLabel: "2027-28",
    cycleModel: "term",
    status: "open",
    statusChangedAt: "2026-11-01T00:00:00.000Z",
    statusChangedBy: "Sample Curator",
    timeZone: "America/New_York",
    opensOn: "2026-11-01",
    predictedOpensOn: null,
    predictionLabel: null,
    decisionWindowStart: null,
    decisionWindowEnd: null,
    decisionsReleasedOn: null,
    eventStart: null,
    eventEnd: null,
    applicationUrl: "https://example.org/sample/contract-scholarship/apply",
    pellDisplacement: "none",
    applicationFeeCents: null,
    participantCostCents: null,
    compensation: { kind: "award", amountCents: null, period: null },
    verificationState: "verified",
    lastVerifiedAt: "2026-11-01T00:00:00.000Z",
    verifiedBy: "Sample Curator",
    sourceCheckedAt: null,
    rolledOverFromId: null,
    version: 1,
  });
  const requirement = (n: number, kind: Requirement["kind"], quantity = 1): Requirement =>
    RequirementSchema.parse({
      id: ids(10 + n),
      programCycleId: cycle.id,
      kind,
      label: kind,
      detail: null,
      quantity,
      wordLimit: null,
      deadlineId: null,
      effortHours: null,
      leadTimeDays: null,
      evidence: null,
      verificationState: "verified",
    });
  const requirements = [requirement(1, "essay"), requirement(2, "recommendation", 2), requirement(3, "campus_nomination")];

  it("schedules backward from a deadline the server already resolved, and spots the campus step from the requirements", () => {
    const deadline = addDays(TODAY, 90);
    const plan = planFirstApplication({ program, cycle, requirements, now: NOW, resolvedDeadline: { on: deadline } });
    expect(FirstApplicationPlanSchema.parse(plan)).toEqual(plan);
    expect(plan).toMatchObject({ programId: program.id, programCycleId: cycle.id, cycleKey: "ay-2027-28", deadline, deadlineBasis: "official", isSample: true });
    expect(plan.applicationUrl).toBe(cycle.applicationUrl);
    expect(plan.steps.some((s) => s.id === "nomination" && !s.doneDuringOnboarding && s.due !== undefined)).toBe(true);
    expect(plan.steps.find((s) => s.id === "letters")?.due).toBe(addDays(deadline, -23));
    expect(plan.steps.find((s) => s.id === "submit")?.due).toBe(addDays(deadline, -2));
    expect(plan.privacy.deviceOnly).toBe(false);
  });

  it("refuses a resolved deadline that has passed, and falls back to a suggested date without one", () => {
    expect(() => planFirstApplication({ program, cycle, requirements, now: NOW, resolvedDeadline: { on: addDays(TODAY, -1) } })).toThrow(FirstDoorClosedError);
    const plan = planFirstApplication({ program, cycle, requirements, now: NOW });
    expect(plan.deadline).toBeNull();
    expect(plan.deadlineBasis).toBe("not_announced");
  });

  it("keeps a community program's plan on the device", () => {
    const community: Program = { ...program, identityAudience: ["gender_identity"] };
    expect(planFirstApplication({ program: community, cycle, requirements, now: NOW, resolvedDeadline: { on: addDays(TODAY, 90) } }).privacy.deviceOnly).toBe(true);
  });
});

describe("hand-off", () => {
  const civic = bySlug("sample-civic-data-internship");
  const plan = planFirstApplication({ program: civic, requirements: civic.extras?.requirements ?? [], now: NOW });

  it("creates valid RoadmapItems for dated steps with a pinned apply item", () => {
    const items = planToRoadmapItems(plan, { doneStepIds: ["resume"] });
    for (const item of items) expect(RoadmapItemSchema.parse(item)).toEqual(item);
    const apply = items.find((i) => i.kind === "apply");
    expect(apply).toMatchObject({ pinned: true, dueOn: addDays(TODAY, 38), source: "student" });
    expect(items.find((i) => i.itemKey.endsWith(":resume"))?.state).toBe("done");
    expect(items.some((i) => i.title === "Save it to your Tracker")).toBe(false);
  });

  it("turns quick steps the student skipped into roadmap items and reminders, never marking them done", () => {
    const skipped = planToRoadmapItems(plan);
    expect(skipped.find((i) => i.itemKey.endsWith(":eligibility"))?.state).toBe("open");
    expect(skipped.find((i) => i.itemKey.endsWith(":draft"))?.state).toBe("open");
    expect(planReminders(plan, 20).map((r) => r.stepId)).toContain("eligibility");
    const finished = planToRoadmapItems(plan, { doneStepIds: ["eligibility", "draft"] });
    expect(finished.some((i) => i.itemKey.endsWith(":eligibility") || i.itemKey.endsWith(":draft"))).toBe(false);
    expect(planReminders(plan, 20, { doneStepIds: ["eligibility"] }).map((r) => r.stepId)).not.toContain("eligibility");
  });

  it("schedules reminders the day before each dated step, never in the past", () => {
    const reminders = planReminders(plan);
    expect(reminders.length).toBeGreaterThan(0);
    for (const r of reminders) expect(r.on >= TODAY).toBe(true);
  });
});
