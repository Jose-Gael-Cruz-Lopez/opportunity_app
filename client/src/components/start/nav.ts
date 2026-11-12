import { isStage, type Stage } from "./flow";

/**
 * Navigation helpers for the onboarding page: per-stage document titles, history entries so
 * the browser (and Android) back button steps back inside onboarding instead of leaving it,
 * and focus moves so screen-reader users hear each new screen. The DOM parts are thin and
 * guarded; the decisions are pure and tested (nav.test.ts).
 */

export const STAGE_TITLES: Record<Stage, string> = {
  welcome: "Get started · Novus",
  quiz: "A few questions · Novus",
  resume: "Your resume · Novus",
  matches: "Your matches · Novus",
  door: "Your first door · Novus",
  done: "You've started · Novus",
};

/** The key this page keeps in history.state; other keys (wouter's, the router's) are preserved. */
export const HISTORY_KEY = "novusStart";

/** The stage a history entry belongs to, or null for an entry this page did not make. */
export function stageFromHistoryState(state: unknown): Stage | null {
  if (!state || typeof state !== "object") return null;
  const value = (state as Record<string, unknown>)[HISTORY_KEY];
  return isStage(value) ? value : null;
}

/** history.state with this page's stage set, keeping whatever else is there. */
export function withStage(state: unknown, stage: Stage): Record<string, unknown> {
  const base = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
  return { ...base, [HISTORY_KEY]: stage };
}

/**
 * What a back step to `target` means. Going back to the quiz from a later screen reopens the
 * last answered question (its answer is taken back), because every question is answered and the
 * quiz would otherwise forward the student straight back to matches.
 */
export function backAction(from: Stage, target: Stage): "pop_answer" | "show" {
  const later = from === "resume" || from === "matches" || from === "door" || from === "done";
  return target === "quiz" && later ? "pop_answer" : "show";
}

/** Adds a history entry for a new stage. Never throws (sandboxed frames can refuse history). */
export function pushStage(stage: Stage): void {
  try {
    if (typeof window === "undefined" || !window.history) return;
    if (stageFromHistoryState(window.history.state) === stage) return;
    window.history.pushState(withStage(window.history.state, stage), "", window.location.href);
  } catch {
    /* history is a convenience; the in-page Back buttons still work */
  }
}

/** Marks the current history entry with the stage the page opened on. */
export function markStage(stage: Stage): void {
  try {
    if (typeof window === "undefined" || !window.history) return;
    window.history.replaceState(withStage(window.history.state, stage), "", window.location.href);
  } catch {
    /* see pushStage */
  }
}

/**
 * Moves focus to the first heading inside `root` (made focusable with tabIndex=-1), after the
 * new screen has rendered. The focused element of the old screen unmounts on every switch, so
 * without this focus falls to <body> and nothing is announced.
 */
export function focusFirstHeading(root: ParentNode | null | undefined, selector = "h1, h2, h3"): void {
  if (typeof window === "undefined" || !root) return;
  window.requestAnimationFrame(() => {
    const el = root.querySelector<HTMLElement>(selector);
    if (!el) return;
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
    el.focus({ preventScroll: true });
  });
}
