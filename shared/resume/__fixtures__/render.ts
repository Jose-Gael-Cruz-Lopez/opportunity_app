import type { ResumeLine } from "../types";

/**
 * SAMPLE data helpers. Renders test resumes into the positioned fragments a PDF reader emits
 * (pdf.js TextItems reduced to ResumeLine), so layout, columns and glyph merging are tested
 * without a PDF library. Widths use a Helvetica-like average of half an em per character.
 */

export interface RowSpec {
  text: string;
  /** Left edge; defaults to the column's x. */
  x?: number;
  size?: number;
  bold?: boolean;
  /** Right-aligned text on the same baseline (dates, places). */
  right?: string;
  rightBold?: boolean;
  /** Vertical distance from the previous row; defaults to the leading. */
  gap?: number;
  /** A bullet glyph drawn as its own item, with the text indented after it. */
  bullet?: string;
}

export interface RenderOptions {
  x: number;
  top: number;
  page?: number;
  leading?: number;
  rightEdge?: number;
  /** Emit one item per glyph with no space items, as Canva-style exports do. */
  glyphs?: boolean;
}

const EM = 0.5;
const BOLD_EM = 0.55;

export function textWidth(text: string, size: number, bold = false): number {
  return text.length * size * (bold ? BOLD_EM : EM);
}

function fragments(text: string, x: number, y: number, size: number, bold: boolean, page: number, glyphs: boolean): ResumeLine[] {
  if (!glyphs) return [{ text, x, y, width: textWidth(text, size, bold), fontSize: size, bold, page }];
  // Per-glyph items; a word gap of 0.3 em and no space items, so merging must infer spaces.
  const out: ResumeLine[] = [];
  const advance = size * (bold ? BOLD_EM : EM);
  let cx = x;
  for (const ch of text) {
    if (ch === " ") {
      cx += 0.3 * size;
      continue;
    }
    out.push({ text: ch, x: cx, y, width: advance, fontSize: size, bold, page });
    cx += advance;
  }
  return out;
}

export function renderColumn(rows: readonly RowSpec[], opts: RenderOptions): ResumeLine[] {
  const leading = opts.leading ?? 13;
  const page = opts.page ?? 1;
  const rightEdge = opts.rightEdge ?? 576;
  const out: ResumeLine[] = [];
  let y = opts.top;
  rows.forEach((row, i) => {
    if (i > 0) y -= row.gap ?? leading;
    const size = row.size ?? 10;
    const bold = row.bold ?? false;
    let x = row.x ?? opts.x;
    if (row.bullet) {
      out.push(...fragments(row.bullet, x, y, size, false, page, false));
      x += 10;
    }
    out.push(...fragments(row.text, x, y, size, bold, page, opts.glyphs ?? false));
    if (row.right) {
      const w = textWidth(row.right, size, row.rightBold ?? false);
      out.push(...fragments(row.right, rightEdge - w, y, size, row.rightBold ?? false, page, opts.glyphs ?? false));
    }
  });
  return out;
}

/** Plain text a reader would also hand over: fragments joined per baseline, top to bottom. */
export function plainText(lines: readonly ResumeLine[]): string {
  const rows = new Map<string, ResumeLine[]>();
  for (const l of lines) {
    const key = `${l.page ?? 1}:${Math.round(l.y ?? 0)}`;
    const row = rows.get(key) ?? [];
    row.push(l);
    rows.set(key, row);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => {
      const [pa, ya] = a.split(":").map(Number) as [number, number];
      const [pb, yb] = b.split(":").map(Number) as [number, number];
      return pa - pb || yb - ya;
    })
    .map(([, row]) => row.sort((a, b) => (a.x ?? 0) - (b.x ?? 0)).map((l) => l.text).join(" "))
    .join("\n");
}
