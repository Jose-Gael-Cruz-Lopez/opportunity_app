import { describe, expect, it } from "vitest";
import { EMPTY_STUDENT_PROFILE } from "@shared/contracts";
import { defaultEligibility, findMatches, toServerPreferences } from "@shared/onboarding";
import { makePreferences } from "@shared/onboarding/testing";
import { deviceEligibilityAdapter, deviceEligibilityRows, toSensitiveAnswers } from "./device-eligibility";
import { onboardingProgramsOf } from "./engine";
import { buildSamplePrograms } from "./fixtures";

// SAMPLE programs only (fixtures.ts); every name starts with "Sample".
const NOW = new Date("2026-11-11T15:00:00Z");
const TODAY = "2026-11-11";
const samples = buildSamplePrograms(NOW);
const coastal = samples.find((s) => s.card.slug === "sample-coastal-data-fellowship")!;

describe("device eligibility (evaluateWithAnswers)", () => {
  it("evaluates the rule set with the shared engine, not the fallback subset", () => {
    const rows = deviceEligibilityRows(coastal.card.rules, "first_year", {}, TODAY);
    expect(rows).not.toBeNull();
    expect(rows!.map((r) => [r.id, r.verdict, r.private, r.needs])).toEqual([
      ["standing.early", "met", false, []],
      ["citizenship.us", "unknown", true, ["citizenship"]],
    ]);
    expect(deviceEligibilityRows(coastal.card.rules, "first_year", { citizenship: "permanent_resident" }, TODAY)![1]!.verdict).toBe("met");
    expect(deviceEligibilityRows(coastal.card.rules, "first_year", { citizenship: "f1" }, TODAY)![1]!.verdict).toBe("not_met");
    // "Prefer not to say" keeps the rule open; it never reads as met.
    expect(deviceEligibilityRows(coastal.card.rules, "first_year", { citizenship: "prefer_not" }, TODAY)![1]!.verdict).toBe("unknown");
  });

  it("drops answers outside the vocabulary instead of guessing", () => {
    expect(toSensitiveAnswers({ citizenship: "martian", pell: "recipient" })).toEqual({ pell: "recipient" });
    expect(toSensitiveAnswers({})).toEqual({});
  });

  it("is the shared default until the student answers privately", () => {
    expect(deviceEligibilityAdapter({})).toBe(defaultEligibility);
    expect(deviceEligibilityAdapter(null)).toBe(defaultEligibility);
  });

  it("resolves private rules on the device and never serializes the answers", () => {
    const profile = { ...EMPTY_STUDENT_PROFILE, classYear: "first_year" as const };
    const open = defaultEligibility(coastal.card, profile, TODAY);
    expect(open.status).not.toBe("eligible");
    const no = deviceEligibilityAdapter({ citizenship: "f1" })(coastal.card, profile, TODAY);
    expect(no.status).toBe("not_eligible");
    const yes = deviceEligibilityAdapter({ citizenship: "us_citizen" })(coastal.card, profile, TODAY);
    expect(yes.pending.some((p) => p.id === "citizenship.us")).toBe(false);
    // The outcome is a plain copy: no answer value appears in it.
    expect(JSON.stringify(yes)).not.toContain("us_citizen");
  });

  it("changes on-device matches only through eligibility", () => {
    const prefs = toServerPreferences(makePreferences({ classYear: "first_year", timeZone: "America/New_York" }));
    const programs = onboardingProgramsOf(samples);
    const without = findMatches({ preferences: prefs, programs, now: NOW, k: 30 });
    const excluded = findMatches({ preferences: prefs, programs, now: NOW, k: 30, eligibility: deviceEligibilityAdapter({ citizenship: "f1" }) });
    const ids = (s: typeof without) => s.items.map((i) => i.programId);
    for (const id of ids(excluded)) expect(ids(without)).toContain(id);
    if (ids(without).includes(coastal.card.programId)) expect(ids(excluded)).not.toContain(coastal.card.programId);
  });
});
