import { describe, expect, it } from "vitest";
import { HOLDOUT_RESUMES } from "./__fixtures__/holdout.sample";
import { SAMPLE_RESUMES } from "./__fixtures__/resumes.sample";
import { parseResumeText } from "./parse";
import { experienceMonths, inferClassYear, primaryEducation, ProfileSignalsSchema, SIGNAL_LIMITS, toProfileSignals } from "./signals";
import { resolveNow } from "./dates";
import { foldForMatch } from "./text";
import type { EducationEntry, ParsedResume } from "./types";

const NOW = "2026-11-11";

function edu(over: Partial<EducationEntry>): EducationEntry {
  return { institution: null, area: null, minor: null, studyType: null, degreeLevel: null, startDate: null, endDate: null, endDateExpected: false, score: null, gpa: null, courses: [], highlights: [], ...over };
}

function resume(over: Partial<ParsedResume>): ParsedResume {
  return {
    contact: { name: null, email: null, phone: null, location: null, aliases: [] },
    education: [],
    experience: [],
    projects: [],
    skills: [],
    coursework: [],
    awards: [],
    links: [],
    sections: [],
    warnings: [],
    ...over,
  };
}

describe("inferClassYear", () => {
  it.each([
    ["2030-05", "bachelor", "first_year"],
    ["2029-05", "bachelor", "second_year"],
    ["2028", "bachelor", "third_year"],
    ["2027-05", "bachelor", "fourth_year"],
    ["2031-05", "bachelor", "incoming_first_year"],
    ["2029-12", "bachelor", "first_year"],
    ["2026-05", "bachelor", "recent_graduate"],
    ["2027-05", "associate", "second_year"],
    ["2028-05", "associate", "first_year"],
    ["2027-05", "high_school", "incoming_first_year"],
    ["2030-05", "master", "graduate"],
    ["2035-05", "bachelor", null],
    [null, "bachelor", null],
  ] as const)("graduating %s (%s) on 2026-11-11 is %s", (end, level, year) => {
    expect(inferClassYear(end, level, NOW)).toBe(year);
  });

  it("rolls over in August", () => {
    expect(inferClassYear("2030-05", "bachelor", "2026-07-31")).toBe("incoming_first_year");
    expect(inferClassYear("2030-05", "bachelor", "2026-08-01")).toBe("first_year");
  });
});

