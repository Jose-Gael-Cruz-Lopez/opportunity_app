import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fmix32, fnv1a32, foldText, isoWeekKey, processTerm, rotationKey, shortDate, tokenize } from "./text";
import { encodeWhyShown, explainWhyShown, whyShownText, type WhyShown } from "./why-shown";

describe("text helpers", () => {
  it("folds case and diacritics, and drops stop words", () => {
    expect(foldText("Résumé")).toBe("resume");
    expect(processTerm("The")).toBeNull();
    expect(tokenize("Research Experiences for Undergraduates")).toEqual(["research", "experiences", "undergraduates"]);
  });

  it("computes FNV-1a 32-bit", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(rotationKey("x", "2026-W46")).toBe(fmix32(fnv1a32("2026-W46|x")));
    expect(fmix32(0)).toBe(0);
  });

  it("computes ISO week keys across year boundaries", () => {
    expect(isoWeekKey("2026-11-11")).toBe("2026-W46");
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
    expect(isoWeekKey("2027-01-04")).toBe("2027-W01");
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01");
    expect(() => isoWeekKey("2026-13-01")).toThrow();
  });

  it("formats short dates", () => {
    expect(shortDate("2026-12-23")).toBe("Dec 23");
    expect(shortDate("2027-01")).toBe("2027-01");
  });
});

describe("why-shown", () => {
  const all: WhyShown[] = [
    { code: "ELIGIBLE_STANDING", classYear: "second_year" },
    { code: "ELIGIBLE_IF", items: ["Eligible if your campus nominates you.", "Eligible if you are enrolled full time."] },
    { code: "NOT_FULLY_CHECKED", dimensions: ["standing", "gpa", "enrollment", "transfer", "institution", "residency", "host_enrollment"] },
    { code: "START_BY", date: "2026-12-23", deadline: "2027-01-15" },
    { code: "DEADLINE", date: "2026-12-01" },
    { code: "TIGHT_TIMELINE", prepDays: 23, deadline: "2026-11-13" },
    { code: "CAMPUS_DATE_UNCERTAIN", step: "e1", date: "2026-11-20", nationalDate: "2027-01-29" },
    { code: "CAMPUS_DATE_UNCERTAIN", step: "national", date: "2027-01-29", nationalDate: "2027-01-29" },
    { code: "CAMPUS_DATE", date: "2026-12-04" },
    { code: "MAJOR_MATCH", family: "life_sciences" },
    { code: "OPEN_TO_ALL_MAJORS" },
    { code: "PREDICTED_WINDOW", p10: "2026-12-01", p90: "2026-12-20" },
    { code: "OPENS_SOON", date: "2026-12-01" },
    { code: "ROLLING" },
    { code: "NAME_MATCH" },
    { code: "ALIAS_MATCH" },
    { code: "ORG_MATCH" },
    { code: "TOPIC_MATCH" },
  ];

  it("has plain copy for every code", () => {
    for (const w of all) expect(whyShownText(w).length).toBeGreaterThan(5);
    expect(whyShownText(all[3] as WhyShown)).toBe("Start by Dec 23 to be ready for the Jan 15 deadline.");
    expect(whyShownText(all[2] as WhyShown)).toContain("GPA");
  });

  it("encodes to at most 60 characters", () => {
    for (const w of all) expect(encodeWhyShown(w).length).toBeLessThanOrEqual(60);
    expect(encodeWhyShown(all[3] as WhyShown)).toBe("START_BY:2026-12-23,2027-01-15");
  });

  it("explains both items and bare lists", () => {
    expect(explainWhyShown({ whyShown: [{ code: "ROLLING" }] })).toEqual([{ code: "ROLLING", text: whyShownText({ code: "ROLLING" }) }]);
    expect(explainWhyShown([{ code: "ROLLING" }])).toHaveLength(1);
  });
});

describe("module purity", () => {
  const dir = import.meta.dirname;
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ f, text: readFileSync(join(dir, f), "utf8") }));

  it("imports nothing that carries SensitiveAnswers", () => {
    for (const { f, text } of sources) {
      expect(text, f).not.toMatch(/from\s+["'][^"']*eligibility\/sensitive["']/);
      expect(text, f).not.toMatch(/from\s+["'][^"']*contracts\/sensitive["']/);
    }
  });

  it("does no I/O (no fetch, storage, cookies or logging)", () => {
    for (const { f, text } of sources) {
      expect(text, f).not.toMatch(/\bfetch\(|localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon|XMLHttpRequest|console\./);
    }
  });
});
