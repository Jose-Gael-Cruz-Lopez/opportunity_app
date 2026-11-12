import { describe, expect, it } from "vitest";
import {
  countdownText,
  daysUntil,
  describeDeadline,
  describeStageOdds,
  formatCycleKey,
  formatMoney,
  formatShortDate,
  formatTime12,
  hostOf,
  humanizeSlug,
  isHot,
  naturalFrequency,
  pickPrimaryDeadline,
  rulerPosition,
  todayIn,
  viewerTimeZone,
  type DeadlineLike,
} from "./format";

// 2026-11-11 12:00 UTC: 07:00 in New York, 04:00 in Los Angeles.
const NOW = Date.parse("2026-11-11T12:00:00.000Z");

const exact = (over: Partial<DeadlineLike> = {}): DeadlineLike => ({
  kind: "application",
  scope: "national",
  roundLabel: "",
  basis: "official",
  precision: "exact",
  tzMode: "fixed",
  localDate: "2027-01-28",
  localTime: "23:59",
  windowStart: null,
  windowEnd: null,
  timeZone: "America/New_York",
  sortAt: "2027-01-29T04:59:00.000Z",
  ...over,
});

describe("dates", () => {
  it("formats short dates with weekday and year", () => {
    expect(formatShortDate("2027-01-28")).toBe("Thu 28 Jan");
    expect(formatShortDate("2027-01-28", { year: true })).toBe("Thu 28 Jan 2027");
    expect(formatShortDate("2027-01-28", { weekday: false })).toBe("28 Jan");
    expect(formatShortDate("2027-01")).toBe("Jan 2027");
  });

  it("formats 12-hour times", () => {
    expect(formatTime12("23:59")).toBe("11:59 PM");
    expect(formatTime12("00:05")).toBe("12:05 AM");
    expect(formatTime12("12:00")).toBe("12:00 PM");
  });

  it("counts days, with month-only values counting to the month's end", () => {
    expect(daysUntil("2026-11-11", "2027-01-28")).toBe(78);
    expect(daysUntil("2026-11-11", "2026-11")).toBe(19);
    expect(daysUntil("2026-11-11", "nonsense")).toBeNull();
  });

  it("words countdowns and flags the two-week window", () => {
    expect(countdownText(79)).toBe("79 days left");
    expect(countdownText(1)).toBe("1 day left");
    expect(countdownText(0)).toBe("Due today");
    expect(countdownText(-2)).toBe("Closed");
    expect(countdownText(null)).toBe("Date not set");
    expect(isHot(14)).toBe(true);
    expect(isHot(15)).toBe(false);
    expect(isHot(-1)).toBe(false);
  });

  it("uses the profile zone, then the browser's, then the fallback", () => {
    expect(viewerTimeZone("America/Chicago", "Europe/London")).toBe("America/Chicago");
    expect(viewerTimeZone(null, "Europe/London")).toBe("Europe/London");
    expect(viewerTimeZone(null, null)).toBe("America/New_York");
    expect(todayIn(NOW, "Pacific/Kiritimati")).toBe("2026-11-12");
  });
});

describe("describeDeadline", () => {
  it("states the official zone and the viewer's clock when they differ", () => {
    const s = describeDeadline(exact(), NOW, "America/Los_Angeles");
    expect(s.verb).toBe("Closes");
    expect(s.officialText).toBe("Thu 28 Jan 2027, 11:59 PM EST");
    expect(s.viewerText).toBe("(8:59 PM your time)");
    expect(s.daysLeft).toBe(78);
    expect(s.passed).toBe(false);
    expect(s.timeStated).toBe(true);
  });

  it("omits the viewer line when the clocks agree", () => {
    expect(describeDeadline(exact(), NOW, "America/New_York").viewerText).toBeNull();
  });

  it("notes the day when the viewer's date differs", () => {
    const s = describeDeadline(exact(), NOW, "Europe/London");
    expect(s.viewerText).toBe("(4:59 AM your time on Fri 29 Jan)");
    expect(s.date).toBe("2027-01-29");
  });

  it("handles applicant-local, month-only, window, rolling and TBD rows", () => {
    expect(describeDeadline(exact({ tzMode: "applicant_local", timeZone: null }), NOW, "America/Chicago").officialText).toBe("Thu 28 Jan 2027, 11:59 PM your time");
    const month = describeDeadline(exact({ precision: "month_only", localDate: "2027-02", localTime: null }), NOW, "America/Chicago");
    expect(month.officialText).toBe("Sometime in Feb 2027");
    expect(month.approximate).toBe(true);
    const win = describeDeadline(exact({ basis: "predicted", precision: "window", localDate: null, localTime: null, windowStart: "2027-01-10", windowEnd: "2027-02-05" }), NOW, "America/Chicago");
    expect(win.officialText).toBe("Expected 10 Jan to 5 Feb 2027");
    expect(win.predicted).toBe(true);
    expect(describeDeadline(exact({ precision: "rolling", localDate: null, localTime: null }), NOW, "UTC").officialText).toMatch(/Rolling/);
    expect(describeDeadline(exact({ precision: "tbd", localDate: null, localTime: null }), NOW, "UTC").officialText).toMatch(/not announced/);
  });

  it("marks a passed deadline", () => {
    const s = describeDeadline(exact({ localDate: "2026-11-01" }), NOW, "America/New_York");
    expect(s.passed).toBe(true);
    expect(s.daysLeft).toBeLessThan(0);
  });

  it("prefixes the round label", () => {
    expect(describeDeadline(exact({ kind: "priority_round", roundLabel: "Early" }), NOW, "UTC").verb).toBe("Early: Priority round closes");
  });
});