describe("toProfileSignals", () => {
  const ALL = [...SAMPLE_RESUMES, ...HOLDOUT_RESUMES];

  it("lists the primary major's field before a minor's, whatever the taxonomy order", () => {
    const nursing = toProfileSignals(resume({ education: [edu({ area: "Nursing", minor: "Business", degreeLevel: "bachelor", endDate: "2029-05", endDateExpected: true })] }), { now: NOW });
    expect(nursing.fields[0]).toBe("health");
    expect(nursing.fields).toContain("business");
    const parsed = parseResumeText({ text: "Ana Ruiz\n\nEDUCATION\nState University\nBachelor of Science in Nursing, Minor in Business\nExpected May 2029" });
    expect(toProfileSignals(parsed, { now: NOW }).fields[0]).toBe("health");
  });

  it("emits only closed-vocabulary values that pass the strict schema", () => {
    for (const f of ALL) {
      const signals = toProfileSignals(parseResumeText({ ...f.input, now: f.now, hints: f.hints }), { now: f.now });
      expect(() => ProfileSignalsSchema.parse(signals), f.id).not.toThrow();
    }
  });

  it("carries no names, contact details, organizations or award names", () => {
    for (const f of ALL) {
      const json = foldForMatch(JSON.stringify(toProfileSignals(parseResumeText({ ...f.input, now: f.now, hints: f.hints }), { now: f.now })));
      for (const s of [...f.pii, ...f.withheld, ...f.sensitive]) expect(json.includes(foldForMatch(s)), `${f.id}: ${s}`).toBe(false);
    }
  });

  it("maps a sample resume to the expected signals", () => {
    const f = SAMPLE_RESUMES.find((s) => s.id === "classic-pasted")!;
    const signals = toProfileSignals(parseResumeText({ text: f.input.text, now: NOW }), { now: NOW });
    expect(signals).toMatchObject({
      fields: ["computing", "math_statistics"],
      majors: ["Computer Science", "Statistics"],
      coursework: ["Programming", "Data Structures", "Linear Algebra", "Discrete Math"],
      experienceTypes: ["research", "internship", "leadership", "independent_project"],
      degreeLevel: "bachelor",
      graduationYear: 2029,
      classYear: "second_year",
      classYearInferred: true,
      experienceMonths: 15,
    });
    expect(signals.skills).toEqual(expect.arrayContaining(["Python", "React Native", "PyTorch"]));
  });

  it("drops unknown skills and caps list sizes", () => {
    const many = Array.from({ length: 80 }, (_, i) => `Made Up Skill ${i}`);
    const known = ["Python", "Java", "SQL", "Excel", "Git", "React", "Figma", "Tableau", "MATLAB", "R"];
    const signals = toProfileSignals(resume({ skills: [...many, ...known, ...known] }), { now: NOW });
    expect(signals.skills).toEqual(known);
    expect(signals.skills.length).toBeLessThanOrEqual(SIGNAL_LIMITS.skills);
  });

  it("does not turn club membership into leadership", () => {
    const signals = toProfileSignals(
      resume({ experience: [{ kind: "club", position: "Member", organization: "Chess Club", location: null, startDate: null, endDate: null, current: false, highlights: [], section: "activities" }] }),
      { now: NOW },
    );
    expect(signals.experienceTypes).toEqual([]);
  });

  it("prefers a class year the resume states over one it infers", () => {
    const stated = resume({
      education: [edu({ institution: "Sample College", degreeLevel: "bachelor", endDate: "2029-05", endDateExpected: true })],
      sections: [{ key: "education", heading: "EDUCATION", lineStart: 0, lineEnd: 2, lines: ["Sample College", "Sophomore, B.A. History"] }],
    });
    expect(toProfileSignals(stated, { now: NOW })).toMatchObject({ classYear: "second_year", classYearInferred: false });
    const thesis = { ...stated, sections: [{ ...stated.sections[0]!, lines: ["Senior Thesis in History"] }] };
    expect(toProfileSignals(thesis, { now: NOW })).toMatchObject({ classYear: "second_year", classYearInferred: true });
  });

  it("picks the program in progress over high school", () => {
    const p = primaryEducation([
      edu({ institution: "Westlake High School", degreeLevel: "high_school", endDate: "2026-05" }),
      edu({ institution: "Sample University", degreeLevel: "bachelor", endDate: "2030-05", endDateExpected: true }),
    ]);
    expect(p?.institution).toBe("Sample University");
  });

  it("counts overlapping months once and stops open ranges at today", () => {
    const parsed = resume({
      experience: [
        { kind: "work", position: "A", organization: null, location: null, startDate: "2026-01", endDate: null, current: true, highlights: [], section: "experience" },
        { kind: "internship", position: "B", organization: null, location: null, startDate: "2026-06", endDate: "2026-08", current: false, highlights: [], section: "experience" },
        { kind: "work", position: "C", organization: null, location: null, startDate: "2027-01", endDate: "2027-05", current: false, highlights: [], section: "experience" },
      ],
    });
    expect(experienceMonths(parsed, resolveNow(NOW))).toBe(11);
  });

  it("rejects free text and unknown keys at the schema", () => {
    const base = toProfileSignals(resume({ skills: ["Python"] }), { now: NOW });
    expect(ProfileSignalsSchema.safeParse({ ...base, skills: ["Jane Doe"] }).success).toBe(false);
    expect(ProfileSignalsSchema.safeParse({ ...base, coursework: ["Intro to Islam"] }).success).toBe(false);
    expect(ProfileSignalsSchema.safeParse({ ...base, email: "x@example.com" }).success).toBe(false);
  });
});
