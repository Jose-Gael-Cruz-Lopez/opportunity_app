import { describe, expect, it } from "vitest";
import { EligibilityResultSchema, EMPTY_STUDENT_PROFILE, type EligibilityResult, type TrackerItem } from "@shared/contracts";
import { PRODUCT } from "@shared/config/product";
import { applyItemKey } from "@shared/readiness";
import { cardRefs, cardSources, ASK_MAX_CARDS } from "./ask";
import { markPrivateChecks, otherWorkloads, programSources, statesGpaRule, studentTimeZone, computeReadiness } from "./readiness";
import { buildRoadmap, capTerm, changedKeys, programIdFromItemKey, MISSED_VISIBLE_DAYS } from "./roadmap";
import type { TrackedCycle } from "./ports";
import { SAMPLE_GPA_SOURCE, SAMPLE_PROGRAM_ID, SAMPLE_SOURCE, sampleCard, sampleId } from "./testing";

const NOW = Date.parse("2026-11-11T16:00:00Z");

function tracked(source: typeof SAMPLE_SOURCE, fields: Partial<TrackerItem> = {}): TrackedCycle {
  return {
    item: {
      id: sampleId(800),
      programCycleId: source.cycle.id,
      programSlug: source.program.slug,
      cycleKey: source.cycle.cycleKey,
      status: "interested",
      statusSource: "student",
      ownCampusDeadline: null,
      submittedOn: null,
      nameInMessages: true,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      version: 1,
      ...fields,
    },
    program: source.program,
    cycle: source.cycle,
    deadlines: source.deadlines,
    requirements: source.requirements,
  };
}

describe("markPrivateChecks", () => {
  const base: EligibilityResult = {
    verdict: "unknown",
    status: "unknown",
    rules: [
      {
        ruleId: "citizenship",
        dimension: "citizenship",
        group: "all",
        verdict: "unknown",
        sensitive: true,
        reasonCode: "SENSITIVE_UNANSWERED",
        reason: "Eligible if you meet this rule: Sample rule.",
        officialText: "Sample rule: U.S. citizens only.",
        missingFields: ["citizenship"],
        resolver: "novus",
        evidenceKey: null,
        evidence: null,
      },
      {
        ruleId: "enrollment",
        dimension: "enrollment",
        group: "all",
        verdict: "met",
        sensitive: false,
        reasonCode: "MET",
        reason: "Meets this rule: Sample rule.",
        officialText: "Sample rule: full-time.",
        missingFields: [],
        resolver: null,
        evidenceKey: null,
        evidence: null,
      },
    ],
    pending: [],
    nomination: null,
    ruleSet: null,
    basedOnListedRequirements: false,
    asOf: "2026-11-11",
    sensitiveEvaluated: false,
  };

  it("rewords every sensitive rule as an on-device check and adds a pending self-check", () => {
    const out = markPrivateChecks(base);
    expect(EligibilityResultSchema.safeParse(out).success).toBe(true);
    expect(out.rules[0]).toMatchObject({ verdict: "unknown", reasonCode: "SENSITIVE_ON_DEVICE", resolver: "student" });
    expect(out.rules[0]?.reason).toBe("Check this rule yourself on your device: Sample rule: U.S. citizens only.");
    expect(out.rules[1]).toEqual(base.rules[1]);
    expect(out.pending).toEqual([expect.objectContaining({ id: "citizenship", sensitive: true, resolver: "student", kind: "rule" })]);
  });

  it("is idempotent and never claims the device evaluated anything", () => {
    const once = markPrivateChecks(base);
    expect(markPrivateChecks(once)).toEqual(once);
    expect(markPrivateChecks({ ...base, sensitiveEvaluated: true }).sensitiveEvaluated).toBe(false);
  });
});

describe("readiness helpers", () => {
  it("picks the profile zone, then the browser zone, then the product default", () => {
    expect(studentTimeZone({ timeZone: "America/Denver" }, "Europe/London")).toBe("America/Denver");
    expect(studentTimeZone({ timeZone: null }, "Europe/London")).toBe("Europe/London");
    expect(studentTimeZone({ timeZone: null }, "Not/AZone")).toBe(PRODUCT.fallbackTimeZone);
  });

  it("counts only other applications still being prepared as workload", () => {
    const list = [
      tracked(SAMPLE_SOURCE),
      tracked(SAMPLE_GPA_SOURCE, { status: "applying" }),
      tracked(SAMPLE_GPA_SOURCE, { status: "submitted" }),
    ];
    const w = otherWorkloads(list, SAMPLE_SOURCE.cycle.id);
    expect(w).toHaveLength(1);
    expect(w[0]?.id).toBe(SAMPLE_GPA_SOURCE.cycle.id);
  });

  it("states whether the rules have a GPA criterion (gates gpaBand in prompts)", () => {
    expect(statesGpaRule(SAMPLE_GPA_SOURCE)).toBe(true);
    expect(statesGpaRule(SAMPLE_SOURCE)).toBe(false);
  });

  it("builds labelled sample sources from public record facts only", () => {
    const sources = programSources(SAMPLE_SOURCE, "https://novus.example.org/");
    expect(sources[0]).toMatchObject({ kind: "novus_record", url: "https://novus.example.org/programs/sample-stem-research-award" });
    expect(sources[0]?.text).toMatch(/^SAMPLE RECORD/);
    expect(sources[0]?.text).toContain("2027-01-29");
    expect(sources[0]?.text).toContain("Sample rule: U.S. citizens, nationals or permanent residents.");
    expect(sources.filter((s) => s.kind === "program_page")).toHaveLength(1);
    expect(programSources(SAMPLE_GPA_SOURCE, "https://novus.example.org", { essayOnly: true })).toHaveLength(1);
  });

  it("is deterministic for the same inputs", () => {
    const req = {
      source: SAMPLE_SOURCE,
      profile: { ...EMPTY_STUDENT_PROFILE, classYear: "second_year" as const },
      trackerItem: null,
      progress: [],
      tracked: [],
      institution: null,
      participates: false,
      now: NOW,
      browserTimeZone: null,
      methodologyUrl: null,
    };
    expect(computeReadiness(req).report).toEqual(computeReadiness(req).report);
  });
});

