import { describe, expect, it } from "vitest";
import { CONTACT_LEAKS, SENSITIVE_LEAKS } from "@shared/resume/__fixtures__/leaks.sample";
import { createAi, createMockProvider, deterministicResumeProfile, MemoryLedger, resumeTextIsClean, type MockStep } from "./index";
import { RESUME_EXTRACT_LIMITS } from "./prompts/resume-extract";
import { geminiResponseSchema } from "./schema";
import { ResumeExtractModelOutputSchema } from "./prompts/resume-extract";
import type { AiLogFields } from "./types";

// SAMPLE text only: invented, already redacted the way the browser's redactForAi leaves it.
const TEXT = [
  "EDUCATION",
  "B.S. Computer Science, expected 2030",
  "Relevant coursework: Statistics, Data Structures",
  "EXPERIENCE",
  "Research Assistant",
  "• Cleaned survey data with Python and SQL",
  "• Built charts in Tableau",
  "Tutor",
  "• Tutored first-year students in calculus",
  "SKILLS",
  "Python, SQL, Tableau, Git",
  "Contact: [email]",
].join("\n");

const NOW = Date.parse("2026-11-11T16:00:00Z");
const ADULT = { userId: "sample-user", birthYearMonth: "2000-01" };

function setup(steps: MockStep[]) {
  const provider = createMockProvider(steps);
  const logs: { event: string; fields: AiLogFields }[] = [];
  const ai = createAi(
    { GEMINI_API_KEY: "placeholder" },
    { provider, ledger: new MemoryLedger(), clock: { now: () => NOW }, nonce: () => "n0nce0000000000000000000", log: (event, fields) => logs.push({ event, fields }) },
  );
  return { ai, provider, logs };
}

describe("resume.extract", () => {
  it("returns grounded, closed-vocabulary signals from the model", async () => {
    const { ai, provider } = setup([
      {
        json: {
          skills: ["Python", "SQL", "Tableau", "Git", "python"],
          fields: ["computing"],
          courseworkKeywords: ["Statistics", "Data Structures"],
          experienceKinds: ["teaching_or_tutoring", "research"],
        },
      },
    ]);
    const res = await ai.extractResumeProfile(TEXT, { viewer: ADULT });
    expect(res.source).toBe("model");
    expect(res.meta).toMatchObject({ status: "ok", fallback: false, provider: "gemini", promptVersion: "resume.extract.v1" });
    expect(res.profile).toEqual({
      skills: ["Python", "SQL", "Tableau", "Git"],
      fields: ["computing"],
      courseworkKeywords: ["Statistics", "Data Structures"],
      experienceKinds: ["research", "teaching_or_tutoring"],
    });
    // Exactly the approved text went into the prompt, fenced as data.
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.input).toContain("Cleaned survey data with Python and SQL");
    expect(provider.calls[0]!.input).toContain("<<<BEGIN RESUME");
  });

  it("drops terms the text does not contain, and retries once when most are invented", async () => {
    const { ai, provider } = setup([
      { json: { skills: ["Kubernetes", "Rust", "Go", "Python"], fields: [], courseworkKeywords: [], experienceKinds: [] } },
      { json: { skills: ["Python", "Kubernetes"], fields: [], courseworkKeywords: [], experienceKinds: [] } },
    ]);
    const res = await ai.extractResumeProfile(TEXT, { viewer: ADULT });
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]!.input).toContain("REJECTED");
    expect(res.source).toBe("model");
    expect(res.profile.skills).toEqual(["Python"]);
  });

  it("never sends text that fails scanAiText or the status lexicon, and never echoes it", async () => {
    for (const leak of [...CONTACT_LEAKS, ...SENSITIVE_LEAKS]) {
      expect(resumeTextIsClean(leak), leak).toBe(false);
      const { ai, provider, logs } = setup([]);
      const res = await ai.extractResumeProfile(`${TEXT}\n${leak}`, { viewer: ADULT });
      expect(res.source).toBe("refused");
      expect(res.profile).toEqual({ skills: [], fields: [], courseworkKeywords: [], experienceKinds: [] });
      expect(provider.calls).toHaveLength(0);
      expect(JSON.stringify(logs)).not.toContain(leak);
    }
  });

  it("falls back to the deterministic parser with no key, under the age gate, and on errors", async () => {
    const noKey = createAi({}, { clock: { now: () => NOW }, log: () => {} });
    const off = await noKey.extractResumeProfile(TEXT, { viewer: ADULT });
    expect(off.source).toBe("deterministic");
    expect(off.meta).toMatchObject({ status: "unavailable", degradedReason: "no_api_key", fallback: true, provider: "none" });
    expect(off.profile.skills).toEqual(expect.arrayContaining(["Python", "SQL"]));
    expect(off.profile.fields).toContain("computing");

    const minor = setup([]);
    const gated = await minor.ai.extractResumeProfile(TEXT, { viewer: { userId: "sample-user", birthYearMonth: "2010-01" } });
    expect(gated.source).toBe("deterministic");
    expect(gated.meta.degradedReason).toBe("disabled");
    expect(minor.provider.calls).toHaveLength(0);

    const unknownAge = setup([]);
    expect((await unknownAge.ai.extractResumeProfile(TEXT)).meta.degradedReason).toBe("disabled");
    expect(unknownAge.provider.calls).toHaveLength(0);

    const broken = setup([{ error: "safety_blocked" }]);
    const res = await broken.ai.extractResumeProfile(TEXT, { viewer: ADULT });
    expect(res.source).toBe("deterministic");
    expect(res.meta.degradedReason).toBe("safety_blocked");
  });

  it("caps per-student requests per day", async () => {
    const steps: MockStep[] = Array.from({ length: 6 }, () => ({ json: { skills: ["Python"], fields: [], courseworkKeywords: [], experienceKinds: [] } }));
    const { ai, provider } = setup(steps);
    const sources: string[] = [];
    for (let i = 0; i < 6; i++) sources.push((await ai.extractResumeProfile(TEXT, { viewer: ADULT })).source);
    expect(sources.slice(0, 5)).toEqual(["model", "model", "model", "model", "model"]);
    expect(sources[5]).toBe("deterministic");
    expect(provider.calls).toHaveLength(5);
  });

  it("asks for enums the model must use, and the deterministic reader keeps to the limits", () => {
    const schema = JSON.stringify(geminiResponseSchema(ResumeExtractModelOutputSchema));
    expect(schema).toContain("teaching_or_tutoring");
    expect(schema).toContain("computing");
    const profile = deterministicResumeProfile(TEXT);
    expect(profile.skills.length).toBeLessThanOrEqual(RESUME_EXTRACT_LIMITS.skills);
    expect(deterministicResumeProfile("Email sample.person@example.com")).toEqual({ skills: [], fields: [], courseworkKeywords: [], experienceKinds: [] });
  });
});