describe("pickPrimaryDeadline", () => {
  it("prefers the next live national deadline, then the latest passed one", () => {
    const past = exact({ localDate: "2026-10-01" });
    const soon = exact({ localDate: "2026-12-01" });
    const later = exact({ localDate: "2027-02-01" });
    const campus = exact({ scope: "campus", localDate: "2026-11-20" });
    const letters = exact({ kind: "recommendation", localDate: "2026-11-15" });
    expect(pickPrimaryDeadline([later, past, soon, campus, letters], NOW, "UTC")).toBe(soon);
    expect(pickPrimaryDeadline([past, exact({ localDate: "2026-09-01" })], NOW, "UTC")).toBe(past);
    expect(pickPrimaryDeadline([exact({ withdrawnAt: "2026-11-01T00:00:00.000Z" })], NOW, "UTC")).toBeNull();
  });
});

describe("rulerPosition", () => {
  it("places today inside the window and clamps outside it", () => {
    const r = rulerPosition("2026-08-27", "2027-01-28", "2026-11-11");
    expect(r?.totalDays).toBe(154);
    expect(r?.day).toBe(76);
    expect(r?.fraction).toBeCloseTo(76 / 154);
    expect(r?.label).toBe("Day 76 of a 154-day application window");
    expect(rulerPosition("2026-08-27", "2027-01-28", "2027-03-01")?.fraction).toBe(1);
    expect(rulerPosition(null, "2027-01-28", "2026-11-11")).toBeNull();
    expect(rulerPosition("2027-01-28", "2027-01-28", "2026-11-11")).toBeNull();
  });
});

describe("official odds", () => {
  it("turns k of n into a natural frequency, never a percentage", () => {
    expect(naturalFrequency(454, 1485, "exact")).toBe("about 3 in 10");
    expect(naturalFrequency(55, 781, "exact")).toBe("about 7 in 100");
    expect(naturalFrequency(1, 2, "exact")).toBe("1 in 2");
    expect(naturalFrequency(120, 1000, "lower_bound")).toMatch(/^at most /);
    expect(naturalFrequency(0, 10, "exact")).toBe("none");
    expect(naturalFrequency(10, 10, "exact")).toBe("everyone");
    for (const s of [naturalFrequency(454, 1485, "exact"), naturalFrequency(3, 7, "approx")]) expect(s).not.toMatch(/%/);
  });

  it("never says 'about' for very low rates it cannot match within 5%", () => {
    // Before the fix all three read "about 1 in 1000", overstating the odds up to five times.
    expect(naturalFrequency(1, 5000, "exact")).toBe("fewer than 1 in 1000");
    expect(naturalFrequency(3, 12000, "exact")).toBe("fewer than 1 in 1000");
    expect(naturalFrequency(7, 10000, "exact")).toBe("fewer than 1 in 1000");
    expect(naturalFrequency(7, 10000, "approx")).toBe("fewer than 1 in 1000");
    expect(naturalFrequency(1, 5000, "lower_bound")).toBe("fewer than 1 in 1000");
    // 1.5 per 1000: neither 1 nor 2 in 1000 is within 5%, so it reads as a bracket.
    expect(naturalFrequency(15, 10000, "exact")).toBe("between 1 and 2 in 1000");
    expect(naturalFrequency(15, 10000, "lower_bound")).toBe("at most 2 in 1000");
    // Still "about" when a denominator is close enough.
    expect(naturalFrequency(12, 1000, "approx")).toBe("about 12 in 1000");
  });

  it("every 'about' phrase is within 5% of the true rate", () => {
    for (const [k, n] of [[1, 5000], [3, 12000], [7, 10000], [15, 10000], [55, 781], [454, 1485], [3, 7], [2, 1999]] as const) {
      const phrase = naturalFrequency(k, n, "exact");
      const m = /^about (\d+) in (\d+)$/.exec(phrase);
      if (!m) continue;
      const shown = Number(m[1]) / Number(m[2]);
      expect(Math.abs(shown - k / n) / (k / n)).toBeLessThanOrEqual(0.05);
    }
  });

  it("an at-most phrase is a true upper bound", () => {
    const phrase = naturalFrequency(120, 1000, "lower_bound");
    const [, k, d] = /(\d+) in (\d+)/.exec(phrase) ?? [];
    expect(Number(k) / Number(d)).toBeGreaterThanOrEqual(120 / 1000);
  });

  it("describes stage odds with source and the student's stage", () => {
    const v = describeStageOdds(
      { fromStage: "nominees", toStage: "awards", cycleYear: 2026, numerator: 454, denominator: 1485, denominatorKind: "exact", sourceUrl: "https://example.org/r", verifiedAt: "2026-11-09", verifiedBy: "Curator AB" },
      "nominees",
    );
    expect(v.headline).toBe("454 awards from 1,485 nominees");
    expect(v.natural).toBe("about 3 in 10 nominees");
    expect(v.current).toBe(true);
    expect(v.verified).toBe("Checked 9 Nov 2026 by Curator AB");
  });
});

describe("small formatters", () => {
  it("formats money, cycle keys, slugs and hosts", () => {
    expect(formatMoney(750000)).toBe("$7,500");
    expect(formatMoney(1250)).toBe("$12.50");
    expect(formatCycleKey("ay-2026-27")).toBe("2026-27");
    expect(formatCycleKey("summer-2027")).toBe("Summer 2027");
    expect(humanizeSlug("sample-scholars-program")).toBe("Sample Scholars Program");
    expect(hostOf("https://www.example.org/a")).toBe("example.org");
    expect(hostOf("not a url")).toBe("not a url");
  });
});
