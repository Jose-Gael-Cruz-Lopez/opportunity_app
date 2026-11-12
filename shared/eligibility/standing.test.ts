import { describe, expect, it } from "vitest";
import { buildEvalContext, type DeadlineLike } from "./context";
import { possibleAges, projectClassYear, remainingNativeTerms, semesterEquivalentsRemaining, termEndDate, termsPerYear } from "./standing";

describe("remaining terms counted from a rule's date", () => {
  // Plan 6.4.4: counted from 1 September 2027 (program start), never from a winter deadline.
  const start = "2027-09-01";
  it.each([
    ["spring-2029", 4],
    ["fall-2027", 1],
    ["spring-2027", 0],
    ["spring-2030", 6],
    ["summer-2029", 4], // a summer graduation term adds no full-time term
  ])("semester, graduating %s -> %i", (grad, n) => {
    expect(remainingNativeTerms(grad, start, "semester")).toBe(n);
  });

  it("counting at a January deadline instead would add the spring term (the false yes the anchor avoids)", () => {
    expect(remainingNativeTerms("spring-2029", "2027-01-29", "semester")).toBe(5);
    expect(remainingNativeTerms("spring-2027", "2027-01-29", "semester")).toBe(1);
  });

  it("4-1-4 counts like semesters (the January term is not a full-time term)", () => {
    expect(remainingNativeTerms("spring-2029", start, "four_one_four")).toBe(4);
    expect(termsPerYear("four_one_four")).toBe(2);
  });

  it.each([
    ["spring-2028", 3],
    ["winter-2029", 5],
    ["spring-2029", 6],
    ["spring-2030", 9],
  ])("quarter, graduating %s -> %i quarters", (grad, n) => {
    expect(remainingNativeTerms(grad, start, "quarter")).toBe(n);
    expect(remainingNativeTerms(grad, start, "trimester")).toBe(n);
  });

  it("converts quarters to semester-equivalents with half a native term of slack", () => {
    const eq = semesterEquivalentsRemaining("spring-2028", start, "quarter");
    expect(eq.exact).toBe(false);
    expect(eq.lo).toBeCloseTo(5 / 3, 10);
    expect(eq.hi).toBeCloseTo(7 / 3, 10);
    expect(semesterEquivalentsRemaining("spring-2029", start, "semester")).toEqual({ exact: true, lo: 4, hi: 4, nativeTerms: 4 });
    expect(semesterEquivalentsRemaining("spring-2027", start, "quarter").lo).toBe(0);
  });

  it("term end dates are per calendar", () => {
    expect(termEndDate("spring-2029")).toBe("2029-05-31");
    expect(termEndDate("spring-2029", "quarter")).toBe("2029-06-15");
    expect(termEndDate("winter-2029", "quarter")).toBe("2029-03-31");
    expect(() => termEndDate("autumn-2029")).toThrow(RangeError);
  });
});

describe("ages from a birth month", () => {
  it("gives one age when the anchor is outside the birth month", () => {
    expect(possibleAges("2008-12", "2027-02-01")).toEqual([18]);
    expect(possibleAges("2009-03", "2027-02-01")).toEqual([17]);
  });

  it("gives two ages when the limit falls inside the birth month", () => {
    expect(possibleAges("2009-02", "2027-02-01")).toEqual([17, 18]);
    expect(possibleAges("2009-02", "2027-02-28")).toEqual([18]);
  });

  it("counts a birthday on the day itself, and a 29 February birthday from 1 March in common years", () => {
    expect(possibleAges("2008-02", "2027-02-28")).toEqual([18, 19]);
    expect(possibleAges("2008-02", "2027-03-01")).toEqual([19]);
    expect(possibleAges("2008-02", "2026-02-28")).toEqual([17, 18]);
    expect(possibleAges("2008-02", "2026-03-01")).toEqual([18]);
  });
});

