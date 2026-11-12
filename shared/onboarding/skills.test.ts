import { describe, expect, it } from "vitest";
// Data only (no parser code): the curated names shared/resume's ProfileSignals.skills draws from.
import { SKILLS as RESUME_SKILLS } from "../resume/lexicon/skills";
import { EXPERIENCE_KINDS } from "../taxonomy";
import { classYearFromGraduation, toMatchSignals } from "./signals";
import { SKILLS, detectSkills, normalizeSkillRefs, skillLabel, skillPhrase } from "./skills";
import { MatchSignalsSchema } from "./types";

describe("detectSkills", () => {
  it("matches whole words and phrases, case-insensitively", () => {
    expect(detectSkills("Built dashboards with Tableau and Python (pandas).")).toEqual(["python", "data_analysis"]);
    expect(detectSkills("Used scikit-learn for a computer vision project")).toEqual(["machine_learning"]);
  });

  it("does not see Java inside JavaScript", () => {
    expect(detectSkills("Frontend work in JavaScript")).toEqual(["javascript", "web_development"]);
  });

  it("needs programming context for one-letter languages", () => {
    expect(detectSkills("Got a C in chemistry and took vitamin C")).not.toContain("c_cpp");
    expect(detectSkills("Languages: Python, C, SQL")).toContain("c_cpp");
    expect(detectSkills("Plan R for the weekend")).not.toContain("r_lang");
    expect(detectSkills("Statistics in R and Python")).toContain("r_lang");
    expect(detectSkills("C++ for embedded robots")).toContain("c_cpp");
  });

  it("treats Excel the software apart from excel the verb", () => {
    expect(detectSkills("I excel at teamwork")).not.toContain("excel");
    expect(detectSkills("Budget tracking in Excel")).toContain("excel");
  });

  it("does not turn a promised mentor into a tutoring skill", () => {
    expect(detectSkills("Every intern is paired with a mentor")).toEqual([]);
  });

  it("has unique ids and labels short enough for chips", () => {
    const ids = SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SKILLS) expect(s.label.length).toBeLessThanOrEqual(24);
  });
});

describe("normalizeSkillRefs", () => {
  it("folds strings, objects and ESCO-style labels into vocabulary ids", () => {
    expect(
      normalizeSkillRefs([
        "python",
        { id: "http://data.europa.eu/esco/skill/abc", label: "Python (computer programming)" },
        { canonical: "SQL" },
        { name: "MATLAB" },
      ]),
    ).toEqual(["python", "sql", "matlab"]);
  });

  it("keeps short unlisted skills as plain labels and drops rejected or odd ones", () => {
    expect(normalizeSkillRefs(["Blender", { label: "Kotlin", confirmed: false }, "x".repeat(80), "me@school.edu"])).toEqual(["x:blender"]);
    // Nothing shaped like a phone or ID number, a link or a handle survives as a label.
    expect(normalizeSkillRefs(["5551234567", "x:5551234567", "janedoe.com", "x:portfolio.io"])).toEqual([]);
    expect(skillLabel("x:blender")).toBe("blender");
    expect(skillLabel("python")).toBe("Python");
  });

  it("reads a whole skills-list entry by its name: one-letter languages, frameworks, labels", () => {
    // In a skills list "R" and "C" are languages (in prose they need context, see detectSkills).
    expect(normalizeSkillRefs(["R", "C", "C#"])).toEqual(["r_lang", "c_cpp", "x:c#"]);
    expect(normalizeSkillRefs(["React", "Django", "Matplotlib"])).toEqual(["javascript", "web_development", "python", "data_analysis"]);
    expect(normalizeSkillRefs(["Mobile apps", "a second language", "Electronics"])).toEqual(["mobile_development", "languages", "circuits"]);
    expect(normalizeSkillRefs([{ id: "qpcr", name: "qPCR" }])).toEqual(["lab_techniques"]);
  });

  it("generalizes every language but English to 'A second language', so no language name travels", () => {
    const refs = normalizeSkillRefs(["Spanish (fluent)", "Haitian Creole", "American Sign Language", "Tagalog - conversational", "English"]);
    expect(refs).toEqual(["languages", "x:english"]);
    expect(JSON.stringify(refs)).not.toMatch(/spanish|creole|sign|tagalog/i);
  });

  it("never applies whole-entry names to prose", () => {
    expect(detectSkills("We react to feedback quickly")).toEqual([]);
    expect(detectSkills("Policy research on Latin America")).toEqual(["policy_analysis"]);
    expect(detectSkills("A Chinese history seminar")).toEqual([]);
  });

  it("names skills mid-sentence in lower case unless they are proper names", () => {
    expect(skillPhrase("data_analysis")).toBe("data analysis");
    expect(skillPhrase("languages")).toBe("a second language");
    expect(skillPhrase("python")).toBe("Python");
    expect(skillPhrase("ux_design")).toBe("UX design");
    expect(skillPhrase("x:kotlin")).toBe("kotlin");
  });

  it("maps every name in shared/resume's skills list that has a vocabulary skill, and drops none", () => {
    const refs = RESUME_SKILLS.map((s) => normalizeSkillRefs([s.name]));
    expect(RESUME_SKILLS.filter((_, i) => refs[i]?.length === 0).map((s) => s.name)).toEqual([]);
    const mapped = refs.filter((r) => r.some((x) => !x.startsWith("x:"))).length;
    // Reported so coverage changes are visible in review; most of the rest are tools (Docker, AWS) and languages.
    console.info(`resume skills mapped to onboarding vocabulary: ${mapped} of ${RESUME_SKILLS.length}`);
    expect(mapped).toBeGreaterThanOrEqual(220);
  });
});

