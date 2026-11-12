import { describe, expect, it } from "vitest";
import { detectContact, detectSensitive, isCleanTerm, scanOutgoingText, SENSITIVE_CATEGORIES, type SensitiveCategory } from "./guard";

// All strings below are SAMPLE text written for tests (example.com addresses, 555-01xx phones).

const categoriesOf = (text: string): SensitiveCategory[] => [...new Set(detectSensitive(text).map((h) => h.category))];

describe("detectSensitive", () => {
  const positives: Record<SensitiveCategory, string[]> = {
    citizenship_immigration: ["DACA recipient", "Permanent resident since 2019", "Requires sponsorship", "F-1 visa holder", "International Student Association"],
    income: ["Pell Grant recipient", "QuestBridge Scholar", "Federal Work-Study, library", "TRIO Student Support Services"],
    disability: ["Disability Resource Center peer mentor", "ADHD advocacy club", "Wheelchair basketball", "IEP"],
    race_ethnicity: ["Treasurer, Black Student Union", "NSBE member", "SHPE chapter lead", "Hispanic Scholarship Fund scholar", "Native American Student Alliance"],
    gender: ["Society of Women Engineers", "Girls Who Code facilitator", "Women in Computing mentor", "Pronouns: she/her", "SWE, Society outreach chair"],
    sexual_orientation: ["LGBTQ+ Alliance", "oSTEM chapter", "Queer Student Union"],
    religion: ["Hillel board member", "Muslim Students Association", "Youth ministry volunteer", "Temple youth group leader"],
    first_generation: ["First-generation college student", "FGLI network", "McNair Scholar"],
    veteran: ["U.S. Army veteran", "GI Bill recipient", "ROTC cadet", "Deployed overseas with my unit, military police"],
    foster_care: ["Former foster youth", "Guardian Scholars program"],
    health: ["Cancer survivor", "Diagnosed with epilepsy", "Took medical leave in 2025", "HIV awareness"],
  };

  for (const category of SENSITIVE_CATEGORIES) {
    it(`finds ${category} statements`, () => {
      for (const text of positives[category]) expect(categoriesOf(text), text).toContain(category);
    });
  }

  it("does not trigger on benign confounders", () => {
    const confounders = [
      "Cashier, Old Navy",
      "Built a React Native app",
      "Temple University, B.S. Biology",
      "Salvation Army volunteer driver",
      "Ran a double-blind study",
      "SWE intern on the payments team",
      "Navy-blue theme for the club site",
      "May 2025 - Present",
      "Grant Writing Club",
      "Deployed the API to AWS with Docker",
      "Diagnosed and fixed network outages",
      "Black-Scholes pricing model in Python",
      "BlackRock Insight Day",
      "F1 score of 0.91 on the test set",
      "Essay on the Great Depression",
      "Opt in to the newsletter",
    ];
    for (const text of confounders) expect(detectSensitive(text), text).toEqual([]);
  });

  it("returns sorted spans that cover the match", () => {
    const text = "Mentor, Girls Who Code; Hillel";
    const hits = detectSensitive(text);
    expect(hits.map((h) => text.slice(h.start, h.end))).toEqual(["Girls Who Code", "Hillel"]);
  });

  it("needs context for contextual acronyms", () => {
    expect(detectSensitive("OPT")).toEqual([]);
    expect(categoriesOf("Eligible for OPT as an F-1 student")).toEqual(["citizenship_immigration"]);
    expect(detectSensitive("GSA internship, procurement data")).toEqual([]);
  });

  it("ignores the neutral placeholder the client inserts", () => {
    expect(detectSensitive("Treasurer, [removed]")).toEqual([]);
  });
});

describe("detectContact", () => {
  const kindsOf = (text: string) => [...new Set(detectContact(text).map((h) => h.kind))];

  it("finds emails, including obfuscated ones", () => {
    expect(kindsOf("jane.doe@example.com")).toContain("email");
    expect(kindsOf("jane [at] school [dot] edu")).toContain("email");
    expect(kindsOf("jane at gmail dot com")).toContain("email");
  });

  it("finds phones but not years, ranges or GPAs", () => {
    expect(kindsOf("(555) 010-0142")).toContain("phone");
    expect(kindsOf("555.010.0199")).toContain("phone");
    expect(kindsOf("+44 20 7946 0000")).toContain("phone");
    expect(kindsOf("2023-2024")).not.toContain("phone");
    expect(kindsOf("Aug 2023 - May 2024, GPA 3.85/4.0")).toEqual([]);
  });

  it("finds links and handles, but not skill names that look like domains", () => {
    expect(kindsOf("linkedin.com/in/sample-person")).toContain("link");
    expect(kindsOf("https://example.com/portfolio")).toContain("link");
    expect(kindsOf("github: @samplecoder")).toContain("link");
    expect(kindsOf("ASP.NET, Node.js, Socket.IO, Vue.js")).toEqual([]);
  });

  it("finds addresses and identifiers", () => {
    expect(kindsOf("123 Maple Street")).toContain("address");
    expect(kindsOf("Apt 4B")).toContain("address");
    expect(kindsOf("Springfield, IL 62704")).toContain("address");
    expect(kindsOf("SSN 123-45-6789")).toContain("id");
    expect(kindsOf("Student ID: A1234567")).toContain("id");
    expect(kindsOf("Date of birth")).toContain("id");
    expect(kindsOf("Unit testing with Jest")).toEqual([]);
    expect(kindsOf("000-12-3456")).not.toContain("id");
  });

  it("finds third-party names after honorifics and role labels", () => {
    expect(kindsOf("Research with Dr. Sample")).toContain("name");
    expect(kindsOf("Supervisor: Alex Sample")).toContain("name");
    expect(kindsOf("Research with Professor [name]")).toEqual([]);
  });
});

describe("scanOutgoingText", () => {
  it("passes clean redacted text", () => {
    const text = [
      "Skills: Python, SQL, data analysis, React Native",
      "Research assistant, sample lab: cleaned survey data with pandas",
      "Contact: [email] [phone] [link]",
      "Treasurer, [removed]",
    ].join("\n");
    expect(scanOutgoingText(text)).toEqual({ ok: true, kinds: [] });
  });

  it("reports coarse kinds and never a sensitive category", () => {
    const scan = scanOutgoingText("jane@example.com, Hillel, 555-010-0101");
    expect(scan.ok).toBe(false);
    expect(scan.kinds).toEqual(["email", "phone", "sensitive"]);
    expect(JSON.stringify(scan)).not.toMatch(/religion/);
  });

  it("isCleanTerm checks single terms", () => {
    expect(isCleanTerm("Python")).toBe(true);
    expect(isCleanTerm("NSBE")).toBe(false);
  });
});
