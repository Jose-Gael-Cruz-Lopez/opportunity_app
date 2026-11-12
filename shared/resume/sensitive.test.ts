import { describe, expect, it } from "vitest";
import { contextWindow, detectSensitive, hasSensitive, titleCaseCaps } from "./sensitive";
import { SENSITIVE_RULES } from "./lexicon/sensitive-rules";
import { SENSITIVE_CATEGORIES } from "./types";

/**
 * Benign look-alikes from student resumes. The policy removes every hit, so each false positive
 * costs the student a line of AI help; the gate keeps the rate at or under 5%.
 */
const CONFOUNDERS: string[] = [
  "Cashier, Old Navy",
  "Built a React Native app for campus events",
  "Temple University, B.S. Biology",
  "Volunteer, Salvation Army holiday kettle drive",
  "Ran a double-blind study of two onboarding flows",
  "SWE Intern, Stripe",
  "Software SWE intern on the payments team",
  "Designed a navy-blue theme for the club website",
  "Interned May 2025 - Aug 2025",
  "Grant Writing Club member",
  "Wrote black-box tests for the API",
  "Deployed the model to AWS and Google Cloud",
  "Pride and Prejudice reading group",
  "Took pride in a spotless kitchen",
  "Apache Kafka and Apache Spark pipelines",
  "Visa Inc. summer analyst",
  "Diagnosed network issues for 40 users",
  "Disabled unused features to speed up the build",
  "F1 score of 0.92 on the test set",
  "Formula 1 fan club treasurer",
  "Indigenous plant species survey",
  "Marine Biology research assistant",
  "Native speaker of English",
  "Army of volunteers for the fundraiser",
  "Minority stake analysis for a case competition",
  "Black-Scholes option pricing model",
  "Earned a black belt in taekwondo",
  "Blackboard course site administrator",
  "Sponsorship chair, Hackathon Club",
  "Corporate sponsorship outreach for TEDx",
  "Hotel accommodations for 30 conference guests",
  "Ministry of Education data internship",
  "Gay-Lussac's law lab report",
  "Asexual reproduction in yeast lab",
  "Church Street Marketplace volunteer",
  "Foster a culture of feedback in the team",
  "Dog foster volunteer with the animal shelter",
  "Homeless shelter meal service volunteer",
  "North Dakota State University",
  "Seneca College exchange",
  "Mission statement rewrite for the robotics team",
  "Played piano in a jazz trio",
  "Opt-in survey of 200 students",
  "Great Depression history paper",
  "Senior Thesis on public transit",
  "Women's History Month exhibit research",
];

const DEFINITE: Array<[string, string]> = [
  ["citizenship_immigration", "Permanent resident"],
  ["income", "Federal Work-Study"],
  ["disability", "Disability Resource Center"],
  ["race_ethnicity", "National Society of Black Engineers"],
  ["gender", "Society of Women Engineers"],
  ["sexual_orientation", "LGBTQ+ Alliance"],
  ["religion", "Hillel"],
  ["first_generation", "first-generation"],
  ["veteran", "GI Bill"],
  ["foster_care", "foster youth"],
  ["health", "cancer survivor"],
];

describe("detectSensitive", () => {
  it("covers every SensitiveAnswers category with at least one rule", () => {
    for (const c of SENSITIVE_CATEGORIES) expect(SENSITIVE_RULES.some((r) => r.category === c), c).toBe(true);
  });

  it.each(DEFINITE)("%s: finds %s", (category, phrase) => {
    const hits = detectSensitive(`Member, ${phrase}, 2025`);
    expect(hits.map((h) => h.category)).toContain(category);
  });

  it("keeps the false-positive rate on benign look-alikes at or under 5%", () => {
    const flagged = CONFOUNDERS.filter((c) => hasSensitive(c));
    expect(flagged.length / CONFOUNDERS.length, `flagged: ${flagged.join(" | ")}`).toBeLessThanOrEqual(0.05);
  });

  it("reads organization names set in capitals", () => {
    expect(detectSensitive("TREASURER, BLACK STUDENT UNION").map((h) => h.category)).toContain("race_ethnicity");
    expect(detectSensitive("U.S. ARMY RESERVE").map((h) => h.category)).toContain("veteran");
    // Matches report the original characters, not the Title Case copy used to find them.
    expect(detectSensitive("TREASURER, BLACK STUDENT UNION").map((h) => h.match)).toContain("BLACK STUDENT UNION");
    expect(titleCaseCaps("TREASURER, NSBE")).toBe("Treasurer, Nsbe");
    expect(titleCaseCaps("no caps here")).toBeNull();
  });

  it("marks a research topic contextual but still reports it", () => {
    const topic = detectSensitive("Research project on diabetes outcomes in rural clinics");
    expect(topic.map((h) => h.strength)).toEqual(["contextual"]);
    expect(detectSensitive("Living with diabetes since 2019").map((h) => h.strength)).toEqual(["definite"]);
  });

  it("needs context for ambiguous acronyms and names", () => {
    expect(hasSensitive("Tuned an OPT solver")).toBe(false);
    expect(hasSensitive("Eligible for OPT on an F-1 visa")).toBe(true);
    expect(hasSensitive("MSA treasurer")).toBe(false);
    expect(hasSensitive("MSA treasurer, organized Eid dinners for Muslim students")).toBe(true);
    expect(hasSensitive("Pride week planning committee")).toBe(true);
  });

  it("keeps context on one line and offsets on the whole text", () => {
    const text = "Python and SQL\nTreasurer, Hillel\nJava";
    const [hit] = detectSensitive(text);
    expect(text.slice(hit!.start, hit!.end)).toBe("Hillel");
    expect(detectSensitive("Black\nstudents")).toHaveLength(1);
    expect(contextWindow("a b c d e f g h i j k l m", 12, 13, 2)).toBe("e f g h i");
  });

  it("returns nothing for empty or non-string input", () => {
    expect(detectSensitive("")).toEqual([]);
    expect(detectSensitive(null as unknown as string)).toEqual([]);
  });
});
