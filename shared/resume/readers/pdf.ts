import type { ResumeLine } from "../types";
import { READER_LIMITS, type ReaderResult, type ReaderWarningCode, type ReadOptions, type ResumeFileReader } from "./types";
import { loadOptional, safeLinks, toBytes } from "./util";

/**
 * PDF reader on pdfjs-dist (Apache-2.0), loaded lazily. It emits one ResumeLine per text item
 * with its position, width, size and boldness, and leaves grouping into lines and columns to
 * parseResumeText, which detects two-column layouts from exactly these fragments.
 *
 * Safety: isEvalSupported:false (the documented CVE-2024-4367 mitigation; harmless where the
 * option no longer exists), no font faces or system fonts, no cMap or standard-font URLs, and a
 * same-origin worker URL that the caller must supply. So parsing makes no network request, and
 * without a worker URL the reader reports "reader-unavailable" instead of reaching for a CDN.
 */

// -------------------------------------------------------------------------------------------
// The slice of the pdf.js API this reader uses (structural, so no types package is needed)
// -------------------------------------------------------------------------------------------

export interface PdfTextItemLike {
  str: string;
  transform: readonly number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL?: boolean;
}

export interface PdfPageLike {
  getTextContent(): Promise<{ items: readonly unknown[]; styles?: Record<string, { fontFamily?: string } | undefined> }>;
  getOperatorList?(): Promise<unknown>;
  getAnnotations?(): Promise<ReadonlyArray<{ subtype?: string; url?: string; unsafeUrl?: string }>>;
  commonObjs?: { get(name: string): unknown };
}

export interface PdfDocumentLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
  getMetadata?(): Promise<{ info?: Record<string, unknown> }>;
  destroy?(): Promise<void> | void;
}

export interface PdfjsLike {
  GlobalWorkerOptions?: { workerSrc: string };
  getDocument(params: Record<string, unknown>): { promise: Promise<PdfDocumentLike>; destroy?: () => Promise<void> | void };
}

export interface PdfReaderDeps {
  /** Loads pdfjs-dist. Defaults to a dynamic import of "pdfjs-dist" (pin 6.4.299). */
  loadPdfjs?: () => Promise<PdfjsLike | null>;
  /**
   * Same-origin worker URL, e.g. `import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"`.
   * Required: without it the reader does not run (a CDN default would leave the device).
   */
  workerSrc?: string | null;
  maxPages?: number;
}

// -------------------------------------------------------------------------------------------
// Pure conversion
// -------------------------------------------------------------------------------------------

/** pdf.js core marks bold from the real font name ("ABCDEF+Arial-BoldMT"). */
export function fontNameLooksBold(name: string | null | undefined): boolean {
  return !!name && /(?:semi|demi|extra|ultra)?bold|black|heavy|-bd\b|,bold/i.test(name);
}

/** Font size from the text matrix (vertical scale), falling back to the item height. */
export function itemFontSize(item: PdfTextItemLike): number {
  const t = item.transform;
  const size = Math.hypot(t[2] ?? 0, t[3] ?? 0);
  return size > 0 ? size : item.height > 0 ? item.height : 10;
}

export function isPdfTextItem(x: unknown): x is PdfTextItemLike {
  const r = x as Record<string, unknown> | null;
  return !!r && typeof r.str === "string" && Array.isArray(r.transform) && typeof r.width === "number";
}

export interface PdfPageItems {
  page: number;
  items: readonly unknown[];
  /** True when the item's font is bold; readers resolve it from pdf.js's font objects. */
  isBold: (fontName: string) => boolean;
}

/**
 * pdf.js items to ResumeLine fragments, one per non-empty item. Positions are rounded to a
 * tenth of a point; nothing is merged here (parseResumeText does that, column-aware).
 */
export function pdfItemsToLines(pages: readonly PdfPageItems[], maxItems: number = READER_LIMITS.maxItems): { lines: ResumeLine[]; truncated: boolean } {
  const lines: ResumeLine[] = [];
  for (const p of pages) {
    for (const raw of p.items) {
      if (!isPdfTextItem(raw) || raw.str.trim() === "") continue;
      if (lines.length >= maxItems) return { lines, truncated: true };
      const x = raw.transform[4] ?? 0;
      const y = raw.transform[5] ?? 0;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      lines.push({
        text: raw.str,
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        width: Math.round(Math.max(0, raw.width) * 10) / 10,
        fontSize: Math.round(itemFontSize(raw) * 10) / 10,
        bold: p.isBold(raw.fontName),
        page: p.page,
      });
    }
  }
  return { lines, truncated: false };
}

/** A text layer this thin means a scanned page: offer paste instead of an empty parse. */
export function looksScanned(lines: readonly ResumeLine[], pages: number, minPerPage: number = READER_LIMITS.minCharsPerPage): boolean {
  const chars = lines.reduce((n, l) => n + l.text.replace(/\s/g, "").length, 0);
  return chars < minPerPage * Math.max(1, pages);
}

