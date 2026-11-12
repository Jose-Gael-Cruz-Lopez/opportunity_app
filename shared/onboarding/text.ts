/**
 * Small text helpers shared by the quiz, skill detection and matching. Everything works on
 * plain strings so the browser and the Worker agree; nothing here touches the network.
 */

/**
 * Lowercases, strips accents and turns punctuation into spaces, keeping `+` and `#` so that
 * "C++" and "C#" survive. The result is padded with one space on each side, which lets
 * `hasPhrase` test whole words with a plain `includes`.
 */
export function normalizeForMatch(text: string): string {
  const folded = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
  return folded.length === 0 ? " " : ` ${folded} `;
}

/** True when `phrase` occurs in `normalizedText` as whole words (both normalized first). */
export function hasPhrase(normalizedText: string, phrase: string): boolean {
  const p = normalizeForMatch(phrase);
  return p.trim().length > 0 && normalizedText.includes(p);
}

/** Collapses whitespace, removes control characters and caps the length. */
export function cleanShortText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

/**
 * Patterns that mean a short answer carries contact details or an identifier: an email,
 * a URL or handle, or a run of five or more digits (phone, student or ID numbers).
 * Short answers that match are dropped instead of kept, because they are never needed for
 * matching and must not travel anywhere.
 */
const CONTACT_PATTERNS: readonly RegExp[] = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /\bhttps?:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9-]+\.(?:com|org|net|edu|io|me|dev|gov|co)\b/i,
  /(?:\d[\s().-]*){5,}/,
  /(?:^|\s)@[a-z0-9_]{2,}/i,
];

export function looksLikeContactDetail(value: string): boolean {
  return CONTACT_PATTERNS.some((re) => re.test(value));
}

/** Joins labels as "A", "A and B" or "A, B and C". */
export function joinLabels(labels: readonly string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0] as string;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** "1 letter" / "2 letters". */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Deterministic string comparison (code-unit order), independent of the runtime's locale. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
