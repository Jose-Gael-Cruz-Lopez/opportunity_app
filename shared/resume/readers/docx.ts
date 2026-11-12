import type { ResumeLine } from "../types";
import type { ReaderResult, ReadOptions, ResumeFileReader } from "./types";
import { loadOptional, safeLinks } from "./util";

/**
 * DOCX reader on mammoth (BSD-2-Clause), loaded lazily. convertToHtml keeps headings, bold and
 * list structure that extractRawText would lose. The HTML is parsed into an inert, detached
 * document and walked; it is never put into the page, because mammoth does not sanitize (links
 * can carry javascript: URLs).
 *
 * Headers and footers, where some Word templates put contact details, are not among mammoth's
 * supported features, so contact details there are usually missing. That is fine for privacy;
 * the review screen should not claim it found them.
 */

/** The slice of a DOM node this walker reads (DOMParser in the browser, plain objects in tests). */
export interface NodeLike {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<NodeLike>;
  getAttribute?(name: string): string | null;
}

export interface MammothLike {
  convertToHtml(input: { arrayBuffer: ArrayBuffer }, options?: Record<string, unknown>): Promise<{ value: string; messages?: readonly unknown[] }>;
}

export interface DocxReaderDeps {
  /** Loads mammoth. Defaults to a dynamic import of "mammoth" (1.13.0). */
  loadMammoth?: () => Promise<MammothLike | null>;
  /** HTML to an inert tree. Defaults to globalThis.DOMParser when present. */
  parseHtml?: (html: string) => NodeLike | null;
}

const ELEMENT = 1;
const TEXT = 3;
const BLOCKS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "TD", "TH"]);
/** Heading levels as font sizes, so the parser's "larger than body" cue works for DOCX too. */
const HEADING_SIZE: Record<string, number> = { H1: 20, H2: 16, H3: 14, H4: 13, H5: 12, H6: 12 };
const BODY_SIZE = 11;

function kids(n: NodeLike): NodeLike[] {
  return Array.from(n.childNodes ?? []);
}

function hasBlockDescendant(n: NodeLike): boolean {
  return kids(n).some((c) => c.nodeType === ELEMENT && (BLOCKS.has(c.nodeName.toUpperCase()) || hasBlockDescendant(c)));
}

/** Characters of text inside <strong> or <b>, to decide whether a block is wholly bold. */
function boldChars(n: NodeLike, inside = false): number {
  if (n.nodeType === TEXT) return inside ? (n.textContent ?? "").replace(/\s/g, "").length : 0;
  const tag = n.nodeName.toUpperCase();
  const now = inside || tag === "STRONG" || tag === "B";
  return kids(n).reduce((sum, c) => sum + boldChars(c, now), 0);
}

function collectHrefs(n: NodeLike, out: string[]): void {
  if (n.nodeType !== ELEMENT) return;
  if (n.nodeName.toUpperCase() === "A") {
    const href = n.getAttribute?.("href");
    if (href) out.push(href);
  }
  for (const c of kids(n)) collectHrefs(c, out);
}

/**
 * One ResumeLine per block (paragraph, heading, list item, table cell). Tables come out cell by
 * cell, which suits the many table-based student templates; list items get a bullet so the
 * parser sees them as bullets; headings and wholly bold blocks are bold.
 */
export function docxTreeToLines(root: NodeLike | null): { lines: ResumeLine[]; links: string[] } {
  const lines: ResumeLine[] = [];
  const hrefs: string[] = [];
  const visit = (n: NodeLike): void => {
    if (n.nodeType !== ELEMENT) return;
    const tag = n.nodeName.toUpperCase();
    if (tag === "SCRIPT" || tag === "STYLE") return;
    if (BLOCKS.has(tag) && !hasBlockDescendant(n)) {
      const text = (n.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text) return;
      collectHrefs(n, hrefs);
      const heading = tag in HEADING_SIZE;
      const visible = text.replace(/\s/g, "").length;
      const bold = heading || (visible > 0 && boldChars(n) >= visible);
      lines.push({ text: tag === "LI" ? `• ${text}` : text, bold, fontSize: HEADING_SIZE[tag] ?? BODY_SIZE });
      return;
    }
    for (const c of kids(n)) visit(c);
  };
  if (root) visit(root);
  return { lines, links: safeLinks(hrefs) };
}

const MAMMOTH_SPECIFIER = "mammoth";

type DomParserCtor = new () => { parseFromString(html: string, type: string): { body: unknown } };

function defaultParseHtml(html: string): NodeLike | null {
  const Ctor = (globalThis as { DOMParser?: DomParserCtor }).DOMParser;
  if (!Ctor) return null;
  // DOMParser builds an inert document: no scripts run and nothing loads.
  return new Ctor().parseFromString(html, "text/html").body as NodeLike;
}

export function createDocxReader(deps: DocxReaderDeps = {}): ResumeFileReader {
  const load = deps.loadMammoth ?? (() => loadOptional<MammothLike>(MAMMOTH_SPECIFIER));
  const parseHtml = deps.parseHtml ?? defaultParseHtml;
  return {
    kind: "docx",
    async read(data, options: ReadOptions = {}): Promise<ReaderResult> {
      const mammoth = await load().catch(() => null);
      if (!mammoth) return { ok: false, code: "reader-unavailable" };
      try {
        const buffer = data instanceof Uint8Array ? (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer) : data;
        const result = await mammoth.convertToHtml(
          { arrayBuffer: buffer },
          {
            styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Heading 1'] => h2:fresh", "p[style-name='Heading 2'] => h3:fresh"],
            externalFileAccess: false,
          },
        );
        const root = parseHtml(result.value);
        if (!root) return { ok: false, code: "reader-unavailable" };
        const { lines, links } = docxTreeToLines(root);
        if (lines.length === 0) return { ok: false, code: "read-failed" };
        return {
          ok: true,
          source: "docx",
          lines,
          text: lines.map((l) => l.text).join("\n"),
          pages: 1,
          hints: { author: null, fileName: options.fileName ?? null, links },
          warnings: (result.messages ?? []).length > 0 ? ["formatting-skipped"] : [],
        };
      } catch {
        return { ok: false, code: "read-failed" };
      }
    },
  };
}
