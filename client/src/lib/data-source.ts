import { useSyncExternalStore } from "react";
import { isApiError } from "./api";

/**
 * Where screen data comes from while the Worker API is still being built.
 *
 * - live: always the API; errors surface as errors.
 * - fixtures: always the labelled sample data (demos, screenshots).
 * - auto: the API, falling back to sample data only when nothing that speaks the JSON API
 *   answered (offline dev server, a route not mounted yet). Real API answers, including 401
 *   and 404 problem responses, are never replaced by samples.
 *
 * The mode is VITE_NOVUS_DATA when set; otherwise `auto` in development and `live` in a
 * production build, so a deployed app never swaps in invented records because the student is
 * offline. `?sample=1` on any /app URL forces fixtures for that page load (demos).
 *
 * Whenever sample data is on screen the page and the shell show a "Sample data" label (rule 7).
 */

export type DataMode = "live" | "fixtures" | "auto";
export type DataSource = "live" | "sample";

export interface Sourced<T> {
  readonly data: T;
  readonly source: DataSource;
}

export function parseDataMode(raw: unknown): DataMode {
  return raw === "live" || raw === "fixtures" ? raw : "auto";
}

/** Pure resolution of the mode, so the rule is testable without a browser. */
export function resolveDataMode(input: { envValue: unknown; isDev: boolean; search: string }): DataMode {
  if (new URLSearchParams(input.search).get("sample") === "1") return "fixtures";
  if (input.envValue === "live" || input.envValue === "fixtures" || input.envValue === "auto") return input.envValue;
  return input.isDev ? "auto" : "live";
}

function envMode(): DataMode {
  try {
    return resolveDataMode({
      envValue: import.meta.env?.VITE_NOVUS_DATA,
      isDev: Boolean(import.meta.env?.DEV),
      search: typeof window === "undefined" ? "" : window.location.search,
    });
  } catch {
    return "auto";
  }
}

export const DATA_MODE: DataMode = envMode();

/** True when an error means "the API is not there", as opposed to "the API said no". */
export function isApiMissing(err: unknown): boolean {
  return isApiError(err) && (err.kind === "not_api" || err.kind === "network");
}

export async function liveOrSample<T>(live: () => Promise<T>, sample: () => T, mode: DataMode = DATA_MODE): Promise<Sourced<T>> {
  if (mode === "fixtures") {
    markSample();
    return { data: sample(), source: "sample" };
  }
  try {
    return { data: await live(), source: "live" };
  } catch (err) {
    if (mode === "auto" && isApiMissing(err)) {
      markSample();
      return { data: sample(), source: "sample" };
    }
    throw err;
  }
}

// ---- "Sample data is on screen" signal for the shell -------------------------------------------

let sampleShown = false;
const listeners = new Set<() => void>();

function markSample(): void {
  if (sampleShown) return;
  sampleShown = true;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Becomes true once any screen has rendered sample data in this session. */
export function useSampleDataShown(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => sampleShown,
    () => false,
  );
}
