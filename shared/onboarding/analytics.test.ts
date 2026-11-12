import { describe, expect, it } from "vitest";
import { AnalyticsEventSchema } from "../contracts/api";
import { ONBOARDING_FUNNEL, onboardingEvent } from "./analytics";
import { findMatches } from "./match";
import { buildSamplePrograms } from "./sample";
import { makePreferences } from "./testing";

const NOW = "2026-11-11T15:00:00Z";

describe("onboarding analytics", () => {
  it("emits content-free events that fit the analytics contract", () => {
    const programs = buildSamplePrograms(NOW);
    const set = findMatches({ preferences: makePreferences({ categories: ["internships"], interests: ["software"], majorFamily: "computing" }), programs, now: NOW });
    const events = [
      onboardingEvent({ step: "started" }),
      onboardingEvent({ step: "quiz_completed", asked: 13, skipped: 2, seconds: 214 }),
      onboardingEvent({ step: "resume_parsed", source: "pdf", ok: true }),
      onboardingEvent({ step: "matches_shown", matches: set }),
      onboardingEvent({ step: "first_door_chosen", tier: "strong" }),
      onboardingEvent({ step: "first_step_done", kind: "draft" }),
      onboardingEvent({ step: "tracker_created", deviceOnly: false }),
    ];
    expect(events.map((e) => e.props.step)).toEqual([...ONBOARDING_FUNNEL]);
    for (const e of events) {
      const parsed = AnalyticsEventSchema.safeParse({ name: e.name, deviceId: "abcdefghijklmnop", at: NOW, path: "/app/start", props: e.props });
      expect(parsed.success).toBe(true);
      const text = JSON.stringify(e.props);
      // No program names, slugs, ids, skills or reasons.
      for (const item of set.items) {
        expect(text).not.toContain(item.slug);
        expect(text).not.toContain(item.programId);
        expect(text).not.toContain(item.name);
      }
      expect(text).not.toMatch(/python|software|resume text/i);
    }
  });

  it("counts picks to explore, so the share of students who only saw the fallback is measurable", () => {
    const programs = buildSamplePrograms(NOW);
    const nothing = onboardingEvent({ step: "matches_shown", matches: findMatches({ preferences: makePreferences(), programs, now: NOW }) });
    expect(nothing.props.explore).toBe(nothing.props.stretch);
    expect(nothing.props.relaxed).toBe(true);
    const focused = onboardingEvent({ step: "matches_shown", matches: findMatches({ preferences: makePreferences({ categories: ["internships"], interests: ["software"], majorFamily: "computing" }), programs, now: NOW }) });
    expect(focused.props.explore).toBe(0);
  });

  it("rejects values outside the enums", () => {
    expect(() => onboardingEvent({ step: "resume_parsed", source: "my-cv.pdf" as never, ok: true })).toThrow(RangeError);
    expect(() => onboardingEvent({ step: "first_door_chosen", tier: "best" as never })).toThrow(RangeError);
  });
});
