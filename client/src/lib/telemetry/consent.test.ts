import { describe, expect, it } from "vitest";
import { EMPTY_STUDENT_PROFILE, type MeSessionResponse } from "@shared/contracts";
import { analyticsAllowedFor } from "./consent";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const session = (birthYearMonth: string | null): MeSessionResponse => ({
  user: { publicId: "usr_0123456789abcdef", email: "student@example.org", displayName: null, roles: ["student"], onboarded: true },
  profile: { ...EMPTY_STUDENT_PROFILE, birthYearMonth },
});

describe("analyticsAllowedFor", () => {
  it("allows signed-out visitors and accounts without a birth month", () => {
    expect(analyticsAllowedFor(null, NOW)).toBe(true);
    expect(analyticsAllowedFor({ user: null, profile: null }, NOW)).toBe(true);
    expect(analyticsAllowedFor(session(null), NOW)).toBe(true);
  });

  it("turns analytics off in minor mode by the youngest reading of the birth month", () => {
    expect(analyticsAllowedFor(session("2008-10"), NOW)).toBe(true);
    // Born in November 2008: possibly still 17 until 1 December 2026.
    expect(analyticsAllowedFor(session("2008-11"), NOW)).toBe(false);
    expect(analyticsAllowedFor(session("2010-01"), NOW)).toBe(false);
    expect(analyticsAllowedFor(session("2008-11"), Date.parse("2026-12-01T00:00:00Z"))).toBe(true);
  });
});
