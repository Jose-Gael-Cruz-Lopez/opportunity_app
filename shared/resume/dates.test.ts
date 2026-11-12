import { describe, expect, it } from "vitest";
import { expandTwoDigitYear, findDates, formatIso, isFuture, monthsSpanned, parseDateRange, resolveNow } from "./dates";

const NOW = "2026-11-11";

type Row = [input: string, start: string | null, end: string | null, flags?: { open?: boolean; expected?: boolean; graduation?: boolean; single?: boolean }];

/** The date grammar's contract: 60+ resume date forms and the iso8601 values they become. */
const TABLE: Row[] = [
  // Month Year ranges
  ["Jun 2025 - Aug 2025", "2025-06", "2025-08"],
  ["June 2025 – August 2025", "2025-06", "2025-08"],
  ["Jun. 2025 — Aug. 2025", "2025-06", "2025-08"],
  ["Sept 2024 to May 2025", "2024-09", "2025-05"],
  ["Sep 2024 through May 2025", "2024-09", "2025-05"],
  ["January 2026 – Present", "2026-01", null, { open: true }],
  ["Jan 2026 - Current", "2026-01", null, { open: true }],
  ["Jan 2026 – Now", "2026-01", null, { open: true }],
  ["Jan 2026 - ongoing", "2026-01", null, { open: true }],
  ["Oct 2025 – present", "2025-10", null, { open: true }],
  ["Dec 2024-Feb 2025", "2024-12", "2025-02"],
  ["Mar 2023 – Mar 2024", "2023-03", "2024-03"],
  // Shared year
  ["Jun - Aug 2025", "2025-06", "2025-08"],
  ["Nov - Feb 2025", "2024-11", "2025-02"],
  ["May – July 2026", "2026-05", "2026-07"],
  // Numeric
  ["05/2025 - 08/2025", "2025-05", "2025-08"],
  ["5/2025 – 8/2025", "2025-05", "2025-08"],
  ["01/2026 – Present", "2026-01", null, { open: true }],
  ["2025-06 to 2025-08", "2025-06", "2025-08"],
  ["06/25 - 08/25", "2025-06", "2025-08"],
  ["2025-06-01 - 2025-08-15", "2025-06-01", "2025-08-15"],
  // Seasons and terms
  ["Summer 2025", "2025-06", "2025-08", { single: true }],
  ["Fall 2025", "2025-09", "2025-12", { single: true }],
  ["Spring 2026", "2026-01", "2026-05", { single: true }],
  ["Autumn 2025", "2025-09", "2025-12", { single: true }],
  ["Fall Semester 2025", "2025-09", "2025-12", { single: true }],
  ["Fall 2024 - Spring 2025", "2024-09", "2025-05"],
  ["Winter 2024 - Spring 2025", "2024-12", "2025-05"],
  ["Winter 2025 – Spring 2025", "2025-01", "2025-05"],
  ["Summer '25", "2025-06", "2025-08", { single: true }],
  // Years
  ["2024 - 2025", "2024", "2025"],
  ["2023–Present", "2023", null, { open: true }],
  ["2024-25", "2024", "2025"],
  ["2025 – 2029", "2025", "2029"],
  ["'24 - '25", "2024", "2025"],
  ["2025", "2025", "2025", { single: true }],
  ["since 2024", "2024", null, { open: true }],
  // Single month and full dates
  ["May 2025", "2025-05", "2025-05", { single: true }],
  ["March 3, 2026", "2026-03-03", "2026-03-03", { single: true }],
  ["3 March 2026", "2026-03-03", "2026-03-03", { single: true }],
  ["Mar '26", "2026-03", "2026-03", { single: true }],
  // Graduation forms
  ["Expected May 2029", null, "2029-05", { expected: true, graduation: true }],
  ["Expected Graduation: May 2029", null, "2029-05", { expected: true, graduation: true }],
  ["Anticipated June 2030", null, "2030-06", { expected: true, graduation: true }],
  ["Exp. May 2029", null, "2029-05", { expected: true, graduation: true }],
  ["Class of 2030", null, "2030", { graduation: true }],
  ["Graduation: May 2028", null, "2028-05", { graduation: true }],
  ["May 2029 (expected)", null, "2029-05", { expected: true, graduation: true }],
  ["Expected 04/2029", null, "2029-04", { expected: true, graduation: true }],
  ["Expected 05/29", null, "2029-05", { expected: true, graduation: true }],
  ["Aug 2025 – May 2029 (Expected)", "2025-08", "2029-05", { expected: true, graduation: true }],
  ["Graduating Spring 2030", null, "2030-05", { graduation: true }],
  // Embedded in a line
  ["Software Intern | Acme | Jun 2026 - Aug 2026", "2026-06", "2026-08"],
  ["Treasurer, Chess Club (Sep 2025 – Present)", "2025-09", null, { open: true }],
  ["Cornell University                Expected May 2029", null, "2029-05", { expected: true, graduation: true }],
];