describe("roadmap", () => {
  const input = (list: TrackedCycle[], extra: Partial<Parameters<typeof buildRoadmap>[0]> = {}) => ({
    tracked: list,
    actions: new Map(),
    lastShownItemKeys: [],
    templateKey: null,
    profile: { institutionId: null },
    now: NOW,
    timeZone: "America/New_York",
    ...extra,
  });

  it("drops not-applying items and marks submitted ones done", () => {
    const r = buildRoadmap(input([tracked(SAMPLE_SOURCE, { status: "not_applying" }), tracked(SAMPLE_GPA_SOURCE, { status: "submitted" })]));
    const items = r.roadmap.terms.flatMap((t) => t.apply);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ programId: SAMPLE_GPA_SOURCE.program.id, state: "done", dueOn: "2027-02-15" });
  });

  it("hides missed items after the grace period unless pinned", () => {
    const late = NOW + (130 + MISSED_VISIBLE_DAYS) * 86_400_000;
    const list = [tracked(SAMPLE_GPA_SOURCE)];
    expect(buildRoadmap(input(list, { now: late })).roadmap.terms.flatMap((t) => t.apply)).toHaveLength(0);
    const key = applyItemKey(SAMPLE_GPA_SOURCE.program.id, SAMPLE_GPA_SOURCE.cycle.cycleKey);
    const pinned = buildRoadmap(input(list, { now: late, actions: new Map([[key, { pinned: true, state: "open" as const }]]) }));
    expect(pinned.roadmap.terms.flatMap((t) => t.apply)[0]).toMatchObject({ state: "missed", pinned: true });
  });

  it("always shows the current term, and changes are reported in both directions", () => {
    const empty = buildRoadmap(input([]));
    expect(empty.roadmap.terms).toHaveLength(1);
    expect(empty.roadmap.terms[0]?.term).toBe("fall-2026");
    expect(changedKeys(["apply:a", "apply:b"], ["apply:b", "apply:c"])).toEqual(["apply:a", "apply:c"]);
  });

  it("caps open items per term, keeps pins and counts the rest", () => {
    const mk = (n: number, pinned = false, state: "open" | "done" = "open") => ({
      item: { itemKey: `apply:${n}`, title: `Sample ${n}`, pinned, state } as never,
      sortDate: `2027-01-${String(10 + n).padStart(2, "0")}`,
    });
    const { shown, more, openCount } = capTerm([mk(1), mk(2), mk(3), mk(4, true), mk(5, false, "done")], 2);
    expect(shown.map((i: { itemKey: string }) => i.itemKey)).toEqual(["apply:4", "apply:1", "apply:5"]);
    expect(more).toBe(2);
    expect(openCount).toBe(4);
  });

  it("reads the program id from program-scoped item keys only", () => {
    expect(programIdFromItemKey(applyItemKey(SAMPLE_PROGRAM_ID, "ay-2026-27"))).toBe(SAMPLE_PROGRAM_ID);
    expect(programIdFromItemKey(`prep:${SAMPLE_PROGRAM_ID}:ay-2026-27:req-1`)).toBe(SAMPLE_PROGRAM_ID);
    expect(programIdFromItemKey("tpl:four-year:research")).toBeNull();
    expect(programIdFromItemKey("apply:not-a-uuid:ay-2026-27")).toBeNull();
  });
});

describe("ask retrieval", () => {
  it("labels sample cards, links the Novus record and caps the list", () => {
    const cards = Array.from({ length: 8 }, () => sampleCard(SAMPLE_SOURCE));
    const sources = cardSources(cards, "https://novus.example.org");
    expect(sources).toHaveLength(ASK_MAX_CARDS);
    expect(sources[0]?.text).toMatch(/^SAMPLE RECORD/);
    expect(sources[0]?.url).toBe("https://novus.example.org/programs/sample-stem-research-award");
    expect(cardRefs(cards)).toHaveLength(ASK_MAX_CARDS);
  });
});
