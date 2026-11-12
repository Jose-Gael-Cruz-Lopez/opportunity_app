import type { QuestionView } from "./normalize";
import type { QuizAnswerValue } from "./storage";

/**
 * Small pure rules for the quiz screen: keyboard shortcuts, multi-select limits and whether
 * an answer is complete. Kept out of the component so they are unit-tested.
 */

/** "1".."9" pick an option; anything else is not a shortcut. */
export function keyToIndex(key: string): number | null {
  return /^[1-9]$/.test(key) ? Number(key) - 1 : null;
}

/**
 * Roving focus in an option list: the index arrow keys, Home and End move to (wrapping), or null
 * for any other key. Used only while focus is inside the list, never as a page-wide shortcut.
 */
export function arrowTarget(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  const from = current >= 0 && current < count ? current : 0;
  switch (key) {
    case "ArrowDown":
    case "ArrowRight":
      return (from + 1) % count;
    case "ArrowUp":
    case "ArrowLeft":
      return (from - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** The one option in a radio group that takes Tab: the chosen one, else the first. */
export function rovingTabStop(values: readonly string[], chosen: unknown): number {
  const i = typeof chosen === "string" ? values.indexOf(chosen) : -1;
  return i >= 0 ? i : 0;
}

/** Toggles a value in a multi-select, refusing to go past `max` (the oldest pick is kept). */
export function toggleMulti(selected: readonly string[], value: string, max?: number): string[] {
  if (selected.includes(value)) return selected.filter((v) => v !== value);
  if (max !== undefined && selected.length >= max) return [...selected];
  return [...selected, value];
}

/** A "not sure" style option clears the others; picking another option clears "not sure". */
export function toggleMultiExclusive(selected: readonly string[], value: string, exclusive: ReadonlySet<string>, max?: number): string[] {
  if (exclusive.has(value)) return selected.includes(value) ? [] : [value];
  return toggleMulti(selected.filter((v) => !exclusive.has(v)), value, max);
}

const EXCLUSIVE_PATTERN = /^(not_sure|none|none_yet|unsure|anytime|any)$/;

/** The quiz names its exclusive option; the pattern is a fallback for specs that do not. */
export function exclusiveValues(q: QuestionView): Set<string> {
  if (q.exclusive) return new Set([q.exclusive]);
  return new Set(q.options.map((o) => o.value).filter((v) => EXCLUSIVE_PATTERN.test(v)));
}

/** True when the draft answer can be submitted (skip is always possible separately). */
export function canContinue(q: QuestionView, draft: QuizAnswerValue | undefined): boolean {
  if (draft === undefined || draft === null) return false;
  if (q.kind === "multi") return Array.isArray(draft) && draft.length > 0;
  if (q.kind === "text") return typeof draft === "string" && draft.trim().length > 0;
  if (q.kind === "slider") return typeof draft === "number" && Number.isFinite(draft);
  return typeof draft === "string" || typeof draft === "number" || typeof draft === "boolean";
}

/** The starting draft for a question: an earlier answer, the resume prefill, or empty. */
export function initialDraft(q: QuestionView, previous: QuizAnswerValue | undefined): QuizAnswerValue | undefined {
  if (previous !== undefined && previous !== null) return previous;
  const p = q.prefill;
  if (q.kind === "multi") return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  if (typeof p === "string" || typeof p === "number") return p;
  if (q.kind === "slider" && q.slider) return q.slider.defaultValue;
  return undefined;
}
