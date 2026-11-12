import { describe, expect, it } from "vitest";
import { epochDayOf, isoFromEpochDay } from "./calendar";
import { finalNationalDeadline, openPlanningDate, planDeadline, resolveEffectiveDeadline, type DeadlineLike } from "./deadline";
import { buildEvalContext } from "../eligibility/context";
import { createRng } from "./math/random";
import { parseIsoInstant } from "../time/iso";
import { endOfLocalDay } from "../time/zones";

/*
 * Deadline fixtures follow official wording checked in the plan (2026-11-09): Goldwater's
 * "last Friday in January at 5:00 p.m. Central Time" and Truman's "February 2, 2027 ... 11:59 pm,
 * your time zone". Ids and institutions are synthetic.
 */
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CAMPUS = id(900);
const OTHER_CAMPUS = id(901);
const at = (iso: string) => parseIsoInstant(iso)!;

const goldwater: DeadlineLike = {
  id: id(1),
  kind: "nomination",
  scope: "national",
  institutionId: null,
  basis: "official",
  precision: "exact",
  tzMode: "fixed",
  localDate: "2027-01-29",
  localTime: "17:00",
  timeZone: "America/Chicago",
};
const truman: DeadlineLike = {
  id: id(2),
  kind: "nomination",
  scope: "national",
  institutionId: null,
  basis: "official",
  precision: "exact",
  tzMode: "applicant_local",
  localDate: "2027-02-02",
  localTime: "23:59",
  timeZone: null,
};
const campusRow = (extra: Partial<DeadlineLike>): DeadlineLike => ({
  id: id(3),
  kind: "campus_internal",
  scope: "campus",
  institutionId: CAMPUS,
  basis: "official",
  precision: "date_only",
  tzMode: "fixed",
  localDate: "2026-12-01",
  localTime: null,
  timeZone: "America/New_York",
  ...extra,
});

const base = {
  now: at("2026-11-09T15:00:00Z"),
  studentTimeZone: "America/Chicago",
  studentInstitutionId: CAMPUS,
  ownCampusDeadline: null,
  nominationGated: true,
};

describe("planning dates for one deadline row", () => {
  it("a fixed-zone deadline plans to the earlier of its own date and the student's", () => {
    const tokyo = planDeadline(goldwater, "Asia/Tokyo", base.now)!;
    expect(tokyo.instant).toBe(at("2027-01-29T23:00:00Z"));
    expect(tokyo.date).toBe("2027-01-29"); // 08:00 on the 30th in Tokyo, but never later than Chicago's date
    expect(planDeadline(goldwater, "America/Los_Angeles", base.now)!.date).toBe("2027-01-29");
  });

  it("applicant-local deadlines resolve in the student's zone (Truman 11:59 pm, your time zone)", () => {
    const ny = planDeadline(truman, "America/New_York", base.now)!;
    expect(ny.instant).toBe(at("2027-02-03T04:59:00Z"));
    const honolulu = planDeadline(truman, "Pacific/Honolulu", base.now)!;
    expect(honolulu.instant).toBe(at("2027-02-03T09:59:00Z"));
    expect(honolulu.date).toBe("2027-02-02");
    expect(honolulu.timeZone).toBeNull();
  });

  it("month-only rows plan to the first of the month; predicted windows to p10", () => {
    const month = planDeadline({ ...goldwater, precision: "month_only", localDate: "2027-03", localTime: null }, "America/Chicago", base.now)!;
    expect([month.date, month.approximate, month.instant]).toEqual(["2027-03-01", true, null]);
    const window = planDeadline(
      { ...goldwater, basis: "predicted", precision: "window", localDate: null, localTime: null, windowStart: "2027-01-22", windowEnd: "2027-02-05" },
      "America/Chicago",
      base.now,
    )!;
    expect([window.date, window.predicted, window.approximate]).toEqual(["2027-01-22", true, true]);
  });

  it("withdrawn, rolling and TBD rows have no planning date", () => {
    expect(planDeadline({ ...goldwater, withdrawnAt: "2026-11-01T00:00:00Z" }, "America/Chicago", base.now)).toBeNull();
    expect(planDeadline({ ...goldwater, precision: "rolling", localDate: null, localTime: null }, "America/Chicago", base.now)).toBeNull();
    expect(planDeadline({ ...goldwater, precision: "tbd", localDate: null, localTime: null }, "America/Chicago", base.now)).toBeNull();
  });

  it("the final national deadline is the latest national application or nomination row", () => {
    const early = { ...goldwater, id: id(7), kind: "application" as const, localDate: "2027-01-10" };
    const campus = campusRow({ localDate: "2027-03-01" });
    expect(finalNationalDeadline([early, goldwater, campus], "America/Chicago", base.now)!.deadlineId).toBe(goldwater.id);
  });
});

