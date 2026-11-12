import type { ResumeHints, ResumeLine } from "../types";

/**
 * Reader adapter interface: a file on the device in, ResumeLine[] out. Nothing here uploads
 * anything; the bytes stay in memory for one call and are dropped. The PDF and DOCX readers load
 * their libraries with a dynamic import, so the app (and the server, which never imports this
 * folder) build and test without them, and the paste box covers every failure.
 *
 * Shapes and codes match client/src/components/start/readers so either side can adopt the other.
 */

export type ResumeSourceKind = "pdf" | "docx" | "text";

export const READER_ERROR_CODES = [
  "reader-unavailable",
  "too-large",
  "unsupported-type",
  "password-protected",
  "scanned-pdf",
  "timeout",
  "read-failed",
] as const;
export type ReaderErrorCode = (typeof READER_ERROR_CODES)[number];

/** Typed notes only: library messages can quote document text, so they are never passed on. */
export const READER_WARNING_CODES = ["pages-truncated", "items-truncated", "formatting-skipped"] as const;
export type ReaderWarningCode = (typeof READER_WARNING_CODES)[number];

export interface ReaderSuccess {
  ok: true;
  source: ResumeSourceKind;
  /** Positioned fragments (PDF) or one line per block (DOCX, text). Feed to parseResumeText. */
  lines: ResumeLine[];
  /** The same content as plain text, for parseResumeText's `text` and for the paste box. */
  text: string;
  pages: number;
  /** Device-only seeds for name redaction and links found in the file's annotations. */
  hints: ResumeHints;
  warnings: ReaderWarningCode[];
}

export interface ReaderFailure {
  ok: false;
  code: ReaderErrorCode;
}

export type ReaderResult = ReaderSuccess | ReaderFailure;

/** What the browser's File offers, declared here so shared code needs no DOM types. */
export interface FileLike {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ReadOptions {
  /** The file name; a name-redaction seed ("Jane_Doe_Resume.pdf"). Never sent anywhere. */
  fileName?: string;
}

/** One adapter per format. */
export interface ResumeFileReader {
  readonly kind: ResumeSourceKind;
  read(data: ArrayBuffer | Uint8Array, options?: ReadOptions): Promise<ReaderResult>;
}

/** Guard rails from the study notes: small files, few pages, a hard time limit. */
export const READER_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxPdfPages: 4,
  timeoutMs: 10_000,
  /** A page with fewer non-space characters than this is treated as scanned. */
  minCharsPerPage: 50,
  /** Fragments kept per document; a resume has a few thousand at most. */
  maxItems: 20_000,
} as const;

/** Plain-language messages for the start page; none of them quotes the file. */
export const READER_MESSAGES: Record<ReaderErrorCode, string> = {
  "reader-unavailable": "File reading isn't switched on here yet. Paste your resume text instead; it works the same way.",
  "too-large": "That file is over 5 MB. Export a smaller PDF or paste the text.",
  "unsupported-type": "Use a PDF or a Word (.docx) file, or paste the text.",
  "password-protected": "That PDF is password protected. Export a copy without a password, or paste the text.",
  "scanned-pdf": "That PDF looks like a scan, so there's no text to read. Paste the text instead.",
  timeout: "Reading took too long. Try a simpler export, or paste the text.",
  "read-failed": "We couldn't read that file. Paste the text instead.",
};