/** Numbers that must not read as dates. */
const NOT_DATES: string[] = [
  "Raised $2025 for the food bank",
  "CS 2110: Data Structures",
  "BIO 2020 lab section",
  "Ithaca, NY 14850",
  "Call 555 010-2024",
  "Served 1200 meals",
  "GPA 3.85",
  "Scored 2400 on the exam",
  "Room 1980",
  "3rd place of 2000 teams",
  "Grew revenue 2023% (typo)",
  "Bought 2019k units",
  "May I help you",
  "06/25 shift notes",
];

describe("findDates: the 60-case table", () => {
  it("has at least 55 rows plus negatives", () => {
    expect(TABLE.length + NOT_DATES.length).toBeGreaterThanOrEqual(60);
  });

  for (const [input, start, end, flags] of TABLE) {
    it(input, () => {
      const d = parseDateRange(input, NOW);
      expect(d, input).not.toBeNull();
      expect(d!.start).toBe(start);
      expect(d!.end).toBe(end);
      expect(d!.open).toBe(flags?.open ?? false);
      if (flags?.expected !== undefined) expect(d!.expected).toBe(flags.expected);
      if (flags?.graduation !== undefined) expect(d!.graduation).toBe(flags.graduation);
      if (flags?.single !== undefined) expect(d!.single).toBe(flags.single);
      // Output always fits JSON Resume's iso8601 pattern.
      for (const v of [d!.start, d!.end]) if (v !== null) expect(v).toMatch(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/);
    });
  }

  for (const input of NOT_DATES) {
    it(`no date in "${input}"`, () => {
      expect(findDates(input, NOW)).toEqual([]);
    });
  }
});

describe("date helpers", () => {
  it("finds several ranges in one line without overlaps", () => {
    const found = findDates("Jun 2024 - Aug 2024; Jun 2025 - Aug 2025", NOW);
    expect(found.map((d) => [d.start, d.end])).toEqual([
      ["2024-06", "2024-08"],
      ["2025-06", "2025-08"],
    ]);
  });

  it("expands two-digit years six years ahead at most", () => {
    const now = resolveNow(NOW);
    expect(expandTwoDigitYear(32, now)).toBe(2032);
    expect(expandTwoDigitYear(33, now)).toBe(1933);
    expect(expandTwoDigitYear(5, now)).toBe(2005);
  });

  it("rejects years outside 1950..now+8", () => {
    expect(findDates("Class of 2040", NOW)).toEqual([]);
    expect(findDates("1940 - 1945", NOW)).toEqual([]);
    expect(findDates("1949 - 1950", NOW).map((d) => d.start)).toEqual(["1950"]);
  });

  it("reads 'now' as a calendar date, not an instant", () => {
    expect(resolveNow("2026-11-11")).toEqual({ year: 2026, month: 11, day: 11 });
    expect(resolveNow(new Date(Date.UTC(2026, 0, 31)))).toEqual({ year: 2026, month: 1, day: 31 });
    expect(resolveNow("not a date").year).toBeGreaterThan(2000);
  });

  it("formats, compares and counts months", () => {
    expect(formatIso(2026, 3)).toBe("2026-03");
    expect(formatIso(2026, null)).toBe("2026");
    expect(isFuture("2029-05", resolveNow(NOW))).toBe(true);
    expect(isFuture("2026-10", resolveNow(NOW))).toBe(false);
    expect(monthsSpanned("2025-06", "2025-08")).toBe(3);
    expect(monthsSpanned("2025-08", "2025-06")).toBe(0);
  });
});
