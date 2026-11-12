import {
  READER_LIMITS,
  createResumeReaders,
  isSameOriginWorker,
  type DocxReaderDeps,
  type PdfReaderDeps,
  type ReaderErrorCode as SharedReaderErrorCode,
  type ReaderWarningCode,
  type ResumeReaders,
} from "@shared/resume/readers";
import type { ResumeHints, ResumeLine } from "@shared/resume";
// Same-origin worker URL from the build (never a CDN): Vite copies the file into /assets.
// The legacy build: the modern one needs very recent engines (Uint8Array.prototype.toHex and
// friends), and students open this on older phones and school laptops.
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

/**
 * On-device resume readers for /app/start: a thin wrapper over @shared/resume/readers, which
 * owns the PDF (pdfjs-dist 6.4.299) and DOCX (mammoth 1.13.0) adapters. The file is read into
 * memory, turned into positioned fragments and dropped; it never leaves the browser.
 *
 * The readers emit one fragment per PDF text item with x, y, width, size and boldness, and
 * parseResumeText groups them into rows and columns itself (layout.ts). That is what lets
 * two-column templates parse correctly, so nothing here merges or reorders lines.
 *
 * Both libraries load with a dynamic import, so they are their own chunks and only download
 * when a student picks a file. pdf.js runs with isEvalSupported:false (the CVE-2024-4367
 * mitigation), no font faces, no system fonts and no cMap or standard-font URLs.
 */

export type ReaderErrorCode = SharedReaderErrorCode;

export type ReaderResult =
  | { ok: true; source: "pdf" | "docx"; lines: ResumeLine[]; text: string; warnings: ReaderWarningCode[]; hints: ResumeHints }
  | { ok: false; code: ReaderErrorCode };

export const MAX_BYTES = READER_LIMITS.maxBytes;
export const MAX_PDF_PAGES = READER_LIMITS.maxPdfPages;
export const READ_TIMEOUT_MS = READER_LIMITS.timeoutMs;

export const READER_MESSAGES: Record<ReaderErrorCode, string> = {
  "reader-unavailable": "File reading isn't available in this browser. Paste your resume text instead; it works the same way.",
  "too-large": "That file is over 5 MB. Export a smaller PDF or paste the text.",
  "unsupported-type": "Use a PDF or a Word (.docx) file, or paste the text.",
  "password-protected": "That PDF is password protected. Export a copy without a password, or paste the text.",
  // A scan or photo has no text to copy, so pasting is not a way out. Point to what works.
  "scanned-pdf": "That PDF looks like a scan or photo, so there's no text in it to read. Export the original document as a PDF again, or answer three quick questions instead.",
  timeout: "Reading took too long. Try a simpler PDF export, or paste the text.",
  "read-failed": "We couldn't read that file. Paste the text instead.",
};

/** The upload box takes PDF and Word files; pasted text goes through the paste box. */
export function fileKind(name: string, type: string): "pdf" | "docx" | null {
  const n = name.toLowerCase();
  if (type === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || n.endsWith(".docx")) return "docx";
  return null;
}

/** Error codes where the three-question builder is the useful next step (no text to paste). */
export function suggestsBuilder(code: ReaderErrorCode): boolean {
  return code === "scanned-pdf";
}

/* ---------- library loading ---------- */

const loadPdfjs: NonNullable<PdfReaderDeps["loadPdfjs"]> = async () =>
  (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as Awaited<ReturnType<NonNullable<PdfReaderDeps["loadPdfjs"]>>>;

const loadMammoth: NonNullable<DocxReaderDeps["loadMammoth"]> = async () => {
  const mod = (await import("mammoth")) as unknown as { default?: unknown };
  return (mod.default ?? mod) as Awaited<ReturnType<NonNullable<DocxReaderDeps["loadMammoth"]>>>;
};

let workerSrc: string | null = typeof pdfWorkerUrl === "string" && pdfWorkerUrl ? pdfWorkerUrl : null;
let readers: ResumeReaders | null = null;

/** Overrides the worker URL (tests, or a build that serves it elsewhere on this origin). */
export function configurePdfWorker(url: string | null): void {
  workerSrc = url;
  readers = null;
}

function currentReaders(): ResumeReaders {
  readers ??= createResumeReaders({
    pdf: { workerSrc, loadPdfjs },
    docx: { loadMammoth },
  });
  return readers;
}

export interface ReadersAvailability {
  pdf: boolean;
  docx: boolean;
}

/**
 * Whether file reading works here: PDF needs a same-origin worker URL, DOCX needs DOMParser to
 * walk mammoth's HTML without rendering it. Neither library is downloaded to answer this.
 */
export async function readersAvailable(): Promise<ReadersAvailability> {
  return {
    pdf: isSameOriginWorker(workerSrc),
    docx: typeof DOMParser !== "undefined",
  };
}

/** Reads a resume file on the device. The ArrayBuffer is local to the call and then dropped. */
export async function readResumeFile(file: File): Promise<ReaderResult> {
  const kind = fileKind(file.name, file.type);
  if (!kind) return { ok: false, code: "unsupported-type" };
  const result = await currentReaders().read(file);
  if (!result.ok) return result;
  if (result.source === "text") return { ok: false, code: "unsupported-type" };
  // The file name and PDF author are name-redaction seeds; they stay on the device.
  return { ok: true, source: result.source, lines: result.lines, text: result.text, warnings: result.warnings, hints: result.hints };
}
