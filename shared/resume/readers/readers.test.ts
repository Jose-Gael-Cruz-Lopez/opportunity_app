import { describe, expect, it } from "vitest";
import { parseResumeText } from "../parse";
import {
  createDocxReader,
  createPdfReader,
  createResumeReaders,
  docxTreeToLines,
  fileKind,
  fontNameLooksBold,
  fragmentsToText,
  isSameOriginWorker,
  itemFontSize,
  looksScanned,
  pdfItemsToLines,
  READER_ERROR_CODES,
  READER_MESSAGES,
  type FileLike,
  type MammothLike,
  type NodeLike,
  type PdfjsLike,
  type PdfTextItemLike,
} from "./index";
import { safeLinks } from "./util";

// ---------------------------------------------------------------------------------------------
// Fakes: just enough of pdf.js and of a DOM tree to drive the readers without the libraries
// ---------------------------------------------------------------------------------------------

function item(str: string, x: number, y: number, size = 10, fontName = "g_d0_f1"): PdfTextItemLike {
  return { str, transform: [size, 0, 0, size, x, y], width: str.length * size * 0.5, height: size, fontName, hasEOL: false };
}

/** A one-page SAMPLE resume as pdf.js would report it; f2 is the bold font. */
const SAMPLE_ITEMS: PdfTextItemLike[] = [
  item("Daniel Okafor", 230, 760, 20, "g_d0_f2"),
  item("Columbus, OH | daniel.okafor@example.edu | (555) 010-0187", 150, 738),
  item("EDUCATION", 36, 714, 11, "g_d0_f2"),
  item("The Ohio State University", 36, 698, 10, "g_d0_f2"),
  item("Expected May 2030", 490, 698),
  item("Bachelor of Science in Mechanical Engineering", 36, 685),
  item("SKILLS", 36, 661, 11, "g_d0_f2"),
  item("SolidWorks, MATLAB, Excel", 36, 645),
  { str: "", transform: [10, 0, 0, 10, 0, 0], width: 0, height: 10, fontName: "g_d0_f1" },
];

interface FakePdfOptions {
  items?: unknown[];
  numPages?: number;
  fail?: unknown;
  author?: string;
  links?: string[];
}

function fakePdfjs(options: FakePdfOptions = {}): PdfjsLike & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    GlobalWorkerOptions: { workerSrc: "" },
    getDocument(params) {
      calls.push(params);
      if (options.fail) return { promise: Promise.reject(options.fail) };
      return {
        promise: Promise.resolve({
          numPages: options.numPages ?? 1,
          async getPage() {
            return {
              async getTextContent() {
                return { items: options.items ?? SAMPLE_ITEMS, styles: { g_d0_f2: { fontFamily: "sans-serif" } } };
              },
              async getOperatorList() {
                return {};
              },
              async getAnnotations() {
                return (options.links ?? []).map((url) => ({ subtype: "Link", url }));
              },
              commonObjs: {
                get(name: string) {
                  if (name === "g_d0_f2") return { name: "ABCDEF+Helvetica-Bold" };
                  if (name === "g_d0_f1") return { name: "ABCDEF+Helvetica" };
                  throw new Error("font not resolved");
                },
              },
            };
          },
          async getMetadata() {
            return { info: { Author: options.author ?? "Daniel Okafor" } };
          },
        }),
      };
    },
  };
}

function el(name: string, children: NodeLike[] = [], attrs: Record<string, string> = {}): NodeLike {
  const node: NodeLike = {
    nodeType: 1,
    nodeName: name,
    childNodes: children,
    getAttribute: (k: string) => attrs[k] ?? null,
    get textContent() {
      return children.map((c) => c.textContent ?? "").join("");
    },
  };
  return node;
}

function txt(text: string): NodeLike {
  return { nodeType: 3, nodeName: "#text", textContent: text, childNodes: [] };
}

