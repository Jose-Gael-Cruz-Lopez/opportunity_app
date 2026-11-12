import { describe, expect, it } from "vitest";
import {
  applyReviewEdits,
  builderIsEmpty,
  builderToText,
  dedupe,
  editsFromReview,
  gradYearOf,
  mergeSignals,
  normalizeSignals,
  removalSummary,
  removedForReview,
  reviewFromParsed,
  signalChips,
  splitPlaceholders,
  splitTerms,
  toEngineSignals,
  yearInSchool,
} from "./resume-view";

/** SAMPLE parsed resume in the agreed JSON Resume-style shape (fictional person). */
const SAMPLE_PARSED = {
  contact: { name: "Sample Student", email: "sample@example.com", phone: "555-0100", location: "Springfield, IL", aliases: [] },
  links: [{ url: "https://github.com/sample" }],
  education: [{ institution: "Sample State University", area: "Computer Science", studyType: "BS", endDate: "2030-05", courses: [] }],
  experience: [
    { organization: "Sample Robotics Club", position: "Treasurer", kind: "club", startDate: "2025-09", highlights: ["Ran a $2k budget"] },
    { organization: "Sample Cafe", position: "Barista", kind: "part-time", startDate: "2024-06", endDate: "2025-08", highlights: [] },
  ],
  projects: [{ name: "Tide tracker", description: "Python script for tide data", highlights: ["Plotted 3 years of data"] }],
  skills: ["Python", "SQL"],
  coursework: ["Data Structures"],
  awards: [],
  sections: [],
  warnings: ["two-column-guess"],
  futureField: { kept: true },
};

describe("review model", () => {
  it("lists contact items by label only and reads entries", () => {
    const v = reviewFromParsed(SAMPLE_PARSED);
    expect(v.contactFound).toEqual(["Name", "Email", "Phone", "Location", "1 link"]);
    expect(JSON.stringify(v.contactFound)).not.toContain("sample@example.com");
    expect(v.education[0]).toEqual({ institution: "Sample State University", area: "Computer Science", studyType: "BS", endDate: "2030-05" });
    expect(v.experience.map((e) => [e.title, e.organization, e.kind, e.dates])).toEqual([
      ["Treasurer", "Sample Robotics Club", "club", "2025-09"],
      ["Barista", "Sample Cafe", "part_time", "2024-06 to 2025-08"],
    ]);
    expect(v.projects[0].highlights).toEqual(["Plotted 3 years of data", "Python script for tide data"]);
    expect(v.skills).toEqual(["Python", "SQL"]);
    expect(v.warnings).toEqual(["two-column-guess"]);
  });

  it("tolerates an empty or malformed parse", () => {
    const v = reviewFromParsed(null);
    expect(v).toEqual({ contactFound: [], education: [], experience: [], projects: [], skills: [], coursework: [], warnings: [] });
  });

  it("applies corrections without touching other fields or the input", () => {
    const edits = { ...editsFromReview(reviewFromParsed(SAMPLE_PARSED)), skills: ["Python", "python", "Excel"], major: "Data Science", removedExperience: [1], kinds: { 0: "leadership" as const } };
    expect(reviewFromParsed({ experience: [{ kind: "mystery" }] }).experience[0].kind).toBe("work");
    const out = applyReviewEdits(SAMPLE_PARSED, edits) as typeof SAMPLE_PARSED;
    expect(out.skills).toEqual(["Python", "Excel"]);
    expect(out.education[0].area).toBe("Data Science");
    expect(out.education[0].institution).toBe("Sample State University");
    expect(out.experience).toHaveLength(1);
    expect(out.experience[0].kind).toBe("leadership");
    expect(out.contact).toBe(SAMPLE_PARSED.contact);
    expect(out.futureField).toEqual({ kept: true });
    expect(SAMPLE_PARSED.experience).toHaveLength(2);
  });

  it("adds an education entry when the parse had none but the student typed a major", () => {
    const out = applyReviewEdits({ education: [] }, { skills: [], coursework: [], major: "Biology", gradDate: "2030", removedExperience: [], kinds: {} }) as { education: Array<Record<string, unknown>> };
    expect(out.education).toEqual([{ area: "Biology", endDate: "2030" }]);
  });
});

