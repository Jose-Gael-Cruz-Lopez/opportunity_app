import { describe, expect, it } from "vitest";
import {
  academicYearStart,
  addDays,
  compareTermKeys,
  computeDueAt,
  computeSortAt,
  cycleKeyFromLabel,
  daysBetween,
  endOfLocalDay,
  enumerateTerms,
  freshness,
  isInSeason,
  isoWeekday,
  localDateTimeToInstant,
  parseCycleKey,
  parseIsoDate,
  resolveDeadlineForViewer,
  revisionChanged,
  termKeyForDate,
  toIsoInstant,
  verificationState,
  type DeadlineRevisionFields,
  type DeadlineTimeFields,
} from "./index";

const iso = (ms: number | null) => (ms === null ? null : toIsoInstant(ms));

// The four golden rows from the data model (sample shapes modelled on public program pages).
const goldwaterNomination: DeadlineTimeFields = {
  basis: "official",
  precision: "exact",
  tzMode: "fixed",
  localDate: "2027-01-29",
  localTime: "17:00",
  timeZone: "America/Chicago",
};
const trumanApplicantLocal: DeadlineTimeFields = {
  basis: "official",
  precision: "exact",
  tzMode: "applicant_local",
  localDate: "2027-02-02",
  localTime: "23:59",
  timeZone: null,
};
const campusInternal: DeadlineTimeFields = {
  basis: "official",
  precision: "exact",
  tzMode: "fixed",
  localDate: "2026-12-01",
  localTime: "23:59",
  timeZone: "America/New_York",
};
const predictedWindow: DeadlineTimeFields = {
  basis: "predicted",
  precision: "window",
  tzMode: "fixed",
  localDate: "2027-02-10",
  localTime: null,
  windowStart: "2027-01-25",
  windowEnd: "2027-02-25",
  timeZone: "America/New_York",
};

describe("deadline instants (golden rows)", () => {
  it("fixed exact row in Central time", () => {
    expect(iso(computeDueAt(goldwaterNomination))).toBe("2027-01-29T23:00:00.000Z");
    expect(iso(computeSortAt(goldwaterNomination))).toBe("2027-01-29T23:00:00.000Z");
  });

  it("applicant-local row has no due_at and sorts at the latest US zone", () => {
    expect(computeDueAt(trumanApplicantLocal)).toBeNull();
    expect(iso(computeSortAt(trumanApplicantLocal))).toBe("2027-02-03T10:59:00.000Z");
  });

  it("campus row in Eastern time", () => {
    expect(iso(computeDueAt(campusInternal))).toBe("2026-12-02T04:59:00.000Z");
  });

  it("predicted window has no due_at and sorts at the end of p10", () => {
    expect(computeDueAt(predictedWindow)).toBeNull();
    expect(iso(computeSortAt(predictedWindow))).toBe("2027-01-26T04:59:59.999Z");
  });

  it("date-only row means 23:59:59.999 local", () => {
    const d: DeadlineTimeFields = { ...campusInternal, precision: "date_only", localTime: null };
    expect(iso(computeDueAt(d))).toBe("2026-12-02T04:59:59.999Z");
  });

  it("month-only row sorts at the end of the month", () => {
    const d: DeadlineTimeFields = { ...campusInternal, precision: "month_only", localDate: "2027-03", localTime: null };
    expect(computeDueAt(d)).toBeNull();
    expect(iso(computeSortAt(d))).toBe("2027-04-01T03:59:59.999Z");
  });

  it("rolling and tbd rows have no instants", () => {
    for (const precision of ["rolling", "tbd"] as const) {
      const d: DeadlineTimeFields = { ...campusInternal, precision, localDate: null, localTime: null };
      expect(computeDueAt(d)).toBeNull();
      expect(computeSortAt(d)).toBeNull();
    }
  });

  it("handles Anchorage and Honolulu", () => {
    expect(iso(localDateTimeToInstant("2027-01-15", "17:00", "America/Anchorage"))).toBe("2027-01-16T02:00:00.000Z");
    expect(iso(localDateTimeToInstant("2027-07-15", "17:00", "Pacific/Honolulu"))).toBe("2027-07-16T03:00:00.000Z");
  });

  it("handles DST gaps and overlaps", () => {
    // 2027-03-14 02:30 does not exist in New York; it shifts forward to 03:30 EDT.
    expect(iso(localDateTimeToInstant("2027-03-14", "02:30", "America/New_York"))).toBe("2027-03-14T07:30:00.000Z");
    // 2027-11-07 01:30 occurs twice; the earlier (EDT) instant wins.
    expect(iso(localDateTimeToInstant("2027-11-07", "01:30", "America/New_York"))).toBe("2027-11-07T05:30:00.000Z");
    expect(iso(endOfLocalDay("2027-07-04", "America/Los_Angeles"))).toBe("2027-07-05T06:59:59.999Z");
  });
});

