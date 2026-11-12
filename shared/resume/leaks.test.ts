import { describe, expect, it } from "vitest";
import { CONTACT_LEAKS, SENSITIVE_LEAKS } from "./__fixtures__/leaks.sample";
import { parseResumeText } from "./parse";
import { detectPii } from "./pii";
import { redactForAi, scanAiText } from "./redact";
import { detectSensitive } from "./sensitive";

// The same SAMPLE list the server route test refuses, checked on the device side.
describe("known leak samples", () => {
  it.each(SENSITIVE_LEAKS.map((t) => [t]))("detects a sensitive statement in %s", (text) => {
    expect(detectSensitive(text).length).toBeGreaterThan(0);
    expect(scanAiText(text).ok).toBe(false);
  });

  it.each(CONTACT_LEAKS.map((t) => [t]))("detects contact details in %s", (text) => {
    expect(detectPii(text).length + detectSensitive(text).length).toBeGreaterThan(0);
    expect(scanAiText(text).ok).toBe(false);
  });

  it("redacts every sample so the result passes the recheck", () => {
    for (const text of [...CONTACT_LEAKS, ...SENSITIVE_LEAKS]) {
      const out = redactForAi(text).text;
      expect(scanAiText(out).ok, `${text} -> ${out}`).toBe(true);
    }
  });

  it("leaves no part of a spaced email or a discord tag behind", () => {
    expect(redactForAi("- reach me at mlopez06 @gmail.com").text).not.toMatch(/mlopez06|gmail/);
    expect(redactForAi("- email jane . doe @ gmail . com").text).not.toMatch(/jane|doe|gmail/);
    expect(redactForAi("- Discord: maria#1234").text).not.toMatch(/maria|1234/);
  });

  it("keeps everyday resume lines that only look close", () => {
    const benign = [
      "Migrated services from Java to Kotlin",
      "Managed 5 people on the way to launch",
      "Ran test suite 2 times a day",
      "GitHub/GitLab CI pipelines",
      "GPA 3.8/4.0, 2023 - 2027",
      "Processed 1,234,567 rows in 10 seconds",
      "Served 2 years as club treasurer",
      "Studied airborne particles in the lab",
      "Asian Studies minor",
      "Built a soldier-ant simulation",
    ];
    for (const line of benign) expect(scanAiText(line), line).toEqual({ ok: true, issues: [] });
  });

  it("keeps the same samples out of the parsed-resume path", () => {
    const text = [
      "Ana Ruiz",
      "",
      "EDUCATION",
      "State University",
      "B.A. Biblical Studies, Minor in Sexuality Studies",
      "Expected May 2029",
      "",
      "EXPERIENCE",
      "Volunteer, Community Center",
      "Sep 2025 - Present",
      "- reach me at mlopez06 @gmail.com",
      "- text 555 - 867 - 5309 to join",
      "- Former Marine; mentored cohort",
      "- Worked with Daca students on a scholarship tracker",
    ].join("\n");
    const out = redactForAi(parseResumeText({ text })).text;
    expect(out).not.toMatch(/Biblical|Sexuality|mlopez06|gmail|867|Marine|Daca/i);
    expect(scanAiText(out).ok).toBe(true);
  });
});