describe("effective deadline (s06 6.4.5 steps)", () => {
  it("step 2: Goldwater 2027 with no campus row is estimated at 20 Nov 2026 (national − 10 weeks)", () => {
    const e = resolveEffectiveDeadline({ ...base, deadlines: [goldwater] })!;
    expect(e.step).toBe("campus_estimate_e1");
    expect(e.date).toBe("2026-11-20");
    expect(e.basis).toBe("estimated");
    expect(e.scope).toBe("campus");
    expect(e.label).toBe("Estimated: confirm with your campus representative");
    expect(e.campusEstimate).toEqual({ e1: "2026-11-20", e2: "2026-12-18" });
    expect(e.final?.date).toBe("2027-01-29");
  });

  it("URI's Truman example: the 10-week default gives 24 Nov 2026 for a 2 Feb 2027 deadline", () => {
    const e = resolveEffectiveDeadline({ ...base, deadlines: [truman], studentTimeZone: "America/New_York" })!;
    expect(e.date).toBe("2026-11-24");
  });

  it("step 3 after E1 and step 4 after E2", () => {
    const e2 = resolveEffectiveDeadline({ ...base, deadlines: [goldwater], now: at("2026-11-25T15:00:00Z") })!;
    expect([e2.step, e2.date]).toEqual(["campus_estimate_e2", "2026-12-18"]);
    const after = resolveEffectiveDeadline({ ...base, deadlines: [goldwater], now: at("2026-12-20T15:00:00Z") })!;
    expect(after.step).toBe("national_after_campus");
    expect(after.date).toBe("2027-01-29");
    expect(after.label).toMatch(/may have passed/);
  });

  it("a campus lead override moves the estimate (URI's 63-day lead)", () => {
    const e = resolveEffectiveDeadline({ ...base, deadlines: [goldwater], campusLead: { l80Days: 63, l50Days: 42 } })!;
    expect(e.date).toBe("2026-11-27");
  });

  it("step 1: the student's own date, an official campus row for their campus or an attested row win", () => {
    const own = resolveEffectiveDeadline({ ...base, deadlines: [goldwater], ownCampusDeadline: "2026-12-04" })!;
    expect([own.step, own.basis, own.date]).toEqual(["known_campus", "student_entered", "2026-12-04"]);
    expect(own.instant).toBe(endOfLocalDay("2026-12-04", "America/Chicago"));

    const official = resolveEffectiveDeadline({ ...base, deadlines: [goldwater, campusRow({})] })!;
    expect([official.step, official.basis, official.date, official.label]).toEqual(["known_campus", "official", "2026-12-01", "Your campus deadline"]);

    const attested = resolveEffectiveDeadline({ ...base, deadlines: [goldwater, campusRow({ basis: "attested" })] })!;
    expect([attested.basis, attested.label]).toEqual(["attested", "Confirmed by your campus"]);

    // Another campus's row says nothing about this student's campus.
    const other = resolveEffectiveDeadline({ ...base, deadlines: [goldwater, campusRow({ institutionId: OTHER_CAMPUS })] })!;
    expect(other.step).toBe("campus_estimate_e1");

    // The earliest upcoming known date wins.
    const both = resolveEffectiveDeadline({ ...base, deadlines: [goldwater, campusRow({})], ownCampusDeadline: "2026-11-30" })!;
    expect(both.date).toBe("2026-11-30");
  });

  it("a passed known campus date sends a nomination-gated student to the national date with a warning", () => {
    const e = resolveEffectiveDeadline({ ...base, deadlines: [goldwater, campusRow({ localDate: "2026-11-02" })] })!;
    expect(e.step).toBe("national_after_campus");
    expect(e.campusDatePassed).toBe("2026-11-02");
  });

  it("step 5: the next unexpired priority round, then the final deadline", () => {
    const final = { ...goldwater, kind: "application" as const };
    const round = { ...goldwater, id: id(8), kind: "priority_round" as const, localDate: "2026-12-15", roundLabel: "Early" };
    const open = { ...base, nominationGated: false, deadlines: [final, round] };
    const r = resolveEffectiveDeadline(open)!;
    expect([r.step, r.date, r.label]).toEqual(["priority_round", "2026-12-15", "Priority round: Early"]);
    const later = resolveEffectiveDeadline({ ...open, now: at("2026-12-20T15:00:00Z") })!;
    expect([later.step, later.label]).toEqual(["final", "Application deadline"]);
    expect(resolveEffectiveDeadline({ ...open, deadlines: [] })).toBeNull();
  });

  it("closed once the final deadline has passed", () => {
    const e = resolveEffectiveDeadline({ ...base, nominationGated: false, deadlines: [goldwater], now: at("2027-02-01T00:00:00Z") })!;
    expect(e.closed).toBe(true);
    expect(e.passed).toBe(true);
  });

  it("never returns a passed date while the final deadline is still open (property)", () => {
    const rng = createRng(42);
    for (let i = 0; i < 300; i++) {
      const day = isoFromEpochDay(epochDayOf("2026-09-01") + rng.int(160));
      const now = at(`${day}T${String(rng.int(24)).padStart(2, "0")}:00:00Z`);
      const deadlines = [goldwater, ...(rng.bernoulli(0.5) ? [campusRow({ localDate: isoFromEpochDay(epochDayOf("2026-11-01") + rng.int(60)) })] : [])];
      const own = rng.bernoulli(0.3) ? isoFromEpochDay(epochDayOf("2026-11-01") + rng.int(60)) : null;
      const e = resolveEffectiveDeadline({ ...base, now, deadlines, ownCampusDeadline: own, nominationGated: rng.bernoulli(0.7) })!;
      expect(e).not.toBeNull();
      if (!e.closed) {
        expect(e.passed).toBe(false);
        expect(e.date <= e.final!.date).toBe(true);
      }
    }
  });
});

