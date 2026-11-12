import { DEFAULT_LOOK, LOOKS, type Look } from "./tokens";

/**
 * The look (Ember or Meadow) is a per-device preference: it lives in localStorage and is
 * written to `data-look` on <html>, where index.css swaps the token values. Storage can be
 * missing or throw (private windows, blocked site data), so every access is guarded and the
 * default look still renders.
 */

export const LOOK_STORAGE_KEY = "novus-look";
export const SOLID_STORAGE_KEY = "novus-solid-surfaces";

export function parseLook(value: unknown): Look {
  return typeof value === "string" && (LOOKS as readonly string[]).includes(value) ? (value as Look) : DEFAULT_LOOK;
}

/** Minimal storage surface so tests can pass a fake. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStore(): KeyValueStore | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readStoredLook(store: KeyValueStore | null = browserStore()): Look {
  try {
    return parseLook(store?.getItem(LOOK_STORAGE_KEY));
  } catch {
    return DEFAULT_LOOK;
  }
}

export function storeLook(look: Look, store: KeyValueStore | null = browserStore()): void {
  try {
    store?.setItem(LOOK_STORAGE_KEY, look);
  } catch {
    // A blocked store only means the choice is not remembered next visit.
  }
}

export function readSolidPreference(store: KeyValueStore | null = browserStore()): boolean {
  try {
    return store?.getItem(SOLID_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function storeSolidPreference(solid: boolean, store: KeyValueStore | null = browserStore()): void {
  try {
    store?.setItem(SOLID_STORAGE_KEY, solid ? "1" : "0");
  } catch {
    // Not remembered; the current session still applies it.
  }
}

/** Writes the look to the root element; Ember is also the CSS default, so a missing attribute is safe. */
export function applyLook(look: Look, root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null): void {
  root?.setAttribute("data-look", look);
}