/** Fragments to plain text, one row per baseline, for the paste box and `text`. */
export function fragmentsToText(lines: readonly ResumeLine[]): string {
  const rows: ResumeLine[][] = [];
  const sorted = [...lines].sort((a, b) => (a.page ?? 1) - (b.page ?? 1) || (b.y ?? 0) - (a.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));
  for (const l of sorted) {
    const row = rows[rows.length - 1];
    const head = row?.[0];
    if (head && head.page === l.page && Math.abs((head.y ?? 0) - (l.y ?? 0)) <= 0.5 * Math.min(head.fontSize ?? 10, l.fontSize ?? 10)) row.push(l);
    else rows.push([l]);
  }
  return rows
    .map((row) => {
      const sortedRow = [...row].sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
      let out = "";
      let end: number | null = null;
      for (const l of sortedRow) {
        const gap = end === null ? 0 : (l.x ?? 0) - end;
        const charWidth = (l.width ?? 0) / Math.max(1, l.text.length) || (l.fontSize ?? 10) * 0.5;
        out += end === null ? l.text : gap > 2.5 * charWidth ? `\t${l.text}` : gap > 0.25 * charWidth && !/\s$/.test(out) ? ` ${l.text}` : l.text;
        end = (l.x ?? 0) + (l.width ?? l.text.length * charWidth);
      }
      return out.trim();
    })
    .filter(Boolean)
    .join("\n");
}

// -------------------------------------------------------------------------------------------
// Reader
// -------------------------------------------------------------------------------------------

const PDFJS_SPECIFIER = "pdfjs-dist";

/**
 * The worker must come from this site: a relative path, a blob: URL the page made, or an
 * absolute URL on the page's own origin. A CDN worker would make parsing a network event.
 */
export function isSameOriginWorker(src: string | null | undefined): boolean {
  if (!src) return false;
  if (src.startsWith("blob:") || !/^[a-z][a-z0-9+.-]*:/i.test(src)) return !src.startsWith("//");
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  try {
    return !!origin && new URL(src).origin === origin;
  } catch {
    return false;
  }
}

function boldResolver(page: PdfPageLike, styles: Record<string, { fontFamily?: string } | undefined> | undefined): (fontName: string) => boolean {
  const cache = new Map<string, boolean>();
  return (fontName) => {
    const hit = cache.get(fontName);
    if (hit !== undefined) return hit;
    let bold = false;
    try {
      // fontName is pdf.js's internal id ("g_d0_f1"); the real name lives on the font object,
      // which exists once getOperatorList() has run. get() throws for unresolved fonts.
      const font = page.commonObjs?.get(fontName) as { name?: string; bold?: boolean; black?: boolean } | undefined;
      bold = !!(font?.bold || font?.black || fontNameLooksBold(font?.name));
    } catch {
      bold = false;
    }
    if (!bold) bold = fontNameLooksBold(styles?.[fontName]?.fontFamily);
    cache.set(fontName, bold);
    return bold;
  };
}

function authorOf(info: Record<string, unknown> | undefined): string | null {
  const a = info?.Author;
  return typeof a === "string" && a.trim() ? a.trim().slice(0, 120) : null;
}

export function createPdfReader(deps: PdfReaderDeps = {}): ResumeFileReader {
  const load = deps.loadPdfjs ?? (() => loadOptional<PdfjsLike>(PDFJS_SPECIFIER));
  const maxPages = deps.maxPages ?? READER_LIMITS.maxPdfPages;
  return {
    kind: "pdf",
    async read(data, options: ReadOptions = {}): Promise<ReaderResult> {
      const pdfjs = await load().catch(() => null);
      if (!pdfjs || !deps.workerSrc || !isSameOriginWorker(deps.workerSrc)) return { ok: false, code: "reader-unavailable" };
      if (pdfjs.GlobalWorkerOptions) pdfjs.GlobalWorkerOptions.workerSrc = deps.workerSrc;
      const task = pdfjs.getDocument({
        data: toBytes(data),
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        stopAtErrors: false,
        enableXfa: false,
      });
      let doc: PdfDocumentLike | null = null;
      try {
        doc = await task.promise;
        const count = Math.min(doc.numPages, maxPages);
        const pages: PdfPageItems[] = [];
        const links: string[] = [];
        for (let n = 1; n <= count; n++) {
          const page = await doc.getPage(n);
          await page.getOperatorList?.().catch(() => undefined);
          const content = await page.getTextContent();
          pages.push({ page: n, items: content.items, isBold: boldResolver(page, content.styles) });
          const annotations = await page.getAnnotations?.().catch(() => []);
          for (const a of annotations ?? []) if (a.subtype === "Link") links.push(a.url ?? a.unsafeUrl ?? "");
        }
        let author: string | null = null;
        try {
          author = authorOf((await doc.getMetadata?.())?.info);
        } catch {
          author = null;
        }
        const { lines, truncated } = pdfItemsToLines(pages);
        if (looksScanned(lines, count)) return { ok: false, code: "scanned-pdf" };
        const warnings: ReaderWarningCode[] = [];
        if (doc.numPages > maxPages) warnings.push("pages-truncated");
        if (truncated) warnings.push("items-truncated");
        return {
          ok: true,
          source: "pdf",
          lines,
          text: fragmentsToText(lines),
          pages: count,
          hints: { author, fileName: options.fileName ?? null, links: safeLinks(links) },
          warnings,
        };
      } catch (e) {
        const name = (e as { name?: unknown } | null)?.name;
        return { ok: false, code: name === "PasswordException" ? "password-protected" : "read-failed" };
      } finally {
        try {
          await doc?.destroy?.();
          await task.destroy?.();
        } catch {
          // Cleanup failures change nothing for the student.
        }
      }
    },
  };
}
