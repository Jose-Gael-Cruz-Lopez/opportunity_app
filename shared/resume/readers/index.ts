import { createDocxReader, type DocxReaderDeps } from "./docx";
import { createPdfReader, type PdfReaderDeps } from "./pdf";
import { READER_LIMITS, type FileLike, type ReaderResult, type ResumeFileReader, type ResumeSourceKind } from "./types";
import { withTimeout } from "./util";

/**
 * shared/resume/readers: reads a resume file on the device into ResumeLine[] for
 * parseResumeText. Import it from the browser only (ideally inside a Web Worker); the server
 * never needs it, which is why shared/resume/index.ts does not re-export it.
 *
 * Wiring in the client, once pdfjs-dist and mammoth are installed:
 *
 *   import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
 *   const readers = createResumeReaders({
 *     pdf: { workerSrc, loadPdfjs: () => import("pdfjs-dist") },
 *     docx: { loadMammoth: () => import("mammoth").then((m) => m.default ?? m) },
 *   });
 *   const result = await readers.read(file);
 *   if (result.ok) parseResumeText({ text: result.text, lines: result.lines, hints: result.hints });
 *   else show(READER_MESSAGES[result.code]) and fall back to the paste box.
 */

export * from "./types";
export { createPdfReader, pdfItemsToLines, fragmentsToText, looksScanned, fontNameLooksBold, itemFontSize, isSameOriginWorker, type PdfjsLike, type PdfReaderDeps, type PdfPageItems, type PdfTextItemLike } from "./pdf";
export { createDocxReader, docxTreeToLines, type DocxReaderDeps, type MammothLike, type NodeLike } from "./docx";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export function fileKind(name: string, type: string): ResumeSourceKind | null {
  const n = (name ?? "").toLowerCase();
  if (type === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (type === DOCX_MIME || n.endsWith(".docx")) return "docx";
  if (type === "text/plain" || n.endsWith(".txt") || n.endsWith(".md")) return "text";
  return null;
}

/** Plain text files need no library; decoding happens here. */
export function createTextReader(): ResumeFileReader {
  return {
    kind: "text",
    async read(data, options = {}) {
      try {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        const text = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
        if (!text.trim()) return { ok: false, code: "read-failed" };
        const lines = text.split(/\r\n?|\n/).map((t) => ({ text: t }));
        return { ok: true, source: "text", lines, text, pages: 1, hints: { fileName: options.fileName ?? null }, warnings: [] };
      } catch {
        return { ok: false, code: "read-failed" };
      }
    },
  };
}

export interface ResumeReadersDeps {
  pdf?: PdfReaderDeps;
  docx?: DocxReaderDeps;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface ResumeReaders {
  read(file: FileLike): Promise<ReaderResult>;
}

/**
 * Picks the reader by type, enforces the size cap and the time limit, and turns every failure
 * into a typed code (never a message that could quote the file). The bytes live only inside
 * this call.
 */
export function createResumeReaders(deps: ResumeReadersDeps = {}): ResumeReaders {
  const readers: Record<ResumeSourceKind, ResumeFileReader> = {
    pdf: createPdfReader(deps.pdf),
    docx: createDocxReader(deps.docx),
    text: createTextReader(),
  };
  const maxBytes = deps.maxBytes ?? READER_LIMITS.maxBytes;
  const timeoutMs = deps.timeoutMs ?? READER_LIMITS.timeoutMs;
  return {
    async read(file) {
      const kind = fileKind(file?.name ?? "", file?.type ?? "");
      if (!kind) return { ok: false, code: "unsupported-type" };
      if (!(file.size >= 0) || file.size > maxBytes) return { ok: false, code: "too-large" };
      try {
        const work = file.arrayBuffer().then((buffer) => readers[kind].read(buffer, { fileName: file.name }));
        return await withTimeout(work, timeoutMs);
      } catch (e) {
        return { ok: false, code: (e as Error | null)?.message === "timeout" ? "timeout" : "read-failed" };
      }
    },
  };
}
