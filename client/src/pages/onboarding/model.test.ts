import { describe, expect, it } from "vitest";
import { EMPTY_STUDENT_PROFILE, StudentProfileUpdateSchema, findSensitiveKeys, type StudentProfile } from "@shared/contracts";
import {
  EMPTY_DRAFT,
  STEPS,
  ageBand,
  birthYearOptions,
  buildProfileUpdate,
  categoriesFromTypes,
  checkTag,
  draftFromProfile,
  graduationTermOptions,
  isDraftEmpty,
  missingFor,
  nextStep,
  parseDraft,
  preferredTypes,
  previousStep,
  type Draft,
} from "./model";

const TODAY = "2026-11-11";

const full: Draft = {
  ...EMPTY_DRAFT,
  birthMonth: 3,
  birthYear: 2007,
  classYear: "second_year",
  graduationTerm: "spring-2029",
  institutionLevel: "four_year",
  transferIntent: "planning_to_transfer",
  majorFamily: "life_sciences",
  gpaBand: "3_5_to_3_74",
  categories: ["research", "scholarships"],
  interestTags: ["climate"],
  priorExperience: ["research"],
  weeklyPrepHours: 4,
};

describe("age gate", () => {
  it("bands by month and year, using the lower age in the birth month", () => {
    expect(ageBand(2010, 10, TODAY)).toBe("minor"); // 16 since October
    expect(ageBand(2010, 11, TODAY)).toBe("under_16"); // birthday month: may not have happened yet
    expect(ageBand(2010, 12, TODAY)).toBe("under_16");
    expect(ageBand(2008, 10, TODAY)).toBe("adult");
    expect(ageBand(2008, 11, TODAY)).toBe("minor");
  });

  it("offers a wide range of birth years with no hint of the cutoff", () => {
    const years = birthYearOptions(TODAY);
    expect(years[0]).toBe(2014);
    expect(years.at(-1)).toBe(1956);
  });
});

describe("flow", () => {
  it("steps forward and back within bounds", () => {
    expect(nextStep("age")).toBe("year");
    expect(nextStep("review")).toBe("review");
    expect(previousStep("age")).toBe("age");
    expect(STEPS).toEqual(["age", "year", "study", "interests", "review"]);
  });

  it("names what is missing per step and in review", () => {
    expect(missingFor("age", EMPTY_DRAFT)).toEqual(["birth month and year"]);
    expect(missingFor("year", EMPTY_DRAFT)).toEqual(["class year"]);
    expect(missingFor("review", EMPTY_DRAFT)).toHaveLength(4);
    expect(missingFor("review", full)).toEqual([]);
  });

  it("lists graduation terms from now forward", () => {
    const terms = graduationTermOptions(TODAY).map((t) => t.value);
    expect(terms[0]).toBe("fall-2026");
    expect(terms).toContain("spring-2029");
    expect(terms).not.toContain("spring-2026");
  });
});

describe("profile update", () => {
  it("passes the strict contract and carries no sensitive key", () => {
    const body = buildProfileUpdate(full);
    expect(StudentProfileUpdateSchema.safeParse(body).success).toBe(true);
    expect(findSensitiveKeys(body)).toEqual([]);
    expect(body.birthYearMonth).toBe("2007-03");
    expect(body.preferredOpportunityTypes).toContain("research_program");
    expect(body.preferredOpportunityTypes).toContain("national_scholarship");
    // Transfer intent only applies to two-year students.
    expect(body.transferIntent).toBeNull();
    expect(buildProfileUpdate({ ...full, institutionLevel: "two_year" }).transferIntent).toBe("planning_to_transfer");
  });

  it("maps categories to types and back", () => {
    expect(new Set(categoriesFromTypes(preferredTypes(["sprints", "internships"])))).toEqual(new Set(["sprints", "internships"]));
  });

  it("prefills a draft from a saved profile", () => {
    const profile: StudentProfile = {
      ...EMPTY_STUDENT_PROFILE,
      birthYearMonth: "2007-03",
      classYear: "first_year",
      majorFamily: "computing",
      preferredOpportunityTypes: ["sprinternship"],
      interestTags: ["software", "Bad Tag!"],
    };
    const d = draftFromProfile(profile);
    expect(d).toMatchObject({ birthYear: 2007, birthMonth: 3, classYear: "first_year", majorFamily: "computing", categories: ["sprints"] });
    expect(d.interestTags).toEqual(["software"]);
    expect(isDraftEmpty(EMPTY_DRAFT)).toBe(true);
    expect(isDraftEmpty(d)).toBe(false);
  });
});

describe("tags", () => {
  it("normalises topics and refuses status or identity details", () => {
    expect(checkTag("  Public   Health ")).toEqual({ ok: true, tag: "public health" });
    expect(checkTag("x")).toEqual({ ok: false, reason: "length" });
    expect(checkTag("<script>")).toEqual({ ok: false, reason: "characters" });
    expect(checkTag("first gen")).toEqual({ ok: false, reason: "sensitive" });
    expect(checkTag("veteran support")).toEqual({ ok: false, reason: "sensitive" });
    expect(checkTag("green card")).toEqual({ ok: false, reason: "sensitive" });
    expect(checkTag("software")).toEqual({ ok: true, tag: "software" });
  });
});

describe("stored draft", () => {
  it("round-trips a valid draft", () => {
    expect(parseDraft(JSON.stringify(full))).toEqual(full);
  });

  it("drops unknown keys and invalid values, including any sensitive key", () => {
    const raw = JSON.stringify({ ...full, classYear: "senior", birthMonth: 13, citizenship: "us_citizen", interestTags: ["first gen"] });
    const d = parseDraft(raw);
    expect(d.classYear).toBeNull();
    expect(d.birthMonth).toBeNull();
    expect(d.interestTags).toEqual([]);
    expect(Object.keys(d)).not.toContain("citizenship");
    expect(parseDraft("{")).toEqual(EMPTY_DRAFT);
    expect(parseDraft(null)).toEqual(EMPTY_DRAFT);
  });
});
