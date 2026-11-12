import { useCallback, useState } from "react";
import {
  applyLook,
  readSolidPreference,
  readStoredLook,
  storeLook,
  storeSolidPreference,
  useLook,
  type Look,
} from "@/design";

/**
 * The shell's look and "Solid surfaces" preferences, for Settings and Onboarding. Inside the app
 * this is the shell's LookProvider. Outside it (tests, previews) it falls back to the shell's own
 * storage helpers, so the same keys are read and written either way.
 */
export interface LookPrefs {
  readonly look: Look;
  readonly setLook: (look: Look) => void;
  readonly solid: boolean;
  readonly setSolid: (solid: boolean) => void;
}

function useStandaloneLook(): LookPrefs {
  const [look, setLookState] = useState<Look>(() => readStoredLook());
  const [solid, setSolidState] = useState<boolean>(() => readSolidPreference());
  const setLook = useCallback((next: Look) => {
    storeLook(next);
    applyLook(next);
    setLookState(next);
  }, []);
  const setSolid = useCallback((next: boolean) => {
    storeSolidPreference(next);
    setSolidState(next);
  }, []);
  return { look, setLook, solid, setSolid };
}

export function useLookPrefs(): LookPrefs {
  // Both hooks run on every render so hook order never changes; the provider wins when present.
  const standalone = useStandaloneLook();
  try {
    const ctx = useLook();
    return { look: ctx.look, setLook: ctx.setLook, solid: ctx.solid, setSolid: ctx.setSolid };
  } catch {
    return standalone;
  }
}
