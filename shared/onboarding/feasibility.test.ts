import { describe, expect, it } from "vitest";
import { addDays } from "../time/iso";
import { CAMPUS_LEAD_L50_DAYS, CAMPUS_LEAD_L80_DAYS, ROLLING_TARGET_DAYS, computeFeasibility, effectiveDeadline } from "./feasibility";
import { GUIDANCE_TABLE, latestStart, requirementPrepDays, summarizeRequirements } from "./schedule";
import { makeCard, makeDeadline } from "./testing";

const NOW = Date.UTC(2026, 10, 11, 15); // 2026-11-11 10:00 in New York
const TODAY = "2026-11-11";
const TZ = "America/New_York";

describe("guidance table (plan 07, 7.4.2)", () => {
  it("gives two letters 23 days: 21 days of lead plus one hour each at one hour a day", () => {
    expect(requirementPrepDays({ kind: "recommendation", quantity: 2 })).toBe(23);
    expect(latestStart("2027-01-15", { kind: "recommendation", quantity: 2 })).toBe("2026-12-23");
  });

  it("matches the table for every kind and honours Curator overrides", () => {
    expect(requirementPrepDays({ kind: "essay" })).toBe(20);
    expect(requirementPrepDays({ kind: "transcript" })).toBe(8);
    expect(requirementPrepDays({ kind: "resume" })).toBe(6);
    expect(requirementPrepDays({ kind: "coursework" })).toBeNull();
    expect(requirementPrepDays({ kind: "essay", effortHours: 2, leadTimeDays: 3 })).toBe(5);
    expect(GUIDANCE_TABLE.recommendation.leadDays).toBe(21);
    expect(GUIDANCE_TABLE.recommendation.effortHoursPerUnit).toBe(1);
  });

  it("summarizes prep as the max of lead plus effort, with total hours and counts", () => {
    const s = summarizeRequirements([{ kind: "recommendation", quantity: 2 }, { kind: "essay", quantity: 2 }, { kind: "transcript" }]);
    expect(s.prepDays).toBe(26); // essays: 14 + 12
    expect(s.hours).toBe(14.5); // 2 + 12 + 0.5
    expect(s.letters).toBe(2);
    expect(s.essays).toBe(2);
  });
});

describe("effectiveDeadline", () => {
  it("takes the next unexpired priority round, then the final deadline", () => {
    const card = makeCard({ today: TODAY, deadlineIn: null });
    const deadlines = [makeDeadline(TODAY, -2, "priority_round"), makeDeadline(TODAY, 20, "priority_round"), makeDeadline(TODAY, 40)];
    expect(effectiveDeadline({ ...card, deadlines }, NOW, TZ, TODAY)).toEqual({ date: addDays(TODAY, 20), basis: "official", campusStep: null });
  });

  it("returns passed when every application deadline is over, and ignores decision dates", () => {
    const card = makeCard({ today: TODAY, deadlineIn: -1 });
    expect(effectiveDeadline({ ...card, deadlines: [...card.deadlines, makeDeadline(TODAY, 30, "decision_expected")] }, NOW, TZ, TODAY)).toBe("passed");
  });

  it("treats a deadline later today as open and one earlier today as passed", () => {
    const today = makeCard({ today: TODAY, deadlineIn: 0 }); // 23:59 New York
    expect(effectiveDeadline(today, NOW, TZ, TODAY)).toMatchObject({ date: TODAY });
    const late = NOW + 15 * 3_600_000; // 01:00 the next day in New York
    expect(effectiveDeadline(today, late, TZ, "2026-11-12")).toBe("passed");
  });

  it("estimates campus deadlines for nomination-gated programs (E1, then E2, then national)", () => {
    const at = (days: number) => makeCard({ today: TODAY, deadlineIn: days, flags: { nominationRequired: true } });
    expect(effectiveDeadline(at(100), NOW, TZ, TODAY)).toEqual({ date: addDays(TODAY, 100 - CAMPUS_LEAD_L80_DAYS), basis: "campus_estimate", campusStep: "e1" });
    expect(effectiveDeadline(at(60), NOW, TZ, TODAY)).toEqual({ date: addDays(TODAY, 60 - CAMPUS_LEAD_L50_DAYS), basis: "campus_estimate", campusStep: "e2" });
    expect(effectiveDeadline(at(30), NOW, TZ, TODAY)).toEqual({ date: addDays(TODAY, 30), basis: "official", campusStep: "national" });
  });

  it("reports rolling and unannounced deadlines without inventing a date", () => {
    expect(effectiveDeadline(makeCard({ today: TODAY, deadlineIn: "rolling" }), NOW, TZ, TODAY)).toEqual({ date: null, basis: "rolling", campusStep: null });
    expect(effectiveDeadline(makeCard({ today: TODAY, deadlineIn: "tbd" }), NOW, TZ, TODAY)).toEqual({ date: null, basis: "not_announced", campusStep: null });
    expect(effectiveDeadline(makeCard({ today: TODAY, deadlineIn: null }), NOW, TZ, TODAY)).toEqual({ date: null, basis: "not_announced", campusStep: null });
  });

  it("plans month-only deadlines from the first of the month", () => {
    const card = makeCard({ today: TODAY, deadlineIn: null });
    const row = { ...makeDeadline(TODAY, 30), precision: "month_only" as const, localDate: "2027-01", timeZone: null, dueAt: null, sortAt: null };
    expect(effectiveDeadline({ ...card, deadlines: [row] }, NOW, TZ, TODAY)).toEqual({ date: "2027-01-01", basis: "estimated", campusStep: null });
  });
});

