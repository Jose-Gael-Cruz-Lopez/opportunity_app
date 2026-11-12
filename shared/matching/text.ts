import { addDays, daysBetween, parseIsoDate } from "../time";

/**
 * Small pure helpers: text normalization for search, the weekly rotation hash and short date copy.
 */

const STOP_WORDS: ReadonlySet<string> = new Set(["a", "an", "the", "of", "for", "and", "in", "on", "to", "at", "with", "or", "by"]);

/** Lower-cases and strips diacritics so "Fulbright" and "fülbright" index alike. */
export function foldText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
}

/**
 * MiniSearch `processTerm`: folds the term and drops stop words (returning null removes it).
 * The same function runs at index and query time so both sides agree.
 */
export function processTerm(term: string): string | null {
  const folded = foldText(term).replace(/[’']/g, "");
  if (!folded || STOP_WORDS.has(folded)) return null;
  return folded;
}

/** Splits on whitespace and punctuation, the same way MiniSearch's default tokenizer does. */
export function tokenize(value: string): string[] {
  return value
    .split(/[\n\r\p{Z}\p{P}]+/u)
    .map((t) => processTerm(t))
    .filter((t): t is string => t !== null);
}

/**
 * FNV-1a, 32-bit, over UTF-16 code units. Used for the published weekly tie-break: cheap,
 * deterministic in the browser and the Worker, and not cryptographic (nothing depends on that).
 */
export function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** ISO weekday, Monday 1 to Sunday 7. 1970-01-01 was a Thursday. */
function isoWeekdayOf(isoDate: string): number {
  const days = daysBetween("1970-01-01", isoDate);
  return ((((days + 3) % 7) + 7) % 7) + 1;
}

/** ISO 8601 week key such as "2026-W46" for a `YYYY-MM-DD` date. */
export function isoWeekKey(isoDate: string): string {
  if (!parseIsoDate(isoDate)) throw new RangeError(`invalid ISO date: ${isoDate}`);
  const thursday = addDays(isoDate, 4 - isoWeekdayOf(isoDate));
  const year = Number(thursday.slice(0, 4));
  const week = Math.floor(daysBetween(`${thursday.slice(0, 4)}-01-01`, thursday) / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** MurmurHash3's 32-bit finalizer: spreads every input bit over the output. */
export function fmix32(h: number): number {
  let x = h >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Rotating tie-break: stable for a week, different across weeks, independent of the alphabet.
 * Published form: fmix32(fnv1a32(isoWeek + "|" + slug)). The week goes first and the finalizer
 * runs last because plain FNV-1a barely reorders keys when only the final character changes
 * ("W46" to "W47"), which would leave the weekly order almost unchanged.
 */
export function rotationKey(slug: string, isoWeek: string): number {
  return fmix32(fnv1a32(`${isoWeek}|${slug}`));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** "Dec 23" for `2026-12-23`; the input is returned unchanged when it is not a full date. */
export function shortDate(isoDate: string): string {
  const d = parseIsoDate(isoDate);
  if (!d) return isoDate;
  return `${MONTHS[d.month - 1]} ${d.day}`;
}

/** Joins labels as "a", "a and b" or "a, b and c". */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