describe("terms and the mini builder", () => {
  it("splits and dedupes chip input", () => {
    expect(splitTerms("Python, SQL; excel | python\n• R")).toEqual(["Python", "SQL", "excel", "R"]);
    expect(dedupe(["  A  b ", "a B", ""])).toEqual(["A b"]);
  });

  it("turns three answers into a small resume with lexicon headings", () => {
    const text = builderToText({ project: "Built a budget app", activity: "Tutor at the writing center", skills: "Python, Excel" });
    expect(text).toBe("PROJECTS\n- Built a budget app\nACTIVITIES\n- Tutor at the writing center\nSKILLS\nPython, Excel");
    expect(builderToText({ project: "", activity: "", skills: "Excel" })).toBe("SKILLS\nExcel");
    expect(builderIsEmpty({ project: " ", activity: "", skills: "" })).toBe(true);
  });
});

describe("signals", () => {
  it("reads toProfileSignals output tolerantly and drops unsafe terms", () => {
    const s = normalizeSignals({
      skills: ["Python", { label: "SQL" }, "bad\nterm", "<script>", "x".repeat(61)],
      fieldsOfStudy: ["computing"],
      coursework: ["Data Structures"],
      experienceTypes: ["club", "research"],
      graduationYear: 2030,
    });
    expect(s).toEqual({ skills: ["Python", "SQL"], fields: ["computing"], courseworkKeywords: ["Data Structures"], experienceKinds: ["club", "research"], gradYear: 2030 });
    expect(normalizeSignals({ gradYear: 1990 }).gradYear).toBeNull();
  });

  it("merges accepted AI suggestions without duplicates", () => {
    const base = normalizeSignals({ skills: ["Python"], gradYear: 2030 });
    const m = mergeSignals(base, { skills: ["python", "Tableau"], gradYear: 2029 });
    expect(m.skills).toEqual(["Python", "Tableau"]);
    expect(m.gradYear).toBe(2030);
  });

  it("maps to the field names the matching engine reads", () => {
    const s = normalizeSignals({ skills: ["Python"], coursework: ["Stats"], experienceKinds: ["club"], gradYear: 2030 });
    expect(toEngineSignals(s)).toEqual({ skills: ["Python"], fields: [], coursework: ["Stats"], experienceTypes: ["club"], graduationYear: 2030 });
  });

  it("labels signal chips in words", () => {
    const v = normalizeSignals({ skills: ["Python"], fields: ["computing"], experienceTypes: ["paid_work", "teaching_or_tutoring", "odd_kind"] });
    expect(signalChips(v)).toEqual(["Python", "Computing", "Work", "Tutoring", "odd kind"]);
  });

  it("infers year in school as the study notes define it", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    expect(yearInSchool(2030, now)).toBe(1);
    expect(yearInSchool(2029, now)).toBe(2);
    expect(yearInSchool(2035, now)).toBe(1);
    expect(yearInSchool(2020, now)).toBe(5);
    // Before August the academic year ends this calendar year: class of 2029 is first-year in May 2026.
    expect(yearInSchool(2029, new Date("2026-05-01T12:00:00Z"))).toBe(1);
    expect(yearInSchool(2028, new Date("2026-05-01T12:00:00Z"))).toBe(2);
    expect(gradYearOf("May 2030")).toBe(2030);
    expect(gradYearOf("2030-05")).toBe(2030);
    expect(gradYearOf(null)).toBeNull();
  });
});

describe("redaction summary and preview", () => {
  it("counts removals without naming a category", () => {
    expect(removalSummary([{ kind: "email" }, { kind: "phone" }, { kind: "name" }, { kind: "sensitive" }, { kind: "withheld" }, { kind: "limit" }])).toEqual({ contact: 3, sensitive: 1, withheld: 2 });
  });

  it("lists what was taken out for the student's review only", () => {
    const items = removedForReview([
      { kind: "email", reason: "Contact details stay on your device.", original: "sample@example.com", placeholder: "[email]" },
      { kind: "sensitive", reason: "Personal background stays on your device.", original: "Member, Sample Club", placeholder: "[removed]" },
      { kind: "limit", reason: "Too long", original: "", placeholder: "" },
    ]);
    expect(items).toEqual([
      { placeholder: "[email]", original: "sample@example.com", reason: "Contact details stay on your device." },
      { placeholder: "[removed]", original: "Member, Sample Club", reason: "Personal background stays on your device." },
    ]);
    expect(JSON.stringify(items)).not.toMatch(/religion|veteran|citizenship|income/);
  });

  it("splits placeholders for highlighting without changing the text", () => {
    const text = "Built [removed] tool; contact [email] or [phone]. Not a placeholder: [foo]";
    const segs = splitPlaceholders(text);
    expect(segs.map((s) => s.text).join("")).toBe(text);
    expect(segs.filter((s) => s.placeholder).map((s) => s.text)).toEqual(["[removed]", "[email]", "[phone]"]);
  });
});