describe("computeFeasibility", () => {
  const base = { nowMs: NOW, timeZone: TZ, today: TODAY, weeklyHours: 3 };

  it("starts by deadline minus prep days and needs both calendar room and the student's hours", () => {
    const card = makeCard({ today: TODAY, deadlineIn: 40, extras: { requirements: [{ kind: "resume" }, { kind: "essay" }] } });
    const f = computeFeasibility({ ...base, program: card });
    expect(f).toMatchObject({ deadline: addDays(TODAY, 40), startBy: addDays(TODAY, 20), daysLeft: 40, enoughTime: true, prepDays: 20, prepHours: 9, tight: false });
    expect(f?.label).toBe("Start by Dec 1 · about 9 h of prep");
  });

  it("calls a two-letter application due in ten days tight, never feasible", () => {
    const card = makeCard({ today: TODAY, deadlineIn: 10, extras: { requirements: [{ kind: "recommendation", quantity: 2 }] } });
    const f = computeFeasibility({ ...base, program: card });
    expect(f?.enoughTime).toBe(false);
    expect(f?.label).toBe("Tight timeline: needs 2 letters · due Nov 21");
  });

  it("is tight when the work does not fit the student's weekly hours", () => {
    const card = makeCard({ today: TODAY, deadlineIn: 30, extras: { requirements: [{ kind: "essay" }, { kind: "portfolio" }] } });
    // The calendar has room (start by day 6), but 16 hours in 30 days at 3 h a week (about 12.9 h)
    // does not fit; at 6 h a week (about 25.7 h) it does.
    expect(computeFeasibility({ ...base, program: card })?.enoughTime).toBe(false);
    expect(computeFeasibility({ ...base, weeklyHours: 6, program: card })?.enoughTime).toBe(true);
  });

  it("uses the deadline itself when requirements are not checked, and keeps a two-day buffer", () => {
    const unchecked = computeFeasibility({ ...base, program: makeCard({ today: TODAY, deadlineIn: 12 }) });
    expect(unchecked).toMatchObject({ startBy: addDays(TODAY, 12), prepDays: null, enoughTime: true });
    expect(unchecked?.label).toBe("Due Nov 23 · prep time not checked yet");
    expect(computeFeasibility({ ...base, program: makeCard({ today: TODAY, deadlineIn: 1 }) })?.enoughTime).toBe(false);
  });

  it("treats an empty requirements list as not checked, never as zero prep", () => {
    const empty = computeFeasibility({ ...base, program: makeCard({ today: TODAY, deadlineIn: 1, extras: { requirements: [] } }) });
    const missing = computeFeasibility({ ...base, program: makeCard({ today: TODAY, deadlineIn: 1 }) });
    expect(empty).toMatchObject({ enoughTime: false, prepDays: null, checked: false, prep: null });
    expect(empty?.label).toBe(missing?.label);
  });

  it("drops programs whose start-by passed more than 30 days ago", () => {
    const card = makeCard({ today: TODAY, deadlineIn: 5, prepDays: 40 });
    expect(computeFeasibility({ ...base, program: card })).toBeNull();
    expect(computeFeasibility({ ...base, program: makeCard({ today: TODAY, deadlineIn: 5, prepDays: 30 }) })).not.toBeNull();
  });

  it("suggests an apply-by date for rolling admission and labels it as a suggestion", () => {
    const f = computeFeasibility({ ...base, program: makeCard({ today: TODAY, deadlineIn: "rolling", prepDays: 6 }) });
    expect(f).toMatchObject({ deadline: null, basis: "rolling", daysLeft: ROLLING_TARGET_DAYS, enoughTime: true, startBy: addDays(TODAY, ROLLING_TARGET_DAYS - 6) });
    expect(f?.label).toMatch(/^Rolling admission: aim to apply by/);
  });

  it("counts days in the student's zone for applicant-local deadlines", () => {
    const card = makeCard({ today: TODAY, deadlineIn: null });
    const row = { ...makeDeadline(TODAY, 3), tzMode: "applicant_local" as const, timeZone: null, dueAt: null };
    const f = computeFeasibility({ ...base, timeZone: "Pacific/Honolulu", program: { ...card, deadlines: [row] } });
    expect(f?.deadline).toBe(addDays(TODAY, 3));
  });
});
