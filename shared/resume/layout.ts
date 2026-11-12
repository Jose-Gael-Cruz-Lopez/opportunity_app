import { findDates, type ResumeNow } from "./dates";
import { locationRegex } from "./lexicon/places";
import { median, normalizeText } from "./text";
import type { ResumeLine } from "./types";

/**
 * Turns reader output into logical lines in reading order.
 *
 * Positioned input (pdf.js items, or lines a reader already grouped) follows the approach the
 * OpenResume parser documents publicly: sort by page, then top to bottom, then left to right;
 * put items whose baselines are within half a font size on one line; merge neighbours closer
 * than the average character width. This is original code written from that description
 * (OpenResume's source is AGPL-3.0 and was not used). OpenResume reads single-column resumes
 * only, so a gutter check is added for two-column templates.
 *
 * Unpositioned input (DOCX lines, pasted text) keeps its order.
 */

export interface LogicalLine {
  index: number;
  /** Text in reading order. Segments that sat far apart on the page are joined with a tab. */
  text: string;
  page: number;
  x: number | null;
  y: number | null;
  fontSize: number | null;
  bold: boolean;
  /** Vertical distance to the previous line of the same column and page, in points. */
  gapBefore: number | null;
  /** Pasted text and DOCX: a blank line came right before this one. */
  blankBefore: boolean;
  /** Pasted text: the next line was "-----" or "=====". */
  underlined: boolean;
  /** Pasted text: the line started with "#" (Markdown). */
  markdownHeading: boolean;
  /** Leading spaces in pasted text (tabs count as four). */
  indent: number;
  /** 1 for the right column of a two-column page, else 0. */
  column: 0 | 1;
}

export interface LayoutResult {
  lines: LogicalLine[];
  positional: boolean;
  twoColumn: boolean;
  /** Median font size of body text, when sizes are known. */
  bodyFontSize: number | null;
  truncated: boolean;
}

/** Bounds that keep parsing fast on a phone; a resume is one or two pages. */
export const MAX_INPUT_CHARS = 60_000;
export const MAX_INPUT_LINES = 4_000;

/** Average character width as a share of the font size, for fragments without a width. */
const CHAR_WIDTH_EM = 0.5;

interface Frag {
  text: string;
  x: number;
  y: number;
  w: number | null;
  size: number;
  bold: boolean;
  page: number;
}

interface Seg {
  text: string;
  x: number;
  xEnd: number;
  size: number;
  bold: boolean;
  measured: boolean;
}

interface Row {
  y: number;
  page: number;
  segs: Seg[];
}

type PartialLine = Omit<LogicalLine, "index" | "gapBefore">;

export function layoutLines(input: { text: string; lines?: readonly ResumeLine[] }, now: ResumeNow): LayoutResult {
  const source = input.lines && input.lines.length > 0 ? input.lines : null;
  if (source && isPositional(source)) return finish(positionalLayout(source, now), true);
  if (source) return finish(sequentialLayout(source), false);
  return finish(sequentialLayout(input.text.split("\n").map((text) => ({ text }))), false);
}

function isPositional(lines: readonly ResumeLine[]): boolean {
  const placed = lines.filter((l) => Number.isFinite(l.x) && Number.isFinite(l.y)).length;
  return placed > 0 && placed >= 0.8 * lines.length;
}

function finish(result: { lines: PartialLine[]; twoColumn: boolean }, positional: boolean): LayoutResult {
  let truncated = false;
  let chars = 0;
  const kept: PartialLine[] = [];
  for (const line of result.lines) {
    chars += line.text.length + 1;
    if (kept.length >= MAX_INPUT_LINES || chars > MAX_INPUT_CHARS) {
      truncated = true;
      break;
    }
    kept.push(line);
  }
  const lines: LogicalLine[] = kept.map((l, index) => ({ ...l, index, gapBefore: null }));
  for (let i = 1; i < lines.length; i++) {
    const cur = lines[i] as LogicalLine;
    for (let j = i - 1; j >= 0; j--) {
      const prev = lines[j] as LogicalLine;
      if (prev.page !== cur.page) break;
      if (prev.column !== cur.column) continue;
      if (prev.y !== null && cur.y !== null && prev.y > cur.y) cur.gapBefore = prev.y - cur.y;
      break;
    }
  }
  const sized = lines.filter((l) => l.fontSize !== null && l.text.length >= 12).map((l) => l.fontSize as number);
  const bodyFontSize = median(sized.length > 0 ? sized : lines.filter((l) => l.fontSize !== null).map((l) => l.fontSize as number));
  return { lines, positional, twoColumn: result.twoColumn, bodyFontSize, truncated };
}

