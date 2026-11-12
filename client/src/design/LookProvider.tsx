import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { applyGlassGate, readGlassEnvironment, shouldUseGlass } from "./glass-gate";
import { applyLook, readSolidPreference, readStoredLook, storeLook, storeSolidPreference } from "./look";
import type { Look } from "./tokens";

interface LookContextValue {
  look: Look;
  setLook: (look: Look) => void;
  /** The student's "Solid surfaces" switch. */
  solid: boolean;
  setSolid: (solid: boolean) => void;
  /** Whether frosted glass is actually on after the device gate. */
  glass: boolean;
}

const LookContext = createContext<LookContextValue | null>(null);

/** Media queries that can flip the glass gate while the page is open. */
const GATE_QUERIES = ["(prefers-reduced-transparency: reduce)", "(prefers-contrast: more)", "(forced-colors: active)"];

export function LookProvider({ children }: { children: ReactNode }) {
  const [look, setLookState] = useState<Look>(() => readStoredLook());
  const [solid, setSolidState] = useState<boolean>(() => readSolidPreference());
  const [glass, setGlass] = useState(false);

  useEffect(() => {
    applyLook(look);
  }, [look]);

  useEffect(() => {
    const update = () => {
      const next = shouldUseGlass(readGlassEnvironment(solid));
      applyGlassGate(next);
      setGlass(next);
    };
    update();
    if (typeof matchMedia !== "function") return;
    const lists = GATE_QUERIES.map((q) => matchMedia(q));
    lists.forEach((l) => l.addEventListener?.("change", update));
    return () => lists.forEach((l) => l.removeEventListener?.("change", update));
  }, [solid]);

  const setLook = useCallback((next: Look) => {
    storeLook(next);
    setLookState(next);
  }, []);

  const setSolid = useCallback((next: boolean) => {
    storeSolidPreference(next);
    setSolidState(next);
  }, []);

  const value = useMemo(() => ({ look, setLook, solid, setSolid, glass }), [look, setLook, solid, setSolid, glass]);
  return <LookContext.Provider value={value}>{children}</LookContext.Provider>;
}

export function useLook(): LookContextValue {
  const ctx = useContext(LookContext);
  if (!ctx) throw new Error("useLook must be used inside <LookProvider>");
  return ctx;
}
