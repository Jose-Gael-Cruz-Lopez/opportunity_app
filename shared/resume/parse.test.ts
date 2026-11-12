import { describe, expect, it } from "vitest";
import { HOLDOUT_RESUMES } from "./__fixtures__/holdout.sample";
import { SAMPLE_RESUMES } from "./__fixtures__/resumes.sample";
import { f1, group, precision, recall, scoreResume, type Scores } from "./__fixtures__/score";
import { parseResumeText } from "./parse";
import { toProfileSignals } from "./signals";

const NOW = "2026-11-11";

function parseSample(id: string) {
  const f = SAMPLE_RESUMES.find((s) => s.id === id);
  if (!f) throw new Error(`no sample ${id}`);
  return { f, parsed: parseResumeText({ ...f.input, now: f.now, hints: f.hints }) };
}

describe("SAMPLE suite: field-level precision and recall", () => {
  const scores: Scores = {};
  for (const f of SAMPLE_RESUMES) scoreResume(f.expected, parseResumeText({ ...f.input, now: f.now, hints: f.hints }), scores);

  it("labels every fixture as sample data and covers the required layouts", () => {
    expect(SAMPLE_RESUMES.length).toBeGreaterThanOrEqual(8);
    for (const f of SAMPLE_RESUMES) expect(f.label.startsWith("SAMPLE")).toBe(true);
    const layouts = new Set(SAMPLE_RESUMES.map((f) => f.layout));
    for (const l of ["pasted", "markdown", "pdf", "pdf-two-column", "docx", "pdf-glyphs", "builder"]) expect(layouts.has(l as never)).toBe(true);
    expect(SAMPLE_RESUMES.some((f) => f.sensitive.length > 0)).toBe(true);
  });

  it("reports per-field numbers", () => {
    const rows = Object.entries(scores)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, t]) => `${k.padEnd(24)} P=${precision(t).toFixed(2)} R=${recall(t).toFixed(2)} F1=${f1(t).toFixed(2)} (tp ${t.tp}, fp ${t.fp}, fn ${t.fn})`);
    console.info(`SAMPLE resume suite (${SAMPLE_RESUMES.length} resumes)\n${rows.join("\n")}`);
    expect(rows.length).toBeGreaterThan(10);
  });

  // Gates sit just under the measured numbers so a regression fails loudly. See README.md.
  const gates: Array<[string, number, number]> = [
    ["contact.", 0.95, 0.95],
    ["education.", 0.95, 0.95],
    ["experience.", 0.95, 0.95],
    ["skills", 0.9, 0.95],
    ["coursework", 0.95, 0.95],
    ["awards", 0.95, 0.95],
    ["projects.name", 0.95, 0.95],
  ];
  for (const [prefix, minP, minR] of gates) {
    it(`${prefix} precision >= ${minP} and recall >= ${minR}`, () => {
      const t = group(scores, prefix);
      expect(precision(t)).toBeGreaterThanOrEqual(minP);
      expect(recall(t)).toBeGreaterThanOrEqual(minR);
    });
  }

  it("institution, degree and graduation date each reach F1 >= 0.9", () => {
    for (const field of ["education.institution", "education.degreeLevel", "education.endDate"]) {
      expect(f1(scores[field]!)).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("infers the expected class year for every sample", () => {
    for (const f of SAMPLE_RESUMES) {
      if (f.expected.classYear === undefined) continue;
      const parsed = parseResumeText({ ...f.input, now: f.now, hints: f.hints });
      expect(toProfileSignals(parsed, { now: f.now }).classYear, f.id).toBe(f.expected.classYear);
    }
  });
});

describe("held-out SAMPLE resumes (written after tuning; first run P=0.95 R=0.95)", () => {
  const scores: Scores = {};
  for (const f of HOLDOUT_RESUMES) scoreResume(f.expected, parseResumeText({ ...f.input, now: f.now, hints: f.hints }), scores);
  const all = group(scores, "");

  it("are labelled sample data", () => {
    for (const f of HOLDOUT_RESUMES) expect(f.label.startsWith("SAMPLE")).toBe(true);
  });

  it("keep overall precision and recall at or above 0.95", () => {
    console.info(`held-out: P=${precision(all).toFixed(3)} R=${recall(all).toFixed(3)} (tp ${all.tp}, fp ${all.fp}, fn ${all.fn})`);
    expect(precision(all)).toBeGreaterThanOrEqual(0.95);
    expect(recall(all)).toBeGreaterThanOrEqual(0.95);
  });
});

describe("parseResumeText layouts", () => {
  it("reads a two-column PDF column by column and says it guessed", () => {
    const { parsed } = parseSample("pdf-two-column");
    expect(parsed.warnings.map((w) => w.code)).toContain("two-column-guess");
    expect(parsed.sections.map((s) => s.key)).toEqual(expect.arrayContaining(["skills", "coursework", "education", "experience", "projects"]));
    // Sidebar skills never leak into the main column's entries.
    for (const e of parsed.experience) expect(e.highlights.join(" ")).not.toMatch(/^(?:Python|SQL|Git)$/);
  });

  it("merges a Canva-style PDF split into one item per glyph", () => {
    const { parsed } = parseSample("pdf-glyph-split");
    expect(parsed.contact.email).toBe("ethan.kowalski@example.com");
    expect(parsed.experience[0]?.highlights[0]).toBe("Classified 800 cell images with a Python script");
  });

  it("keeps the order of a table-based DOCX and pairs role with organization", () => {
    const { parsed } = parseSample("docx-table");
    expect(parsed.experience.map((e) => [e.position, e.organization])).toEqual([
      ["Pharmacy Technician Trainee", "Walgreens"],
      ["Hospital Volunteer", "Jackson Memorial Hospital"],
    ]);
  });

  it("finds education placed last and a GPA marked unweighted", () => {
    const { parsed } = parseSample("hs-education-last");
    expect(parsed.education).toHaveLength(1);
    expect(parsed.education[0]).toMatchObject({ institution: "Westlake High School", degreeLevel: "high_school", endDate: "2027-05", endDateExpected: true, score: "3.8" });
  });

  it("does not take a heading for a name when there is no header block", () => {
    const { parsed } = parseSample("builder-minimal");
    expect(parsed.contact.name).toBeNull();
    expect(parsed.warnings.map((w) => w.code)).toContain("no-education-found");
  });

  it("keeps contact details and links on the parsed object only", () => {
    const { parsed } = parseSample("classic-pasted");
    expect(parsed.links.map((l) => l.kind)).toEqual(["linkedin", "github"]);
    expect(parsed.contact.aliases).toEqual(expect.arrayContaining(["jreyes"]));
  });

  it("drops a references section and says so", () => {
    const parsed = parseResumeText({
      text: "Ana Ruiz\nana@example.com\n\nEXPERIENCE\nCashier, Target  Jun 2025 - Present\n- Ran the register\n\nREFERENCES\nDr. Lena Park, Professor, 555-010-0101\n",
      now: NOW,
    });
    expect(parsed.warnings.map((w) => w.code)).toContain("references-dropped");
    expect(parsed.sections.map((s) => s.key)).not.toContain("references");
    expect(JSON.stringify(parsed)).not.toContain("Lena Park");
  });

  it("returns an empty resume with a warning for empty or junk input", () => {
    for (const input of [{ text: "" }, { text: "   \n\n " }, { text: 42 as unknown as string }, null as unknown as { text: string }]) {
      const parsed = parseResumeText(input);
      expect(parsed.warnings.map((w) => w.code)).toContain("empty-input");
      expect(parsed.experience).toEqual([]);
    }
  });

  it("bounds very long input and says it read the first part", () => {
    const line = "- Built a thing with Python and SQL for a class project at school\n";
    const parsed = parseResumeText({ text: `Pat Lee\n\nPROJECTS\n${line.repeat(3000)}`, now: NOW });
    expect(parsed.warnings.map((w) => w.code)).toContain("input-truncated");
  });

  it("uses the PDF author as a name hint without trusting placeholder authors", () => {
    const text = "Daniel Okafor\nColumbus, OH | daniel.okafor@example.edu\n\nSKILLS\nPython";
    const placeholder = parseResumeText({ text, now: NOW, hints: { author: "Microsoft Office User" } });
    expect(placeholder.contact.name).toBe("Daniel Okafor");
    expect(placeholder.contact.aliases.join(" ")).not.toMatch(/office|microsoft/i);
    expect(parseResumeText({ text, now: NOW, hints: { author: "Dani Okafor-Bello" } }).contact.aliases).toContain("Dani Okafor-Bello");
    expect(parseResumeText({ text, now: NOW, hints: { fileName: "Daniel_Okafor_Resume_FINAL.pdf" } }).contact.name).toBe("Daniel Okafor");
  });

  it("never throws on odd positioned input", () => {
    const lines = [
      { text: "", x: 0, y: 0 },
      { text: "Name", x: Number.NaN, y: 700 },
      { text: "EDUCATION", x: 36, y: 680, bold: true, fontSize: -3 },
      { text: "School", x: 36, y: 660, page: Number.POSITIVE_INFINITY },
    ];
    expect(() => parseResumeText({ text: "", lines })).not.toThrow();
  });
});