describe("resolveDeadlineForViewer", () => {
  it("converts a fixed deadline to the viewer's clock", () => {
    const v = resolveDeadlineForViewer(goldwaterNomination, "America/Los_Angeles");
    expect(v.viewerLocalDate).toBe("2027-01-29");
    expect(v.viewerLocalTime).toBe("15:00");
    expect(v.sourceTimeZone).toBe("America/Chicago");
    expect(v.timeStated).toBe(true);
  });

  it("evaluates applicant-local deadlines in the viewer's zone", () => {
    const v = resolveDeadlineForViewer(trumanApplicantLocal, "Pacific/Honolulu");
    expect(v.instantIso).toBe("2027-02-03T09:59:00.000Z");
    expect(v.viewerLocalDate).toBe("2027-02-02");
    expect(v.viewerLocalTime).toBe("23:59");
    expect(v.applicantLocal).toBe(true);
  });

  it("falls back to America/New_York for unknown zones", () => {
    const v = resolveDeadlineForViewer(trumanApplicantLocal, "Not/AZone");
    expect(v.viewerTimeZone).toBe("America/New_York");
    expect(v.instantIso).toBe("2027-02-03T04:59:00.000Z");
  });

  it("marks predicted windows approximate with no instant", () => {
    const v = resolveDeadlineForViewer(predictedWindow, "America/Chicago");
    expect(v.instant).toBeNull();
    expect(v.approximate).toBe(true);
    expect(v.predicted).toBe(true);
    expect(v.viewerLocalDate).toBe("2027-01-25");
  });
});

describe("revisionChanged", () => {
  const base: DeadlineRevisionFields = { ...goldwaterNomination, kind: "nomination", scope: "national", withdrawnAt: null };
  it("ignores unchanged rows and catches date, zone and withdrawal changes", () => {
    expect(revisionChanged(base, { ...base })).toBe(false);
    expect(revisionChanged(base, { ...base, localDate: "2027-01-30" })).toBe(true);
    expect(revisionChanged(base, { ...base, timeZone: "America/Denver" })).toBe(true);
    expect(revisionChanged(base, { ...base, withdrawnAt: 1 })).toBe(true);
  });
});

describe("iso dates", () => {
  it("never shifts a published date", () => {
    expect(parseIsoDate("2027-02-29")).toBeNull();
    expect(parseIsoDate("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(daysBetween("2026-11-11", "2027-01-29")).toBe(79);
    expect(isoWeekday("2027-01-29")).toBe(5);
  });
});

describe("season and freshness", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const day = 86_400_000;
  it("isInSeason", () => {
    expect(isInSeason({ status: "open" }, now)).toBe(true);
    expect(isInSeason({ status: "expected", opensOn: "2026-12-01" }, now)).toBe(true);
    expect(isInSeason({ status: "expected", opensOn: "2027-03-01" }, now)).toBe(false);
    expect(isInSeason({ status: "closed", deadlineSortAts: [now + 59 * day] }, now)).toBe(true);
    expect(isInSeason({ status: "closed", deadlineSortAts: [now - day, null] }, now)).toBe(false);
  });

  it("freshness windows differ in and out of season", () => {
    const row = (ageDays: number) => ({ verificationState: "verified" as const, lastVerifiedAt: now - ageDays * day });
    expect(freshness(row(10), now, true)).toBe("fresh");
    expect(freshness(row(20), now, true)).toBe("aging");
    expect(freshness(row(31), now, true)).toBe("stale");
    expect(freshness(row(20), now, false)).toBe("fresh");
    expect(freshness(row(60), now, false)).toBe("aging");
    expect(freshness(row(91), now, false)).toBe("stale");
    expect(verificationState(row(31), now, true)).toBe("stale");
    expect(verificationState({ verificationState: "unverified", lastVerifiedAt: null }, now, true)).toBe("unverified");
    expect(freshness({ verificationState: "verified", lastVerifiedAt: "2026-11-01T00:00:00Z" }, now, true)).toBe("fresh");
  });
});

describe("cycle and term keys", () => {
  it("parses and derives cycle keys", () => {
    expect(parseCycleKey("ay-2027-28")).toEqual({ term: "ay", year: 2027, endYear: 2028 });
    expect(parseCycleKey("ay-2027-29")).toBeNull();
    expect(parseCycleKey("summer-2027")).toEqual({ term: "summer", year: 2027, endYear: null });
    expect(cycleKeyFromLabel("Summer 2027 Program")).toBe("summer-2027");
    expect(cycleKeyFromLabel("2027-2028 academic year")).toBe("ay-2027-28");
    expect(cycleKeyFromLabel("Autumn 2026")).toBe("fall-2026");
    expect(cycleKeyFromLabel("no year here")).toBeNull();
  });

  it("orders and enumerates terms", () => {
    expect(compareTermKeys("spring-2027", "fall-2026")).toBeGreaterThan(0);
    expect(enumerateTerms("fall-2026", "summer-2027")).toEqual(["fall-2026", "spring-2027", "summer-2027"]);
    expect(termKeyForDate("2027-06-15")).toBe("summer-2027");
    expect(academicYearStart("2027-03-01")).toBe(2026);
    expect(academicYearStart("2026-08-20")).toBe(2026);
  });
});
