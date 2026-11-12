/**
 * In-memory store for SensitiveAnswers and confirmed attestations.
 *
 * Privacy rules this file enforces by construction:
 * - Memory only. No localStorage, sessionStorage, IndexedDB, cookie or URL ever holds an answer,
 *   so a reload or a closed tab forgets everything.
 * - Nothing here imports a fetcher, analytics or logging module.
 * - Answers clear themselves after PRODUCT.sensitiveIdleClearMinutes without a change, so a
 *   shared or library computer does not keep them on screen.
 *
 * It is a module-level store (not a React provider) so the answers follow the student from the
 * Program page to the Readiness view within one tab without the app shell wiring anything.
 */
import { useSyncExternalStore } from "react";
import { PRODUCT } from "@shared/config/product";
import type { EligibilityFieldKey } from "@shared/contracts/eligibility";
import type { SensitiveAnswers } from "@shared/contracts/sensitive";
import { withAnswer } from "./private-eligibility";

/**
 * Confirmations are scoped to one program cycle, because rule ids such as "standing" repeat
 * across programs while a citizenship answer does not change between them.
 */
export function confirmationKey(scope: string, id: string): string {
  return `${scope}:${id}`;
}

/** The confirmed ids for one scope, without the scope prefix. */
export function confirmationsFor(confirmed: ReadonlySet<string>, scope: string): Set<string> {
  const prefix = `${scope}:`;
  return new Set([...confirmed].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)));
}

export interface PrivateAnswersSnapshot {
  readonly answers: SensitiveAnswers;
  readonly confirmed: ReadonlySet<string>;
}

type Timer = ReturnType<typeof setTimeout>;

export interface PrivateAnswersStore {
  getSnapshot(): PrivateAnswersSnapshot;
  subscribe(listener: () => void): () => void;
  setAnswer(field: EligibilityFieldKey, value: string | string[] | undefined): void;
  setConfirmed(id: string, confirmed: boolean): void;
  clear(): void;
}

const EMPTY: PrivateAnswersSnapshot = { answers: {}, confirmed: new Set() };

/** Creates a store; tests pass their own timer functions. */
export function createPrivateAnswersStore(
  idleMs: number = PRODUCT.sensitiveIdleClearMinutes * 60_000,
  timers: { set: (fn: () => void, ms: number) => Timer; clear: (t: Timer) => void } = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) },
): PrivateAnswersStore {
  let state: PrivateAnswersSnapshot = EMPTY;
  let idle: Timer | null = null;
  const listeners = new Set<() => void>();

  const emit = () => listeners.forEach((l) => l());
  const armIdleClear = () => {
    if (idle !== null) timers.clear(idle);
    idle = timers.set(() => {
      idle = null;
      state = EMPTY;
      emit();
    }, idleMs);
  };
  const update = (next: PrivateAnswersSnapshot) => {
    state = next;
    armIdleClear();
    emit();
  };

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setAnswer(field, value) {
      update({ ...state, answers: withAnswer(state.answers, field, value) });
    },
    setConfirmed(id, confirmed) {
      const next = new Set(state.confirmed);
      if (confirmed) next.add(id);
      else next.delete(id);
      update({ ...state, confirmed: next });
    },
    clear() {
      if (idle !== null) timers.clear(idle);
      idle = null;
      state = EMPTY;
      emit();
    },
  };
}

/** The one store for this tab. */
export const privateAnswers = createPrivateAnswersStore();

/**
 * Settings dispatches this window event from "Clear my private answers" and "Reset this device"
 * (pages/settings/model.ts holds the same name). The store outlives page changes within the tab,
 * so it must listen rather than rely on unmounting.
 */
export const CLEAR_PRIVATE_ANSWERS_EVENT = "novus:clear-sensitive-answers";

export function listenForClearRequests(store: Pick<PrivateAnswersStore, "clear">, target: Pick<EventTarget, "addEventListener" | "removeEventListener">): () => void {
  const onClear = () => store.clear();
  target.addEventListener(CLEAR_PRIVATE_ANSWERS_EVENT, onClear);
  return () => target.removeEventListener(CLEAR_PRIVATE_ANSWERS_EVENT, onClear);
}

if (typeof window !== "undefined") listenForClearRequests(privateAnswers, window);

export function usePrivateAnswers(): PrivateAnswersSnapshot & Pick<PrivateAnswersStore, "setAnswer" | "setConfirmed" | "clear"> {
  const snap = useSyncExternalStore(privateAnswers.subscribe, privateAnswers.getSnapshot, privateAnswers.getSnapshot);
  return { ...snap, setAnswer: privateAnswers.setAnswer, setConfirmed: privateAnswers.setConfirmed, clear: privateAnswers.clear };
}
