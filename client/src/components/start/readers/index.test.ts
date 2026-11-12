import { describe, expect, it } from "vitest";
import { parseResumeText } from "@shared/resume";
import { pdfItemsToLines } from "@shared/resume/readers";
import { READER_MESSAGES, configurePdfWorker, fileKind, readResumeFile, readersAvailable, suggestsBuilder } from "./index";

/** A pdf.js-like text item at (x, y) with a 10pt font and 5 units per character. */
function item(str: string, x: number, y: number, font = "f1", size = 10) {
  return { str, transform: [size, 0, 0, size, x, y], width: str.length * 5, height: size, fontName: font };
}

function fakeFile(name: string, type: string, bytes: Uint8Array): File {
  return { name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(0) as ArrayBuffer } as unknown as File;
}

describe("client readers over @shared/resume/readers", () => {
  it("reports PDF reading as available with the bundled same-origin worker, and never a CDN", async () => {
    const a = await readersAvailable();
    expect(a.pdf).toBe(true);
    configurePdfWorker("https://cdn.example.org/pdf.worker.min.mjs");
    expect((await readersAvailable()).pdf).toBe(false);
    configurePdfWorker("/assets/pdf.worker.min.mjs");
    expect((await readersAvailable()).pdf).toBe(true);
  });

  it("accepts PDF and Word files only, by type or extension", () => {
    expect(fileKind("resume.PDF", "")).toBe("pdf");
    expect(fileKind("x", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(fileKind("notes.txt", "text/plain")).toBeNull();
  });

  it("refuses unsupported, oversized and unreadable files with typed codes only", async () => {
    expect(await readResumeFile(fakeFile("a.png", "image/png", new Uint8Array(4)))).toEqual({ ok: false, code: "unsupported-type" });
    const big = { name: "big.pdf", type: "application/pdf", size: 6 * 1024 * 1024, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as File;
    expect(await readResumeFile(big)).toEqual({ ok: false, code: "too-large" });
    const junk = await readResumeFile(fakeFile("junk.docx", "", new TextEncoder().encode("not a zip")));
    expect(junk.ok).toBe(false);
  });

  it("sends a scanned PDF to the builder, never to a paste box with nothing to paste", () => {
    expect(suggestsBuilder("scanned-pdf")).toBe(true);
    expect(suggestsBuilder("too-large")).toBe(false);
    expect(READER_MESSAGES["scanned-pdf"]).toMatch(/three quick questions/);
    expect(READER_MESSAGES["scanned-pdf"]).not.toMatch(/Paste the text/);
  });

  it("keeps fragments unmerged so a two-column SAMPLE PDF parses column by column", () => {
    // Left column: education and skills. Right column: experience. Same baselines.
    const items = [
      item("SAMPLE STUDENT", 40, 760, "bold", 16),
      item("EDUCATION", 40, 720, "bold"),
      item("EXPERIENCE", 320, 720, "bold"),
      item("Sample State University", 40, 705),
      item("Research Assistant", 320, 705),
      item("B.S. Computer Science, 2030", 40, 690),
      item("Sample Lab, Sep 2025 – Present", 320, 690),
      item("SKILLS", 40, 660, "bold"),
      item("• Cleaned survey data in Python", 320, 675),
      item("Python, SQL, Tableau", 40, 645),
    ];
    const { lines } = pdfItemsToLines([{ page: 1, items, isBold: (f) => f === "bold" }]);
    expect(lines).toHaveLength(items.length);
    const parsed = parseResumeText({ text: "", lines, now: new Date("2026-11-11T15:00:00Z") });
    const skills = JSON.stringify(parsed.skills);
    expect(skills).toContain("Python");
    // The right column's role never ends up glued to the left column's school line.
    expect(JSON.stringify(parsed.education)).not.toContain("Research Assistant");
    expect(JSON.stringify(parsed.experience)).toContain("Research Assistant");
  });
});
