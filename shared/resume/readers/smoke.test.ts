import { describe, expect, it } from "vitest";
import { parseResumeText } from "../parse";
import { createResumeReaders, type MammothLike, type NodeLike, type PdfjsLike } from "./index";

/**
 * Smoke test with the real libraries (pdfjs-dist 6.4.299, mammoth 1.13.0) on SAMPLE documents
 * built in memory. Every name, school and detail below is invented.
 *
 * pdf.js's legacy build is used (the client uses it too; the modern build needs engines newer
 * than Node 24 and many phones). In Node it runs its worker in-process and imports the worker
 * module relative to its own build folder, so the relative "./pdf.worker.mjs" is also what the same-origin check accepts.
 * DOCX HTML is walked with @xmldom/xmldom (a mammoth dependency) in place of the browser's
 * DOMParser.
 */

interface Run {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly bold?: boolean;
  readonly size?: number;
}

/** A one-page PDF with Helvetica runs at fixed positions (no fonts embedded, nothing fetched). */
function samplePdf(runs: readonly Run[]): Uint8Array {
  const esc = (t: string) => t.replace(/[\\()]/g, (m) => `\\${m}`);
  const content = runs.map((r) => `BT /${r.bold ? "F2" : "F1"} ${r.size ?? 10} Tf ${r.x} ${r.y} Td (${esc(r.text)}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** A minimal DOCX: heading paragraphs and plain paragraphs. */
async function sampleDocx(paragraphs: readonly { text: string; heading?: boolean }[]): Promise<Uint8Array> {
  const { default: JSZip } = (await import("jszip")) as unknown as { default: new () => { file(n: string, d: string): void; generateAsync(o: { type: "uint8array" }): Promise<Uint8Array> } };
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  const body = paragraphs
    .map((p) =>
      p.heading
        ? `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${p.text}</w:t></w:r></w:p>`
        : `<w:p><w:r><w:t xml:space="preserve">${p.text}</w:t></w:r></w:p>`,
    )
    .join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

function file(name: string, type: string, bytes: Uint8Array) {
  return { name, type, size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
}

const NOW = new Date("2026-11-11T15:00:00Z");

describe("readers with the real libraries (SAMPLE documents)", () => {
  it("reads a two-column SAMPLE PDF into positioned fragments that parse column by column", async () => {
    const readers = createResumeReaders({
      pdf: { workerSrc: "./pdf.worker.mjs", loadPdfjs: async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsLike },
    });
    const pdf = samplePdf([
      { text: "Sample Student", x: 40, y: 750, bold: true, size: 18 },
      { text: "EDUCATION", x: 40, y: 700, bold: true },
      { text: "EXPERIENCE", x: 320, y: 700, bold: true },
      { text: "Sample State University", x: 40, y: 685 },
      { text: "Research Assistant", x: 320, y: 685, bold: true },
      { text: "B.S. Computer Science, May 2030", x: 40, y: 670 },
      { text: "Sample Lab, Sep 2025 - Present", x: 320, y: 670 },
      { text: "- Cleaned survey data with Python and SQL", x: 320, y: 655 },
      { text: "SKILLS", x: 40, y: 630, bold: true },
      { text: "Python, SQL, Tableau", x: 40, y: 615 },
      { text: "- Built weekly charts in Tableau for the lab", x: 320, y: 640 },
    ]);
    const result = await readers.read(file("Sample_Student_Resume.pdf", "application/pdf", pdf));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("pdf");
    expect(result.lines.length).toBe(11);
    expect(result.lines.find((l) => l.text === "EDUCATION")?.bold).toBe(true);
    expect(result.lines.find((l) => l.text === "Research Assistant")?.x).toBe(320);
    expect(result.hints.fileName).toBe("Sample_Student_Resume.pdf");

    const parsed = parseResumeText({ text: result.text, lines: result.lines, now: NOW, hints: result.hints });
    expect(JSON.stringify(parsed.skills)).toContain("Python");
    expect(JSON.stringify(parsed.education)).toContain("Sample State University");
    expect(JSON.stringify(parsed.education)).not.toContain("Research Assistant");
    expect(JSON.stringify(parsed.experience)).toContain("Research Assistant");
  }, 20_000);

  it("reports a PDF with no text layer as scanned", async () => {
    const readers = createResumeReaders({
      pdf: { workerSrc: "./pdf.worker.mjs", loadPdfjs: async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsLike },
    });
    const result = await readers.read(file("scan.pdf", "application/pdf", samplePdf([{ text: "x", x: 40, y: 700 }])));
    expect(result).toEqual({ ok: false, code: "scanned-pdf" });
  }, 20_000);

  it("reads a SAMPLE DOCX through mammoth without rendering its HTML", async () => {
    const { DOMParser } = (await import("@xmldom/xmldom")) as unknown as { DOMParser: new () => { parseFromString(s: string, t: string): unknown } };
    const readers = createResumeReaders({
      docx: {
        loadMammoth: async () => {
          const mod = (await import("mammoth")) as unknown as { default?: MammothLike } & MammothLike;
          const m = mod.default ?? mod;
          // mammoth's Node entry reads { buffer }; its browser build (what Vite bundles, via the
          // package's "browser" field) reads the { arrayBuffer } the reader passes.
          return {
            convertToHtml: (input, options) =>
              (m.convertToHtml as unknown as (i: { buffer: Uint8Array }, o?: Record<string, unknown>) => ReturnType<MammothLike["convertToHtml"]>)(
                { buffer: new Uint8Array(input.arrayBuffer) },
                options,
              ),
          };
        },
        parseHtml: (html) => {
          const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html") as { documentElement: NodeLike };
          return doc.documentElement;
        },
      },
    });
    const docx = await sampleDocx([
      { text: "Sample Student" },
      { text: "EDUCATION", heading: true },
      { text: "Sample State University, B.S. Biology, May 2029" },
      { text: "SKILLS", heading: true },
      { text: "Python, R, Excel" },
    ]);
    const result = await readers.read(file("resume.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx));
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.source).toBe("docx");
    expect(result.lines.map((l) => l.text)).toContain("EDUCATION");
    expect(result.lines.find((l) => l.text === "EDUCATION")?.bold).toBe(true);
    const parsed = parseResumeText({ text: result.text, lines: result.lines, now: NOW });
    expect(JSON.stringify(parsed.skills)).toContain("Python");
    expect(JSON.stringify(parsed.education)).toContain("Sample State University");
  }, 20_000);
});