function file(name: string, type: string, size: number, buffer: ArrayBuffer = new ArrayBuffer(8)): FileLike {
  return { name, type, size, arrayBuffer: async () => buffer };
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

describe("PDF helpers", () => {
  it("reads bold from real font names", () => {
    for (const n of ["ABCDEF+Arial-BoldMT", "Helvetica-Bold", "Inter-SemiBold", "Roboto-Black", "OpenSans-ExtraBold", "Lato-Heavy"]) expect(fontNameLooksBold(n), n).toBe(true);
    for (const n of ["ABCDEF+Arial", "Helvetica-Oblique", "Times-Roman", "", undefined]) expect(fontNameLooksBold(n), String(n)).toBe(false);
  });

  it("takes the font size from the text matrix, falling back to the height", () => {
    expect(itemFontSize(item("x", 0, 0, 12))).toBe(12);
    expect(itemFontSize({ str: "x", transform: [0, 0, 0, 0, 0, 0], width: 5, height: 9, fontName: "f" })).toBe(9);
  });

  it("turns items into positioned fragments and skips empty or broken ones", () => {
    const { lines, truncated } = pdfItemsToLines([{ page: 1, items: [...SAMPLE_ITEMS, { nope: true }, item("NaN", Number.NaN, 5)], isBold: (f) => f === "g_d0_f2" }]);
    expect(truncated).toBe(false);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toEqual({ text: "Daniel Okafor", x: 230, y: 760, width: 130, fontSize: 20, bold: true, page: 1 });
    expect(pdfItemsToLines([{ page: 1, items: SAMPLE_ITEMS, isBold: () => false }], 3).truncated).toBe(true);
  });

  it("joins fragments into plain text with tabs for wide gaps", () => {
    const { lines } = pdfItemsToLines([{ page: 1, items: SAMPLE_ITEMS, isBold: () => false }]);
    const text = fragmentsToText(lines);
    expect(text.split("\n")[3]).toBe("The Ohio State University\tExpected May 2030");
  });

  it("calls a nearly empty text layer scanned", () => {
    expect(looksScanned([{ text: "1" }], 1)).toBe(true);
    expect(looksScanned([{ text: "x".repeat(60) }], 1)).toBe(false);
  });
});

describe("DOCX helpers", () => {
  it("emits one line per block, bold headings and lists as bullets", () => {
    const body = el("BODY", [
      el("H1", [txt("Sofia Martínez")]),
      el("P", [txt("Miami, FL | "), el("A", [txt("LinkedIn")], { href: "https://linkedin.com/in/sofia-martinez" })]),
      el("H2", [txt("EXPERIENCE")]),
      el("TABLE", [el("TR", [el("TD", [el("STRONG", [txt("Pharmacy Technician Trainee")])]), el("TD", [txt("Jan 2026 – Present")])])]),
      el("UL", [el("LI", [txt("Counted prescriptions")]), el("LI", [el("A", [txt("bad")], { href: "javascript:alert(1)" })])]),
      el("P", [txt("   ")]),
      el("SCRIPT", [txt("alert(1)")]),
    ]);
    const { lines, links } = docxTreeToLines(body);
    expect(lines).toEqual([
      { text: "Sofia Martínez", bold: true, fontSize: 20 },
      { text: "Miami, FL | LinkedIn", bold: false, fontSize: 11 },
      { text: "EXPERIENCE", bold: true, fontSize: 16 },
      { text: "Pharmacy Technician Trainee", bold: true, fontSize: 11 },
      { text: "Jan 2026 – Present", bold: false, fontSize: 11 },
      { text: "• Counted prescriptions", bold: false, fontSize: 11 },
      { text: "• bad", bold: false, fontSize: 11 },
    ]);
    expect(links).toEqual(["https://linkedin.com/in/sofia-martinez"]);
    expect(docxTreeToLines(null)).toEqual({ lines: [], links: [] });
  });

  it("keeps only http(s) and mailto links", () => {
    expect(safeLinks(["javascript:alert(1)", "https://a.example", "mailto:a@example.com", "data:text/html,x", 5, "https://a.example"])).toEqual(["https://a.example", "mailto:a@example.com"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Readers with fake libraries
// ---------------------------------------------------------------------------------------------

describe("createPdfReader", () => {
  it("reads a PDF into fragments the parser understands, with safe options and no network", async () => {
    const pdfjs = fakePdfjs({ links: ["https://linkedin.com/in/daniel-okafor", "javascript:void(0)"] });
    const reader = createPdfReader({ loadPdfjs: async () => pdfjs, workerSrc: "/assets/pdf.worker.min.mjs" });
    const result = await reader.read(new ArrayBuffer(16), { fileName: "Daniel_Okafor_Resume.pdf" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(pdfjs.calls[0]).toMatchObject({ isEvalSupported: false, disableFontFace: true, useSystemFonts: false });
    expect(pdfjs.calls[0]).not.toHaveProperty("cMapUrl");
    expect(pdfjs.calls[0]).not.toHaveProperty("standardFontDataUrl");
    expect(pdfjs.GlobalWorkerOptions?.workerSrc).toBe("/assets/pdf.worker.min.mjs");
    expect(result.hints).toEqual({ author: "Daniel Okafor", fileName: "Daniel_Okafor_Resume.pdf", links: ["https://linkedin.com/in/daniel-okafor"] });
    expect(result.lines.find((l) => l.text === "EDUCATION")?.bold).toBe(true);

    const parsed = parseResumeText({ text: result.text, lines: result.lines, hints: result.hints, now: "2026-11-11" });
    expect(parsed.contact.name).toBe("Daniel Okafor");
    expect(parsed.education[0]).toMatchObject({ institution: "The Ohio State University", area: "Mechanical Engineering", endDate: "2030-05" });
    expect(parsed.links.map((l) => l.kind)).toContain("linkedin");
  });

  it("accepts only a worker served by the app itself", () => {
    expect(isSameOriginWorker("/assets/pdf.worker.min.mjs")).toBe(true);
    expect(isSameOriginWorker("assets/pdf.worker.min.mjs")).toBe(true);
    expect(isSameOriginWorker("blob:https://novus.example/1234")).toBe(true);
    expect(isSameOriginWorker("https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs")).toBe(false);
    expect(isSameOriginWorker("//cdn.example/pdf.worker.js")).toBe(false);
    expect(isSameOriginWorker("")).toBe(false);
  });

  it("refuses to run without a same-origin worker URL or without the library", async () => {
    expect(await createPdfReader({ loadPdfjs: async () => fakePdfjs(), workerSrc: "https://cdn.example/pdf.worker.js" }).read(new ArrayBuffer(4))).toEqual({ ok: false, code: "reader-unavailable" });
    expect(await createPdfReader({ loadPdfjs: async () => fakePdfjs() }).read(new ArrayBuffer(4))).toEqual({ ok: false, code: "reader-unavailable" });
    expect(await createPdfReader({ loadPdfjs: async () => null, workerSrc: "/w.js" }).read(new ArrayBuffer(4))).toEqual({ ok: false, code: "reader-unavailable" });
    // A library that fails to load (missing package, blocked chunk) reads as unavailable too.
    expect(
      await createPdfReader({
        workerSrc: "/w.js",
        loadPdfjs: async () => {
          throw new Error("chunk failed to load");
        },
      }).read(new ArrayBuffer(4)),
    ).toEqual({ ok: false, code: "reader-unavailable" });
  });

  it("maps password, scanned and broken files to typed codes", async () => {
    const password = Object.assign(new Error("Need a password for Jane Doe's file"), { name: "PasswordException" });
    expect(await createPdfReader({ loadPdfjs: async () => fakePdfjs({ fail: password }), workerSrc: "/w.js" }).read(new ArrayBuffer(4))).toEqual({ ok: false, code: "password-protected" });
    expect(await createPdfReader({ loadPdfjs: async () => fakePdfjs({ items: [item("1", 0, 0)] }), workerSrc: "/w.js" }).read(new ArrayBuffer(4))).toEqual({ ok: false, code: "scanned-pdf" });
    expect(await createPdfReader({ loadPdfjs: async () => fakePdfjs({ fail: new Error("bad xref") }), workerSrc: "/w.js" }).read(new ArrayBuffer(4))).toEqual({ ok: false, code: "read-failed" });
  });

  it("reads four pages at most and says so", async () => {
    const result = await createPdfReader({ loadPdfjs: async () => fakePdfjs({ numPages: 9 }), workerSrc: "/w.js" }).read(new ArrayBuffer(4));
    expect(result.ok && result.pages).toBe(4);
    expect(result.ok && result.warnings).toEqual(["pages-truncated"]);
  });
});

describe("createDocxReader", () => {
  const tree = el("BODY", [el("H1", [txt("Sofia Martínez")]), el("P", [txt("sofia.martinez@example.edu")]), el("H2", [txt("SKILLS")]), el("P", [txt("Phlebotomy, CPR, Spanish")])]);

  it("converts with external file access off and walks the tree it is given", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const mammoth: MammothLike = {
      async convertToHtml(_input, options) {
        seen.push(options);
        return { value: "<h1>ignored by the fake parser</h1>", messages: [{ message: "Unrecognised style: quotes Sofia's text" }] };
      },
    };
    const result = await createDocxReader({ loadMammoth: async () => mammoth, parseHtml: () => tree }).read(new Uint8Array([1, 2, 3]), { fileName: "resume.docx" });
    expect(seen[0]).toMatchObject({ externalFileAccess: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toBe("Sofia Martínez\nsofia.martinez@example.edu\nSKILLS\nPhlebotomy, CPR, Spanish");
    // Library messages can quote the document, so only a typed code passes through.
    expect(result.warnings).toEqual(["formatting-skipped"]);
    expect(parseResumeText({ text: result.text, lines: result.lines, now: "2026-11-11" }).skills).toEqual(["Phlebotomy", "CPR", "Spanish"]);
  });

  it("reports unavailable without the library or a DOM parser, and read-failed on errors", async () => {
    expect(await createDocxReader({ loadMammoth: async () => null }).read(new ArrayBuffer(4))).toEqual({ ok: false, code: "reader-unavailable" });
    const mammoth: MammothLike = { convertToHtml: async () => ({ value: "<p>x</p>" }) };
    expect(await createDocxReader({ loadMammoth: async () => mammoth, parseHtml: () => null }).read(new ArrayBuffer(4))).toEqual({ ok: false, code: "reader-unavailable" });
    const broken: MammothLike = { convertToHtml: async () => Promise.reject(new Error("zip error")) };
    expect(await createDocxReader({ loadMammoth: async () => broken, parseHtml: () => tree }).read(new ArrayBuffer(4))).toEqual({ ok: false, code: "read-failed" });
  });
});

describe("createResumeReaders", () => {
  it("picks a reader by type and name", () => {
    expect(fileKind("cv.PDF", "")).toBe("pdf");
    expect(fileKind("cv", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(fileKind("cv.txt", "")).toBe("text");
    expect(fileKind("cv.pages", "application/octet-stream")).toBeNull();
  });

  it("rejects unsupported and oversized files before reading them", async () => {
    let touched = false;
    const big: FileLike = {
      name: "cv.pdf",
      type: "application/pdf",
      size: 6 * 1024 * 1024,
      arrayBuffer: async () => {
        touched = true;
        return new ArrayBuffer(1);
      },
    };
    const readers = createResumeReaders();
    expect(await readers.read(big)).toEqual({ ok: false, code: "too-large" });
    expect(await readers.read(file("cv.pages", "", 10))).toEqual({ ok: false, code: "unsupported-type" });
    expect(touched).toBe(false);
  });

  it("reads plain text files without any library", async () => {
    const bytes = new TextEncoder().encode("\uFEFFJane Doe\nSKILLS\nPython, SQL");
    const result = await createResumeReaders().read(file("resume.txt", "text/plain", bytes.byteLength, bytes.buffer as ArrayBuffer));
    expect(result).toMatchObject({ ok: true, source: "text", text: "Jane Doe\nSKILLS\nPython, SQL" });
  });

  it("times out slow reads with a typed code", async () => {
    const slow: PdfjsLike = { getDocument: () => ({ promise: new Promise(() => undefined) }) };
    const readers = createResumeReaders({ pdf: { loadPdfjs: async () => slow, workerSrc: "/w.js" }, timeoutMs: 20 });
    expect(await readers.read(file("cv.pdf", "application/pdf", 100))).toEqual({ ok: false, code: "timeout" });
  });

  it("has a plain message for every error code", () => {
    for (const code of READER_ERROR_CODES) expect(READER_MESSAGES[code].length).toBeGreaterThan(10);
  });
});
