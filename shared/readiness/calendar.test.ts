import { describe, expect, it } from "vitest";
import {
  blackoutDaySet,
  defaultBlackouts,
  epochDayOf,
  isoFromEpochDay,
  nthWeekdayOfMonth,
  sameMonthDayInYear,
  sameWeekdayNear,
  subtractAvailableDays,
  usThanksgiving,
  weekdayOfEpochDay,
} from "./calendar";
import { createRng } from "./math/random";

/*
 * Golden dates from the planning study, computed with Python's dateutil.rrule and zoneinfo on
 * 2026-11-11 (Goldwater: last Friday in January; next opening: first Tuesday in September; URI's
 * internal Truman deadline: the first Tuesday after Thanksgiving).
 */

describe("plain dates", () => {
  it("round-trips epoch days and names weekdays (Monday = 1)", () => {
    expect(epochDayOf("1970-01-01")).toBe(0);
    expect(isoFromEpochDay(epochDayOf("2027-01-29"))).toBe("2027-01-29");
    expect(weekdayOfEpochDay(0)).toBe(4); // 1970-01-01 was a Thursday
    expect(weekdayOfEpochDay(epochDayOf("2027-01-29"))).toBe(5); // a Friday
    expect(weekdayOfEpochDay(-1)).toBe(3);
    expect(() => epochDayOf("2027-02-30")).toThrow(RangeError);
  });

  it("finds nth and last weekdays (RRULE BYDAY=-1FR, 1TU)", () => {
    expect(nthWeekdayOfMonth(2026, 1, 5, -1)).toBe("2026-01-30");
    expect(nthWeekdayOfMonth(2027, 1, 5, -1)).toBe("2027-01-29");
    expect(nthWeekdayOfMonth(2028, 1, 5, -1)).toBe("2028-01-28");
    expect(nthWeekdayOfMonth(2027, 9, 2, 1)).toBe("2027-09-07");
    expect(nthWeekdayOfMonth(2026, 3, 1, 5)).toBe("2026-03-30"); // March 2026 has five Mondays
    expect(nthWeekdayOfMonth(2026, 2, 1, 5)).toBeNull(); // February 2026 has four
    expect(nthWeekdayOfMonth(2026, 2, 1, 0)).toBeNull();
  });

  it("puts US Thanksgiving on the fourth Thursday (URI Truman: +5 days = 1 Dec 2026)", () => {
    expect(usThanksgiving(2026)).toBe("2026-11-26");
    expect(usThanksgiving(2027)).toBe("2027-11-25");
    expect(isoFromEpochDay(epochDayOf(usThanksgiving(2026)) + 5)).toBe("2026-12-01");
  });

  it("moves dates between years without inventing 29 February", () => {
    expect(sameMonthDayInYear("2028-02-29", 2027)).toBe("2027-02-28");
    expect(sameMonthDayInYear("2028-02-29", 2032)).toBe("2032-02-29");
    expect(sameMonthDayInYear("2026-01-30", 2027)).toBe("2027-01-30");
    // Same weekday nearest the same calendar date: Friday 30 Jan 2026 -> Friday 29 Jan 2027.
    expect(sameWeekdayNear("2026-01-30", 2027)).toBe("2027-01-29");
    expect(sameWeekdayNear("2027-01-29", 2028)).toBe("2028-01-28");
  });

  it("sameWeekdayNear keeps the weekday and stays within three days (property)", () => {
    const rng = createRng(31);
    for (let i = 0; i < 400; i++) {
      const date = isoFromEpochDay(epochDayOf("2020-01-01") + rng.int(3000));
      const year = 2021 + rng.int(12);
      const shifted = sameWeekdayNear(date, year);
      expect(weekdayOfEpochDay(epochDayOf(shifted))).toBe(weekdayOfEpochDay(epochDayOf(date)));
      expect(Math.abs(epochDayOf(shifted) - epochDayOf(sameMonthDayInYear(date, year)))).toBeLessThanOrEqual(3);
    }
  });
});

describe("study blackouts and available-day leads", () => {
  it("covers Thanksgiving Wednesday-Sunday and 22 Dec-2 Jan", () => {
    const periods = defaultBlackouts(2026, 2027);
    const thanksgiving = periods.find((p) => p.label === "Thanksgiving break" && p.start.startsWith("2026"))!;
    expect([thanksgiving.start, thanksgiving.end]).toEqual(["2026-11-25", "2026-11-29"]);
    const winter = periods.find((p) => p.label === "Winter break" && p.start === "2026-12-22")!;
    expect(winter.end).toBe("2027-01-02");
    const days = blackoutDaySet(periods);
    expect(days.has(epochDayOf("2026-12-25"))).toBe(true);
    expect(days.has(epochDayOf("2027-01-03"))).toBe(false);
  });

  it("counts a recommender's 21 days around the winter break (study fixture)", () => {
    const blackout = blackoutDaySet(defaultBlackouts(2026, 2027));
    // Calendar days: 8 Jan 2027 - 21 = 18 Dec 2026. Skipping 22 Dec-2 Jan: 6 Dec 2026.
    expect(subtractAvailableDays("2027-01-08", 21, new Set())).toBe("2026-12-18");
    expect(subtractAvailableDays("2027-01-08", 21, blackout)).toBe("2026-12-06");
    expect(subtractAvailableDays("2027-01-08", 0, blackout)).toBe("2027-01-08");
  });

  it("never returns a later date than the plain calendar count (property)", () => {
    const rng = createRng(5);
    const blackout = blackoutDaySet(defaultBlackouts(2025, 2030));
    for (let i = 0; i < 300; i++) {
      const date = isoFromEpochDay(epochDayOf("2026-01-01") + rng.int(1400));
      const days = rng.int(60);
      const plain = subtractAvailableDays(date, days, new Set());
      const available = subtractAvailableDays(date, days, blackout);
      expect(available <= plain).toBe(true);
      expect(epochDayOf(date) - epochDayOf(plain)).toBe(days);
    }
  });
});