describe("guards", () => {
  it("ignores a campus date entered after the national deadline", () => {
    const e = resolveEffectiveDeadline({ ...base, deadlines: [goldwater], ownCampusDeadline: "2027-03-01" })!;
    expect(e.step).toBe("campus_estimate_e1");
  });
});

describe("bad rows", () => {
  it("a fixed row without a valid zone is skipped instead of throwing", () => {
    expect(planDeadline({ ...goldwater, timeZone: "Not/AZone" }, "America/Chicago", base.now)).toBeNull();
    expect(resolveEffectiveDeadline({ ...base, nominationGated: false, deadlines: [{ ...goldwater, timeZone: null }] })).toBeNull();
  });
});

describe("planning dates for open deadlines", () => {
  const monthOnly: DeadlineLike = {
    id: id(40),
    kind: "application",
    scope: "national",
    institutionId: null,
    basis: "official",
    precision: "month_only",
    tzMode: "applicant_local",
    localDate: "2027-03",
    localTime: null,
    timeZone: null,
  };

  it("an approximate row moves to its latest plausible day once its first day has passed", () => {
    const planned = planDeadline(monthOnly, "America/Chicago", at("2027-03-03T15:00:00Z"))!;
    expect(planned).toMatchObject({ date: "2027-03-01", latestDate: "2027-03-31", approximate: true, passed: false });
    expect(openPlanningDate(planned, "2027-03-03")).toBe("2027-03-31");
    expect(openPlanningDate(planned, "2027-02-20")).toBe("2027-03-01");
  });

  it("an exact row that has not passed is due today, never later", () => {
    expect(openPlanningDate({ date: "2027-01-29", passed: false, approximate: false, latestDate: null }, "2027-01-30")).toBe("2027-01-30");
  });

  it("the eligibility national_deadline anchor matches the final national deadline for nomination rows", () => {
    const final = finalNationalDeadline([goldwater], "America/Chicago", at("2026-11-09T15:00:00Z"))!;
    expect(buildEvalContext({ deadlines: [goldwater] }).anchors.national_deadline).toBe(final.date);
  });
});