// -------------------------------------------------------------------------------------------
// Unpositioned input
// -------------------------------------------------------------------------------------------

const UNDERLINE = /^\s*[-=_~*]{3,}\s*$/;
const MARKDOWN_HEADING = /^\s{0,3}#{1,6}\s+/;
const MARKDOWN_BOLD = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*(:?)\s*$/;
const MARKDOWN_INLINE = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g;

function sequentialLayout(lines: ReadonlyArray<Pick<ResumeLine, "text" | "bold" | "fontSize">>): { lines: PartialLine[]; twoColumn: boolean } {
  const out: PartialLine[] = [];
  let blank = false;
  for (const source of lines) {
    for (const raw of normalizeText(source.text).split("\n")) {
      if (raw.trim() === "") {
        blank = true;
        continue;
      }
      if (UNDERLINE.test(raw)) {
        const prev = out[out.length - 1];
        if (prev && !blank) prev.underlined = true;
        continue;
      }
      let text = raw.replace(/\s+$/, "");
      let bold = source.bold ?? false;
      let markdownHeading = false;
      if (MARKDOWN_HEADING.test(text)) {
        markdownHeading = true;
        text = text.replace(MARKDOWN_HEADING, "");
      }
      const md = MARKDOWN_BOLD.exec(text);
      if (md && md[1]) {
        bold = true;
        text = md[1] + (md[2] ?? "");
      }
      // Inline emphasis ("**Marketing Intern**, Credit Union") carries no meaning once read.
      text = text.replace(MARKDOWN_INLINE, "$2");
      const leading = /^[ \t]*/.exec(text)?.[0] ?? "";
      const indent = leading.replace(/\t/g, "    ").length;
      out.push({
        text: text.trim(),
        page: 1,
        x: null,
        y: null,
        fontSize: Number.isFinite(source.fontSize) ? (source.fontSize as number) : null,
        bold,
        blankBefore: blank,
        underlined: false,
        markdownHeading,
        indent,
        column: 0,
      });
      blank = false;
    }
  }
  return { lines: out, twoColumn: false };
}

// -------------------------------------------------------------------------------------------
// Positioned input
// -------------------------------------------------------------------------------------------

function positionalLayout(lines: readonly ResumeLine[], now: ResumeNow): { lines: PartialLine[]; twoColumn: boolean } {
  const sizes = lines.map((l) => l.fontSize).filter((s): s is number => Number.isFinite(s) && (s as number) > 0);
  const defaultSize = median(sizes) ?? 10;
  const frags: Frag[] = [];
  for (const l of lines) {
    if (!Number.isFinite(l.x) || !Number.isFinite(l.y)) continue;
    const text = normalizeText(l.text).replace(/\n/g, " ");
    if (text.trim() === "") continue;
    frags.push({
      text,
      x: l.x as number,
      y: l.y as number,
      w: Number.isFinite(l.width) && (l.width as number) > 0 ? (l.width as number) : null,
      size: Number.isFinite(l.fontSize) && (l.fontSize as number) > 0 ? (l.fontSize as number) : defaultSize,
      bold: l.bold ?? false,
      page: Number.isFinite(l.page) ? (l.page as number) : 1,
    });
  }
  const pages = [...new Set(frags.map((f) => f.page))].sort((a, b) => a - b);
  const out: PartialLine[] = [];
  let twoColumn = false;
  for (const page of pages) {
    const pageFrags = frags.filter((f) => f.page === page);
    const rows = buildRows(pageFrags, averageCharWidth(pageFrags, defaultSize));
    const result = readingOrder(rows, now);
    twoColumn ||= result.twoColumn;
    out.push(...result.lines);
  }
  return { lines: out, twoColumn };
}

