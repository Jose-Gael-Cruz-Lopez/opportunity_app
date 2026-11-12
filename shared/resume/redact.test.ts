import { describe, expect, it } from "vitest";
import { HOLDOUT_RESUMES } from "./__fixtures__/holdout.sample";
import { SAMPLE_RESUMES, type SampleResume } from "./__fixtures__/resumes.sample";
import { parseResumeText } from "./parse";
import { AI_TEXT_MAX_CHARS, REMOVED_PLACEHOLDER, redactForAi, scanAiText } from "./redact";
import { detectSensitive, SENSITIVE_REASON } from "./sensitive";
import { foldForMatch } from "./text";
import { SENSITIVE_CATEGORIES, type ParsedResume } from "./types";

const NOW = "2026-11-11";
const ALL: readonly SampleResume[] = [...SAMPLE_RESUMES, ...HOLDOUT_RESUMES];

/** Detector-independent checks, so the test does not grade the redactor with its own rules. */
const EMAIL_LIKE = /[\w.+-]+@[\w-]+\.[\w.-]+|\[\s*at\s*\]|\(\s*at\s*\)/i;
const PHONE_LIKE = /(?:\+?\d[\s().-]*){10,}/;
const STREET_LIKE = /\b\d{1,6}\s+(?:[A-Z][\w'.-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Terrace|Ter|Boulevard|Blvd|Way|Court|Ct)\b/;
const ZIP_LIKE = /\b[A-Z]{2}\s+\d{5}\b/;

function contains(haystack: string, needle: string): boolean {
  return foldForMatch(haystack).includes(foldForMatch(needle));
}

function sourceText(f: SampleResume): string {
  return f.input.text || parseResumeText({ ...f.input, now: f.now }).sections.flatMap((s) => s.lines).join("\n");
}

describe("redactForAi guarantees on every SAMPLE resume", () => {
  for (const f of ALL) {
    const parsed = parseResumeText({ ...f.input, now: f.now, hints: f.hints });
    const modes: Array<[string, string]> = [
      ["allowlist", redactForAi(parsed).text],
      ["text", redactForAi(sourceText(f)).text],
    ];
    for (const [mode, text] of modes) {
      it(`${f.id} (${mode}): no contact detail, name or sensitive statement survives`, () => {
        for (const p of f.pii) expect(contains(text, p), `${p} leaked`).toBe(false);
        for (const s of f.sensitive) expect(contains(text, s), `${s} leaked`).toBe(false);
        expect(text).not.toMatch(EMAIL_LIKE);
        expect(text).not.toMatch(PHONE_LIKE);
        expect(text).not.toMatch(STREET_LIKE);
        expect(text).not.toMatch(ZIP_LIKE);
        expect(detectSensitive(text)).toEqual([]);
        expect(scanAiText(text)).toEqual({ ok: true, issues: [] });
        expect(text.length).toBeLessThanOrEqual(AI_TEXT_MAX_CHARS);
      });
    }
    it(`${f.id} (allowlist): schools, organizations and awards stay on the device; benign text survives`, () => {
      const text = modes[0]![1];
      for (const w of f.withheld) expect(contains(text, w), `${w} was sent`).toBe(false);
      for (const s of f.survives) expect(text, `${s} was lost`).toContain(s);
    });
  }
});

describe("redactForAi behaviour", () => {
  const sensitiveSample = SAMPLE_RESUMES.find((f) => f.id === "sensitive-statements")!;
  const parsed = parseResumeText({ text: sensitiveSample.input.text, now: NOW });
  const result = redactForAi(parsed);

  it("removes a sensitive entry as a unit, so its role and bullets go with the organization", () => {
    expect(result.text).not.toContain("Treasurer");
    expect(result.text).not.toContain("$3,000");
    expect(result.text).toContain(REMOVED_PLACEHOLDER);
  });

  it("never names a category in the text or in what it reports as removed", () => {
    const sensitiveItems = result.removed.filter((r) => r.kind === "sensitive");
    expect(sensitiveItems.length).toBeGreaterThan(0);
    for (const item of sensitiveItems) {
      expect(item.reason).toBe(SENSITIVE_REASON);
      expect(item.placeholder).toBe(REMOVED_PLACEHOLDER);
      expect(Object.keys(item).sort()).toEqual(["kind", "original", "placeholder", "reason"]);
    }
    const labels = [...SENSITIVE_CATEGORIES, "citizenship", "immigration", "ethnicity", "sexual orientation", "veteran", "foster", "disability"];
    for (const label of labels) {
      expect(result.text.toLowerCase()).not.toContain(label.replace(/_/g, " "));
      for (const item of result.removed) expect(`${item.kind} ${item.reason} ${item.placeholder}`.toLowerCase()).not.toContain(label.replace(/_/g, " "));
    }
  });

  it("folds adjacent removals into one marker", () => {
    expect(result.text).not.toMatch(/\[removed\]\s*\n\s*\[removed\]/);
    const text = redactForAi("Volunteer at my mosque\nMember of the Black Student Union\n- Organized Ramadan iftar\nBuilt a Python app").text;
    expect(text.split("\n")).toEqual([REMOVED_PLACEHOLDER, "Built a Python app"]);
  });

  it("lists what stays on the device so the preview can show it", () => {
    const kinds = new Set(result.removed.map((r) => r.kind));
    for (const k of ["name", "email", "phone", "address", "withheld", "sensitive"]) expect(kinds.has(k as never)).toBe(true);
    expect(result.removed.find((r) => r.kind === "withheld" && r.original === "Georgia Institute of Technology")).toBeTruthy();
  });

  it("is stable: redacting its own output finds nothing new", () => {
    const again = redactForAi(result.text);
    expect(again.removed.filter((r) => r.kind !== "withheld")).toEqual([]);
    expect(again.text.replace(/\n+/g, "\n")).toBe(result.text.replace(/\n+/g, "\n"));
  });

  it("redacts the account name and other seeds the caller passes", () => {
    const text = redactForAi("PROJECTS\n- Built a tutoring app with Sam Okoro and Jamie Lin", { names: ["Jamie Lin"] }).text;
    expect(text).toContain("[name]");
    expect(text).not.toContain("Jamie");
  });

  it("cuts at a line boundary under the size cap and says what was cut", () => {
    const bullets = Array.from({ length: 400 }, (_, i) => `- Built feature ${i} of a Python web app for a class project`).join("\n");
    const big = parseResumeText({ text: `Pat Lee\npat@example.com\n\nPROJECTS\nCampus App\n${bullets}`, now: NOW });
    const r = redactForAi(big, { maxChars: 2000 });
    expect(r.text.length).toBeLessThanOrEqual(2000);
    expect(r.text.endsWith("class project")).toBe(true);
    expect(r.removed.some((x) => x.kind === "limit")).toBe(true);
  });

  it("drops a references section in text mode", () => {
    const r = redactForAi("SKILLS\nPython\nREFERENCES\nDr. Lena Park, (555) 010-0101, lena.park@example.edu\nMark Ito, Manager");
    expect(r.text).toBe("SKILLS\nPython");
    expect(r.removed.some((x) => x.kind === "withheld" && x.original.includes("Lena Park"))).toBe(true);
  });

  it("returns empty output for empty or malformed input", () => {
    expect(redactForAi("")).toEqual({ text: "", removed: [] });
    expect(redactForAi({} as unknown as ParsedResume)).toEqual({ text: "", removed: [] });
  });
});

describe("sensitive statements: CI gate over at least fifty resume lines", () => {
  // Three or more per category, written the way students write them, including caps.
  const LINES: Array<[string, string]> = [
    ["citizenship_immigration", "DACA recipient and Dreamers club member"],
    ["citizenship_immigration", "U.S. permanent resident (green card holder)"],
    ["citizenship_immigration", "International student on an F-1 visa, eligible for CPT"],
    ["citizenship_immigration", "Will require H-1B sponsorship after graduation"],
    ["citizenship_immigration", "Refugee resettled in Ohio in 2016"],
    ["income", "Pell Grant recipient all four semesters"],
    ["income", "QuestBridge National College Match finalist"],
    ["income", "Federal Work-Study position at the library"],
    ["income", "Qualified for free and reduced lunch in high school"],
    ["income", "PELL GRANT RECIPIENT"],
    ["disability", "Registered with the Disability Resource Center"],
    ["disability", "Diagnosed with dyslexia in middle school"],
    ["disability", "Deaf student and ASL tutor"],
    ["disability", "Wheelchair user advocating for campus ramps"],
    ["race_ethnicity", "Treasurer, BLACK STUDENT UNION"],
    ["race_ethnicity", "Member of the Society of Hispanic Professional Engineers (SHPE)"],
    ["race_ethnicity", "Hispanic Scholarship Fund scholar"],
    ["race_ethnicity", "Vice President, Vietnamese Student Association"],
    ["race_ethnicity", "NSBE regional conference delegate"],
    ["gender", "Society of Women Engineers outreach chair"],
    ["gender", "Girls Who Code club founder"],
    ["gender", "Pronouns: she/her"],
    ["gender", "Sorority recruitment chair, Alpha Phi"],
    ["sexual_orientation", "President of the LGBTQ+ alliance"],
    ["sexual_orientation", "oSTEM chapter treasurer"],
    ["sexual_orientation", "Organized the campus Pride Month festival"],
    ["sexual_orientation", "Point Foundation scholar"],
    ["religion", "Youth group leader at First Baptist Church"],
    ["religion", "Hillel board member"],
    ["religion", "Muslim Students Association secretary"],
    ["religion", "Mission trip to Guatemala with my parish"],
    ["religion", "InterVarsity small group leader"],
    ["first_generation", "First-generation college student"],
    ["first_generation", "First in my family to attend college"],
    ["first_generation", "McNair Scholars Program participant"],
    ["first_generation", "FGLI peer mentor"],
    ["veteran", "U.S. Army veteran, two deployments"],
    ["veteran", "Using the GI Bill for tuition"],
    ["veteran", "Student Veterans of America chapter president"],
    ["veteran", "Served in the navy for four years"],
    ["veteran", "ARMY ROTC CADET"],
    ["foster_care", "Former foster youth, Guardian Scholars program"],
    ["foster_care", "Aged out of foster care at 18"],
    ["foster_care", "Ward of the state until 2022"],
    ["health", "Cancer survivor and Relay for Life captain"],
    ["health", "Took a medical leave in spring 2025"],
    ["health", "Living with type 1 diabetes"],
    ["health", "Recovered from an eating disorder"],
    ["tribal_affiliation", "Enrolled member of the Cherokee Nation"],
    ["tribal_affiliation", "Tribal council youth representative"],
    ["tribal_affiliation", "Native students club, AISES member"],
    ["parenting", "Student parent of two"],
    ["parenting", "Single mother working nights"],
    ["parenting", "Primary caregiver for my son"],
    ["crime_victim", "Survivor of domestic violence"],
    ["crime_victim", "Advocate and sexual assault survivor"],
    ["crime_victim", "Victim of a violent crime in 2023"],
  ];

  it("has three or more lines for each category and at least fifty in all", () => {
    expect(LINES.length).toBeGreaterThanOrEqual(50);
    for (const c of SENSITIVE_CATEGORIES) expect(LINES.filter(([cat]) => cat === c).length, c).toBeGreaterThanOrEqual(3);
  });

  it("detects every line (recall 1.0 on this set)", () => {
    const missed = LINES.filter(([, line]) => detectSensitive(line).length === 0).map(([, l]) => l);
    expect(missed).toEqual([]);
  });

  it("sends none of them, in text mode or as resume bullets", () => {
    const asText = redactForAi(LINES.map(([, l]) => l).join("\n"));
    expect(asText.text).toBe(REMOVED_PLACEHOLDER);
    const resume = `Pat Lee\npat@example.com\n\nACTIVITIES\nMember, Campus Groups  2025 - Present\n${LINES.map(([, l]) => `- ${l}`).join("\n")}\n\nSKILLS\nPython`;
    const out = redactForAi(parseResumeText({ text: resume, now: NOW })).text;
    for (const [, line] of LINES) expect(out).not.toContain(line);
    expect(detectSensitive(out)).toEqual([]);
    expect(out).toContain("Python");
  });
});

describe("scanAiText (the server-side recheck)", () => {
  it("passes clean text and placeholders", () => {
    expect(scanAiText("SKILLS\nPython, SQL\n[email] [phone] [link] [address] [id] [name]\n[removed]")).toEqual({ ok: true, issues: [] });
  });

  it("reports coarse kinds only, never the text or a category", () => {
    const scan = scanAiText("Contact jane.doe@example.com or (555) 010-0100. First-generation student.");
    expect(scan.ok).toBe(false);
    expect(scan.issues).toEqual(["email", "phone", "sensitive"]);
    expect(JSON.stringify(scan)).not.toMatch(/jane|first|generation/i);
  });

  it("rejects text over the size cap and non-strings", () => {
    expect(scanAiText("a".repeat(AI_TEXT_MAX_CHARS + 1)).issues).toEqual(["too_long"]);
    expect(scanAiText(undefined as unknown as string).ok).toBe(false);
  });
});