describe("toMatchSignals", () => {
  it("produces the closed, PII-free shape and ignores unknown fields", () => {
    const signals = toMatchSignals({
      skills: ["Python", "Excel"],
      fields: ["Computing", "undeclared", "astrology"],
      coursework: ["Data Structures", "Intro to Statistics", "<script>"],
      experienceTypes: ["Job", "volunteer", "secret agent"],
      years: { graduation: 2029 },
      // Anything else a resume parser might add is ignored.
      ...({ contact: { email: "a@b.c" } } as object),
    });
    expect(signals).toEqual({
      skills: ["python", "excel"],
      fields: ["computing"],
      coursework: ["Data Structures", "Intro to Statistics"],
      experience: ["community_service", "paid_work"],
      graduationYear: 2029,
    });
    expect(MatchSignalsSchema.parse(signals)).toEqual(signals);
    expect(MatchSignalsSchema.safeParse({ ...signals, email: "a@b.c" }).success).toBe(false);
  });

  it("returns empty signals for nothing", () => {
    expect(toMatchSignals(null)).toEqual({ skills: [], fields: [], coursework: [], experience: [], graduationYear: null });
  });

  it("reads the server's stored signal names too, so no field is silently dropped", () => {
    expect(
      toMatchSignals({
        skills: ["Python"],
        fields: ["computing"],
        courseworkKeywords: ["Data Structures"],
        experienceKinds: ["part-time", "club", "volunteer"],
        gradYear: 2030,
      }),
    ).toEqual({ skills: ["python"], fields: ["computing"], coursework: ["Data Structures"], experience: ["paid_work", "community_service", "leadership"].sort((a, b) => order(a) - order(b)), graduationYear: 2030 });
  });

  it("ignores malformed lists instead of throwing", () => {
    expect(toMatchSignals({ skills: "Python" as never, fields: 3 as never, coursework: null as never })).toEqual({ skills: [], fields: [], coursework: [], experience: [], graduationYear: null });
  });
});

const order = (kind: string): number => EXPERIENCE_KINDS.indexOf(kind as (typeof EXPERIENCE_KINDS)[number]);

describe("classYearFromGraduation", () => {
  it("counts years left in the academic year that contains today", () => {
    expect(classYearFromGraduation(2030, "2026-11-11")).toBe("first_year");
    expect(classYearFromGraduation(2029, "2026-11-11")).toBe("second_year");
    expect(classYearFromGraduation(2027, "2026-11-11")).toBe("fourth_year");
    expect(classYearFromGraduation(2026, "2026-11-11")).toBe("recent_graduate");
    expect(classYearFromGraduation(2031, "2026-11-11")).toBe("incoming_first_year");
    expect(classYearFromGraduation(2040, "2026-11-11")).toBeNull();
  });
});