/**
 * Average character width over non-bold, non-empty fragments with a measured width (bold
 * glyphs are wider and would loosen the merge threshold), as OpenResume documents.
 */
export function averageCharWidth(frags: ReadonlyArray<{ text: string; w: number | null; bold: boolean }>, fallbackSize: number): number {
  let width = 0;
  let chars = 0;
  for (const pass of [false, true]) {
    for (const f of frags) {
      if (f.w === null || (!pass && f.bold)) continue;
      const n = f.text.length;
      if (n === 0) continue;
      width += f.w;
      chars += n;
    }
    if (chars > 0) return width / chars;
  }
  return CHAR_WIDTH_EM * fallbackSize;
}

function widthOf(f: Frag): number {
  return f.w ?? f.text.length * CHAR_WIDTH_EM * f.size;
}

/** Clusters fragments into rows by baseline, then merges each row into segments. */
function buildRows(frags: readonly Frag[], acw: number): Row[] {
  const sorted = [...frags].sort((a, b) => b.y - a.y || a.x - b.x);
  const groups: Frag[][] = [];
  let minSize = Infinity;
  let rowY = 0;
  for (const f of sorted) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(rowY - f.y) <= 0.5 * Math.min(minSize, f.size)) {
      g.push(f);
      minSize = Math.min(minSize, f.size);
      continue;
    }
    groups.push([f]);
    rowY = f.y;
    minSize = f.size;
  }
  return groups.map((g) => ({ y: g[0]!.y, page: g[0]!.page, segs: mergeRow(g, acw) }));
}

/**
 * Merges fragments of one row: a gap under the average character width joins them (with a
 * space when the gap is wider than a quarter of it), a wider gap that is still word-sized
 * joins them with a space, and a gap of several characters starts a new segment (a
 * right-aligned date, or the other column).
 */
function mergeRow(row: readonly Frag[], acw: number): Seg[] {
  const frags = [...row].sort((a, b) => a.x - b.x);
  const segs: Seg[] = [];
  let cur: Seg | null = null;
  for (const f of frags) {
    if (!cur) {
      cur = { text: f.text, x: f.x, xEnd: f.x + widthOf(f), size: f.size, bold: f.bold, measured: f.w !== null };
      continue;
    }
    const gap = f.x - cur.xEnd;
    const measured = cur.measured && f.w !== null;
    if (gap >= (measured ? 2.5 : 4) * acw) {
      segs.push(cur);
      cur = { text: f.text, x: f.x, xEnd: f.x + widthOf(f), size: f.size, bold: f.bold, measured: f.w !== null };
      continue;
    }
    const space = gap > 0.25 * acw && !/\s$/.test(cur.text) && !/^\s/.test(f.text);
    cur.text += (space ? " " : "") + f.text;
    cur.xEnd = Math.max(cur.xEnd, f.x + widthOf(f));
    cur.size = Math.max(cur.size, f.size);
    cur.bold = cur.bold && f.bold;
    cur.measured = measured;
  }
  if (cur) segs.push(cur);
  return segs.map((s) => ({ ...s, text: s.text.replace(/\s+/g, " ").trim() })).filter((s) => s.text.length > 0);
}

/**
 * True for text that is only a date, a place or a GPA: right-aligned metadata, which must not
 * count as evidence for a second column.
 */
export function isMetaText(text: string, now: ResumeNow): boolean {
  let rest = text;
  for (const d of findDates(text, now)) rest = rest.replace(d.text, " ");
  rest = rest.replace(locationRegex(), " ").replace(/\bGPA\b[^A-Za-z]*/gi, " ").replace(/\bpage\s+\d+(\s+of\s+\d+)?/gi, " ");
  return (rest.match(/\p{L}/gu)?.length ?? 0) < 2;
}

interface Gutter {
  x: number;
  tol: number;
  span: number;
}

