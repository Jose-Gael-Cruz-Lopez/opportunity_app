import { describe, expect, it } from "vitest";
import { ProgramCardSchema } from "../contracts/registry";
import { buildSamplePrograms, SAMPLE_PERSONAS, SAMPLE_SPECS } from "./sample";

describe("sample data", () => {
  const programs = buildSamplePrograms("2026-11-11T15:00:00Z");

  it("has about thirty programs, all labelled sample and linked to example.org", () => {
    expect(programs.length).toBe(SAMPLE_SPECS.length);
    expect(programs.length).toBeGreaterThanOrEqual(30);
    for (const p of programs) {
      expect(p.isSample).toBe(true);
      expect(p.name.startsWith("Sample:")).toBe(true);
      expect(p.organizationName.endsWith("(sample)")).toBe(true);
      expect(new URL(p.officialUrl).hostname).toBe("example.org");
    }
  });

  it("builds cards that pass the shared ProgramCard contract", () => {
    for (const p of programs) {
      const { extras: _extras, ...card } = p;
      const parsed = ProgramCardSchema.safeParse(card);
      if (!parsed.success) throw new Error(`${p.slug}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
  });

  it("names an existing program for every persona", () => {
    const slugs = new Set(programs.map((p) => p.slug));
    expect(SAMPLE_PERSONAS).toHaveLength(8);
    for (const persona of SAMPLE_PERSONAS) expect(slugs.has(persona.expectedSlug)).toBe(true);
  });

  it("stays current: dates move with the build date", () => {
    const later = buildSamplePrograms("2027-03-01T15:00:00Z");
    const a = programs.find((p) => p.slug === "sample-civic-data-internship")!;
    const b = later.find((p) => p.slug === "sample-civic-data-internship")!;
    expect(a.deadlines[0]?.localDate).not.toBe(b.deadlines[0]?.localDate);
  });
});