describe("class year projected to a later date", () => {
  const base = { today: "2027-01-15", anchor: "2027-09-01", calendar: "semester" as const, academicYearStartMonth: 8 };
  it("moves up one year across an academic-year boundary", () => {
    expect(projectClassYear({ ...base, reported: "first_year", gradTerm: "spring-2030" })).toEqual({ years: ["second_year"], conflict: false });
    expect(projectClassYear({ ...base, reported: "incoming_first_year", gradTerm: null })).toEqual({ years: ["first_year"], conflict: false });
  });

  it("does not move within the same academic year", () => {
    expect(projectClassYear({ ...base, anchor: "2027-05-01", reported: "first_year", gradTerm: null }).years).toEqual(["first_year"]);
  });

  it("a senior without a graduation term may be a fifth-year or a recent graduate", () => {
    expect(projectClassYear({ ...base, reported: "fourth_year", gradTerm: null }).years).toEqual(["fifth_year_plus", "recent_graduate"]);
    expect(projectClassYear({ ...base, reported: "fourth_year", gradTerm: "spring-2027" }).years).toEqual(["recent_graduate"]);
    expect(projectClassYear({ ...base, reported: "fourth_year", gradTerm: "spring-2028" }).years).toEqual(["fifth_year_plus"]);
  });

  it("flags a graduation term that contradicts normal progression instead of guessing", () => {
    expect(projectClassYear({ ...base, reported: "first_year", gradTerm: "spring-2027" })).toEqual({ years: ["second_year", "recent_graduate"], conflict: true });
  });

  it("leaves graduate and recent-graduate standings alone", () => {
    expect(projectClassYear({ ...base, reported: "graduate", gradTerm: null }).years).toEqual(["graduate"]);
  });
});

describe("buildEvalContext", () => {
  const inst = { id: "00000000-0000-4000-8000-000000000301", level: "four_year" as const, calendar: "semester" as const };
  const row = (over: Partial<DeadlineLike>): DeadlineLike => ({
    kind: "application",
    scope: "national",
    institutionId: null,
    basis: "official",
    localDate: "2027-01-29",
    withdrawnAt: null,
    ...over,
  });

  it("anchors national_deadline on a national nomination row (nomination-gated programs)", () => {
    const ctx = buildEvalContext({ deadlines: [row({ kind: "nomination", localDate: "2027-01-29" }), row({ kind: "program_start", localDate: "2027-06" })] });
    expect(ctx.anchors.national_deadline).toBe("2027-01-29");
    // A campus nomination row is a campus date, never the national anchor.
    const campusOnly = buildEvalContext({ deadlines: [row({ kind: "nomination", scope: "campus", institutionId: inst.id, localDate: "2026-12-05" })], institution: inst });
    expect(campusOnly.anchors.national_deadline).toBeNull();
    expect(campusOnly.anchors.campus_deadline).toBe("2026-12-05");
  });

  it("picks the final national application date, the program start and the campus date", () => {
    const ctx = buildEvalContext({
      deadlines: [
        row({ localDate: "2026-12-01", kind: "priority_round" }),
        row({ localDate: "2027-01-29" }),
        row({ localDate: "2026-11-15" }),
        row({ kind: "program_start", localDate: "2027-09" }),
        row({ kind: "campus_internal", scope: "campus", institutionId: inst.id, localDate: "2026-12-05" }),
        row({ kind: "campus_internal", scope: "campus", institutionId: "00000000-0000-4000-8000-000000000999", localDate: "2026-11-01" }),
        row({ localDate: "2027-03-01", basis: "predicted" }),
        row({ localDate: "2027-04-01", withdrawnAt: "2026-10-01T00:00:00Z" }),
      ],
      institution: inst,
      participatingInstitutionIds: [inst.id],
    });
    expect(ctx.anchors).toEqual({ national_deadline: "2027-01-29", program_start: "2027-09-01", campus_deadline: "2026-12-05" });
    expect(ctx.institution).toEqual({ ...inst, academicYearStartMonth: 8, participates: true });
  });

  it("prefers the student's own campus date and never records non-participation as false", () => {
    const ctx = buildEvalContext({ institution: inst, ownCampusDeadline: "2026-11-20", participatingInstitutionIds: [] });
    expect(ctx.anchors.campus_deadline).toBe("2026-11-20");
    expect(ctx.institution?.participates).toBeNull();
    expect(buildEvalContext().institution).toBeNull();
  });
});
