import { describe, expect, it } from "vitest";
import { renderColumn } from "./__fixtures__/render";
import { resolveNow } from "./dates";
import { averageCharWidth, isMetaText, layoutLines, MAX_INPUT_CHARS } from "./layout";
import { headingText, lexiconKey, splitSections } from "./sections";
import { editDistance, foldForMatch, isAllCaps, normalizeKey, normalizeText, slugify, splitCells, splitList, stripBullet } from "./text";

const NOW = resolveNow("2026-11-11");

describe("normalizeText", () => {
  it("turns private-use bullets, odd spaces, dashes and quotes into one spelling each", () => {
    expect(normalizeText("\uF0B7 Built\u00A0a tool")).toBe("• Built a tool");
    expect(normalizeText("Jun 2024 – Aug 2024 — now")).toBe("Jun 2024 - Aug 2024 - now");
    expect(normalizeText("’25 “quoted”")).toBe("'25 \"quoted\"");
    expect(normalizeText("classiﬁed co\u00ADop\u200B")).toBe("classified coop");
    expect(normalizeText("one\u2028two\r\nthree\rfour")).toBe("one\ntwo\nthree\nfour");
  });
});

describe("text helpers", () => {
  it("splits cells without cutting a protected date range", () => {
    expect(splitCells("Intern | Acme\tJun 2025 - Aug 2025", [[18, 35]])).toEqual(["Intern", "Acme", "Jun 2025 - Aug 2025"]);
    expect(splitCells("A   B - C")).toEqual(["A", "B", "C"]);
  });

  it("splits lists but never inside brackets", () => {
    expect(splitList("Python, Java; SQL • Git | Dean's List (Fall 2025, Spring 2026)")).toEqual(["Python", "Java", "SQL", "Git", "Dean's List (Fall 2025, Spring 2026)"]);
  });

  it("recognizes bullets but not numbers", () => {
    expect(stripBullet("• Built it")).toBe("Built it");
    expect(stripBullet("- Built it")).toBe("Built it");
    expect(stripBullet("1. Built it")).toBe("Built it");
    expect(stripBullet("3.8 GPA")).toBe("3.8 GPA");
    expect(stripBullet("-5% churn")).toBe("-5% churn");
  });

  it("folds accents without changing length, so offsets map back", () => {
    expect(foldForMatch("José Nguyễn")).toBe("jose nguyen");
    expect(foldForMatch("José Nguyễn").length).toBe("José Nguyễn".length);
  });

  it("has small, exact helpers", () => {
    expect(isAllCaps("EDUCATION")).toBe(true);
    expect(isAllCaps("Education")).toBe(false);
    expect(normalizeKey("Skills & Interests:")).toBe("skills and interests");
    expect(editDistance("experiance", "experience")).toBe(1);
    expect(editDistance("expreience", "experience")).toBe(1);
    expect(slugify("C++")).toBe("c-plus-plus");
    expect(slugify("Node.js")).toBe("node-js");
  });
});

