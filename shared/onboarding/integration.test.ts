import { describe, expect, it } from "vitest";
import { buildEvalContext, evaluateEligibility } from "../eligibility";
import { LEAD_TIME_TABLE, effortHoursFor, leadDaysFor } from "../readiness";
import type { NormalizedSkill, ProfileSignals } from "../resume/types";
import { REQUIREMENT_KINDS } from "../taxonomy";
import { eligibilityAdapterFrom, facetEligibility } from "./eligibility";
import { findMatches } from "./match";
import { applyResumeSignals, createQuizState } from "./quiz";
import { SAMPLE_PERSONAS, buildSamplePrograms, runPersona } from "./sample";
import { DEFAULT_PREP_MODEL, GUIDANCE_TABLE, summarizeRequirements, type PrepModel } from "./schedule";
import { toMatchSignals } from "./signals";
import { normalizeSkillRefs } from "./skills";

/**
 * Contract checks against the sibling modules built in parallel (shared/eligibility,
 * shared/readiness, shared/resume). They import those modules only here, in a test, so the
 * onboarding engine itself never pins their internals; a failure means an interface drifted.
 */

const NOW = "2026-11-11T15:00:00Z";
const programs = buildSamplePrograms(NOW);

describe("shared/eligibility", () => {
  const adapter = eligibilityAdapterFrom(evaluateEligibility, buildEvalContext);

  it("plugs into findMatches through eligibilityAdapterFrom and keeps every persona's expected match", () => {
    for (const persona of SAMPLE_PERSONAS) {
      const run = runPersona(persona, { now: NOW, programs });
      const set = findMatches({ preferences: run.preferences, signals: persona.signals, programs, now: NOW, eligibility: adapter });
      expect(set.items.slice(0, 5).map((i) => i.slug)).toContain(persona.expectedSlug);
    }
  });

  it("agrees with the onboarding fallback on which sample programs a student is shut out of", () => {
    for (const card of programs) {
      const real = adapter(card, profileFor("first_year"), "2026-11-11");
      const local = facetEligibility(card, profileFor("first_year"), "2026-11-11");
      expect(real.status === "not_eligible").toBe(local.status === "not_eligible");
    }
  });
});

function profileFor(classYear: "first_year") {
  return {
    classYear,
    expectedGraduationTerm: null,
    institutionId: null,
    institutionLevel: null,
    enrollmentIntensity: null,
    transferIntent: null,
    majorCip: null,
    minorCip: null,
    majorFamily: null,
    gpaBand: null,
    residenceState: null,
    timeZone: null,
    birthYearMonth: null,
    interestTags: [],
    preferredOpportunityTypes: [],
    priorExperience: [],
    weeklyPrepHours: null,
  };
}

describe("shared/readiness", () => {
  it("schedules on readiness's own table and functions, so start-by equals the Tracker's latestStart", () => {
    expect(GUIDANCE_TABLE).toBe(LEAD_TIME_TABLE);
    for (const kind of REQUIREMENT_KINDS) {
      for (const r of [{ kind, quantity: 2 }, { kind, quantity: 1, effortHours: 4, leadTimeDays: 9 }]) {
        const full = { ...r, id: "r1", label: kind };
        expect(DEFAULT_PREP_MODEL.leadDays(r)).toBe(leadDaysFor(full));
        expect(DEFAULT_PREP_MODEL.effortHours(r)).toBe(effortHoursFor(full));
      }
    }
  });

  it("gives the same prep days when readiness's functions are passed in as the PrepModel", () => {
    // Readiness's RequirementLike needs an id and a label; compact onboarding ones may lack both.
    const withId = <T extends { id?: string; label?: string; kind: string }>(r: T) => ({ ...r, id: r.id ?? "compact", label: r.label ?? r.kind });
    const readinessModel: PrepModel = { leadDays: (r) => leadDaysFor(withId(r)), effortHours: (r) => effortHoursFor(withId(r)) };
    for (const p of programs) {
      const reqs = p.extras?.requirements ?? [];
      expect(summarizeRequirements(reqs, readinessModel).prepDays).toBe(summarizeRequirements(reqs, DEFAULT_PREP_MODEL).prepDays);
    }
  });
});

describe("shared/resume", () => {
  it("accepts ProfileSignals as they are and keeps only the closed, PII-free fields", () => {
    const signals: ProfileSignals = {
      skills: ["Python", "SolidWorks", "Adobe Premiere Pro"],
      skillCategories: ["programming", "engineering"],
      fields: ["computing"],
      majors: ["Computer Science"],
      coursework: ["Data Structures"],
      experienceTypes: ["research"],
      degreeLevel: "bachelor",
      graduationYear: 2030,
      classYear: "first_year",
      classYearInferred: true,
      experienceMonths: 4,
    };
    expect(toMatchSignals(signals)).toEqual({
      skills: ["python", "cad", "video"],
      fields: ["computing"],
      coursework: ["Data Structures"],
      experience: ["research"],
      graduationYear: 2030,
    });
    const state = applyResumeSignals(createQuizState({ now: NOW }), signals, "pdf");
    expect(state.prefill.class_year).toBe("first_year");
  });

  it("folds NormalizedSkill objects into onboarding skill ids and never reads the raw resume text", () => {
    // Shaped like shared/resume's normalizeSkills output (type-only import, so this test does not
    // depend on that module's runtime). `raw` holds a canary that must never surface.
    const normalized: NormalizedSkill[] = [
      { id: "python", name: "Python", category: "programming", known: true, raw: "CANARY python 555-0100" },
      { id: "solidworks", name: "SolidWorks", category: "engineering", known: true, raw: "CANARY solidworks" },
      { id: "kotlin", name: "Kotlin", category: "programming", known: true, raw: "CANARY kotlin" },
    ];
    const refs = normalizeSkillRefs(normalized);
    expect(refs).toEqual(["python", "cad", "x:kotlin"]);
    expect(JSON.stringify(refs)).not.toContain("CANARY");
  });
});