/**
 * Finds the left edge of a right-hand column: an x position, between 20% and 80% of the text
 * width, where non-metadata segments start on at least 30% of rows (and at least 3), with
 * left-column text that ends before it on at least 3 rows.
 */
function findGutter(rows: readonly Row[], now: ResumeNow): Gutter | null {
  const segs = rows.flatMap((r) => r.segs);
  if (rows.length < 6 || segs.length === 0) return null;
  const left = Math.min(...segs.map((s) => s.x));
  const right = Math.max(...segs.map((s) => s.xEnd));
  const span = right - left;
  if (span <= 0) return null;
  const tol = 0.02 * span;
  const candidates: Array<{ x: number; row: number }> = [];
  rows.forEach((r, row) => {
    for (const s of r.segs) {
      const rel = (s.x - left) / span;
      if (rel >= 0.2 && rel <= 0.8 && !isMetaText(s.text, now)) candidates.push({ x: s.x, row });
    }
  });
  let best: { x: number; support: number } | null = null;
  for (const c of candidates) {
    const near = candidates.filter((o) => Math.abs(o.x - c.x) <= tol);
    const support = new Set(near.map((o) => o.row)).size;
    if (!best || support > best.support) best = { x: Math.min(...near.map((o) => o.x)), support };
  }
  if (!best || best.support < Math.max(3, Math.ceil(0.3 * rows.length))) return null;
  const gutter = best.x;
  const leftRows = rows.filter((r) => r.segs.some((s) => s.x < gutter - tol && s.xEnd <= gutter + (s.measured ? tol : 0.1 * span) && !isMetaText(s.text, now))).length;
  if (leftRows < 3) return null;
  return { x: gutter, tol, span };
}

function toLine(segs: readonly Seg[], row: Row, column: 0 | 1, now: ResumeNow): PartialLine {
  const content = segs.filter((s) => !isMetaText(s.text, now));
  const styled = content.length > 0 ? content : segs;
  return {
    text: segs.map((s) => s.text).join("\t"),
    page: row.page,
    x: segs[0]?.x ?? null,
    y: row.y,
    fontSize: Math.max(...segs.map((s) => s.size)),
    bold: styled.every((s) => s.bold),
    blankBefore: false,
    underlined: false,
    markdownHeading: false,
    indent: 0,
    column,
  };
}

/**
 * Emits rows in reading order. Without a gutter that is simply top to bottom. With one, rows
 * above the first two-column row (the name and contact header) stay full width, a row with
 * text crossing the gutter flushes both columns (a full-width heading), and otherwise the
 * left column is read before the right.
 */
function readingOrder(rows: readonly Row[], now: ResumeNow): { lines: PartialLine[]; twoColumn: boolean } {
  const gutter = findGutter(rows, now);
  if (!gutter) return { lines: rows.map((r) => toLine(r.segs, r, 0, now)), twoColumn: false };
  const out: PartialLine[] = [];
  const leftBuf: PartialLine[] = [];
  const rightBuf: PartialLine[] = [];
  const flush = (): void => {
    out.push(...leftBuf.splice(0), ...rightBuf.splice(0));
  };
  let started = false;
  for (const r of rows) {
    const leftSegs = r.segs.filter((s) => s.x < gutter.x - gutter.tol);
    const rightSegs = r.segs.filter((s) => s.x >= gutter.x - gutter.tol);
    const atGutter = rightSegs.some((s) => Math.abs(s.x - gutter.x) <= gutter.tol);
    if (!started && !(atGutter || (leftSegs.length > 0 && rightSegs.length > 0))) {
      out.push(toLine(r.segs, r, 0, now));
      continue;
    }
    started = true;
    const crossing = leftSegs.some((s) => s.xEnd > gutter.x + (s.measured ? gutter.tol : 0.1 * gutter.span));
    if (crossing) {
      flush();
      out.push(toLine(r.segs, r, 0, now));
      continue;
    }
    if (leftSegs.length > 0) leftBuf.push(toLine(leftSegs, r, 0, now));
    if (rightSegs.length > 0) rightBuf.push(toLine(rightSegs, r, 1, now));
  }
  flush();
  return { lines: out, twoColumn: true };
}
