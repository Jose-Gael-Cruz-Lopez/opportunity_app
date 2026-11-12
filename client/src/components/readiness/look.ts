/**
 * The two looks (Ember default, Meadow). The choice is a per-viewer convenience, so it lives in
 * localStorage under the same key the mockup used; every access is guarded because storage can
 * throw in private windows or with site data blocked, and the page must still render.
 */
export const LOOKS = ["ember", "meadow"] as const;
export type Look = (typeof LOOKS)[number];
export const LOOK_STORAGE_KEY = "novus-look";
export const DEFAULT_LOOK: Look = "ember";

export function parseLook(value: unknown): Look {
  return value === "meadow" ? "meadow" : DEFAULT_LOOK;
}

export function readStoredLook(storage: Pick<Storage, "getItem"> | undefined): Look {
  try {
    return parseLook(storage?.getItem(LOOK_STORAGE_KEY));
  } catch {
    return DEFAULT_LOOK;
  }
}

export function storeLook(storage: Pick<Storage, "setItem"> | undefined, look: Look): void {
  try {
    storage?.setItem(LOOK_STORAGE_KEY, look);
  } catch {
    // Storage unavailable: the look still applies for this page view.
  }
}