describe("layoutLines", () => {
  it("merges glyph-split items into words and keeps word gaps as spaces", () => {
    const lines = renderColumn([{ text: "Classified 800 cell images" }], { x: 40, top: 700, glyphs: true });
    expect(layoutLines({ text: "", lines }, NOW).lines.map((l) => l.text)).toEqual(["Classified 800 cell images"]);
  });

  it("keeps a right-aligned date as its own cell", () => {
    const lines = renderColumn([{ text: "Acme Robotics", bold: true, right: "Jun 2026 – Aug 2026" }], { x: 36, top: 700 });
    const [line] = layoutLines({ text: "", lines }, NOW).lines;
    expect(line?.text).toBe("Acme Robotics\tJun 2026 - Aug 2026");
    expect(line?.bold).toBe(true);
  });

  it("reads a two-column page left column first and flags it", () => {
    const left = renderColumn([{ text: "SKILLS", bold: true }, { text: "Python" }, { text: "SQL" }, { text: "Git" }, { text: "Excel" }, { text: "Figma" }], { x: 36, top: 700 });
    const right = renderColumn([{ text: "EXPERIENCE", bold: true }, { text: "Data Intern at a lab" }, { text: "Cleaned survey data" }, { text: "Built a dashboard" }, { text: "Barista at a cafe" }, { text: "Made coffee" }], { x: 230, top: 700 });
    const result = layoutLines({ text: "", lines: [...left, ...right] }, NOW);
    expect(result.twoColumn).toBe(true);
    expect(result.lines.map((l) => l.text)).toEqual(["SKILLS", "Python", "SQL", "Git", "Excel", "Figma", "EXPERIENCE", "Data Intern at a lab", "Cleaned survey data", "Built a dashboard", "Barista at a cafe", "Made coffee"]);
  });

  it("does not split a single column with right-aligned dates", () => {
    const lines = renderColumn(
      [
        { text: "Acme", right: "Jun 2026 – Aug 2026" },
        { text: "Intern" },
        { text: "Kroger", right: "2025 – 2026" },
        { text: "Cashier" },
        { text: "Target", right: "2024" },
        { text: "Team Member" },
      ],
      { x: 36, top: 700 },
    );
    expect(layoutLines({ text: "", lines }, NOW).twoColumn).toBe(false);
  });

  it("reads pasted text with Markdown, underlines and blank lines", () => {
    const result = layoutLines({ text: "# Jane\n\nExperience\n----------\n**Intern**, Acme\n  - did things" }, NOW);
    expect(result.positional).toBe(false);
    expect(result.lines.map((l) => [l.text, l.markdownHeading, l.underlined, l.blankBefore])).toEqual([
      ["Jane", true, false, false],
      ["Experience", false, true, true],
      ["Intern, Acme", false, false, false],
      ["- did things", false, false, false],
    ]);
  });

  it("caps the input size", () => {
    expect(layoutLines({ text: "x".repeat(50) + "\n".repeat(1) + "y\n".repeat(MAX_INPUT_CHARS) }, NOW).truncated).toBe(true);
  });

  it("measures character width from non-bold items", () => {
    expect(averageCharWidth([{ text: "abcd", w: 20, bold: false }, { text: "AB", w: 30, bold: true }], 10)).toBe(5);
    expect(averageCharWidth([], 10)).toBe(5);
  });

  it("treats dates, places and GPAs as metadata", () => {
    expect(isMetaText("Jun 2026 - Present", NOW)).toBe(true);
    expect(isMetaText("Columbus, OH", NOW)).toBe(true);
    expect(isMetaText("Data Science Intern", NOW)).toBe(false);
  });
});

describe("sections", () => {
  it("matches the heading lexicon, allowing one typo in long words", () => {
    expect(lexiconKey("Work Experiance")).toBe("experience");
    expect(lexiconKey("Skills & Interests")).toBe("skills");
    expect(lexiconKey("Clubs/Organizations")).toBe("activities");
    expect(lexiconKey("Banana")).toBeNull();
    expect(headingText("## EDUCATION:")).toBe("EDUCATION");
  });

  it("needs a visual cue for one-word headings that are also list items", () => {
    const plain = layoutLines({ text: "Jane Doe\nSKILLS\nCommunication\nLeadership\nTeamwork" }, NOW);
    expect(splitSections(plain.lines, null).sections.map((s) => s.key)).toEqual(["skills"]);
    const cued = layoutLines({ text: "Jane Doe\nSKILLS\nPython\n\nLEADERSHIP\nCaptain, Soccer Team" }, NOW);
    expect(splitSections(cued.lines, null).sections.map((s) => s.key)).toEqual(["skills", "activities"]);
  });

  it("accepts unlisted headings by head noun and keeps entry titles out", () => {
    const result = layoutLines({ text: "Jane Doe\nSOFTWARE ENGINEERING EXPERIENCE\nIntern, Acme\nRESEARCH ASSISTANT\nLab work" }, NOW);
    const s = splitSections(result.lines, null);
    expect(s.sections.map((x) => x.key)).toEqual(["experience"]);
    expect(s.profile.map((l) => l.text)).toEqual(["Jane Doe"]);
  });
});
