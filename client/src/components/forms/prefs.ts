import { useSyncExternalStore } from "react";

/**
 * Per-device preferences these pages own: the AI switch and an in-app "Reduce motion" switch.
 * The look (Ember or Meadow) and "Solid surfaces" belong to the shell (client/src/design); use
 * `useLookPrefs` from ./look for those. Everything here lives in localStorage because it describes
 * this browser, and nothing here is sensitive. Every storage access is wrapped: private windows
 * and blocked storage must still render with the defaults.
 */

export interface ClientPrefs {
  /** Stops decorative motion even when the OS setting is off. */
  readonly reduceMotion: boolean;
  /** When false the app never calls the AI endpoints from this device. */
  readonly aiAssistant: boolean;
}

export const DEFAULT_PREFS: ClientPrefs = {
  reduceMotion: false,
  aiAssistant: true,
};

export const PREFS_STORAGE_KEY = "novus-prefs-v1";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Parses stored JSON defensively: unknown keys are dropped, wrong types fall back to defaults. */
export function parsePrefs(raw: string | null): ClientPrefs {
  let data: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
    } catch {
      data = {};
    }
  }
  const bool = (key: keyof ClientPrefs): boolean => (typeof data[key] === "boolean" ? (data[key] as boolean) : DEFAULT_PREFS[key]);
  return { reduceMotion: bool("reduceMotion"), aiAssistant: bool("aiAssistant") };
}

export function serializePrefs(prefs: ClientPrefs): string {
  return JSON.stringify(prefs);
}

export function readPrefs(store: KeyValueStore | null): ClientPrefs {
  if (!store) return DEFAULT_PREFS;
  try {
    return parsePrefs(store.getItem(PREFS_STORAGE_KEY));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writePrefs(store: KeyValueStore | null, prefs: ClientPrefs): boolean {
  if (!store) return false;
  try {
    store.setItem(PREFS_STORAGE_KEY, serializePrefs(prefs));
    return true;
  } catch {
    return false;
  }
}

/** The root attributes these prefs control (null removes the attribute). */
export function rootAttributes(prefs: ClientPrefs): Record<"data-reduce-motion", string | null> {
  return { "data-reduce-motion": prefs.reduceMotion ? "" : null };
}

// ---------------------------------------------------------------------------------------------
// Browser store
// ---------------------------------------------------------------------------------------------

function browserStorage(): KeyValueStore | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

let current: ClientPrefs | null = null;
const listeners = new Set<() => void>();

function applyToRoot(prefs: ClientPrefs): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  for (const [name, value] of Object.entries(rootAttributes(prefs))) {
    if (value === null) root.removeAttribute(name);
    else root.setAttribute(name, value);
  }
}

export function getPrefs(): ClientPrefs {
  if (!current) {
    current = readPrefs(browserStorage());
    applyToRoot(current);
  }
  return current;
}

export function setPrefs(patch: Partial<ClientPrefs>): ClientPrefs {
  const next = { ...getPrefs(), ...patch };
  current = next;
  writePrefs(browserStorage(), next);
  applyToRoot(next);
  listeners.forEach((fn) => fn());
  return next;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** React binding: re-renders when any page changes a preference. */
export function usePrefs(): readonly [ClientPrefs, (patch: Partial<ClientPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribe, getPrefs, () => DEFAULT_PREFS);
  return [prefs, setPrefs] as const;
}
