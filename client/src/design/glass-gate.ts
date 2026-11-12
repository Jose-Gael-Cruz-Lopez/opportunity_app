/**
 * Glass is a progressive enhancement. Surfaces are solid by default and become frosted glass
 * (`html[data-glass]`) only when the device can blur cheaply and the student has not asked for
 * less transparency, more contrast or less data. Legibility never depends on blur.
 *
 * `navigator.deviceMemory` and `connection.saveData` are Chromium-only; engines that report
 * nothing (all of WebKit and Firefox) count as capable, and Settings offers a solid switch.
 *
 * Release phase: the plan ships solid surfaces through Phase 2 and turns glass on in Phase 3
 * (decision D17), once backdrops, per-pixel contrast checks and device gating are in. Until
 * then GLASS_RELEASED stays false and every device gets solid surfaces; the capability check
 * below is kept ready so Phase 3 is a one-line change.
 */

/** Flip to true in Phase 3 (plan D17). */
export const GLASS_RELEASED = false;

export interface GlassEnvironment {
  readonly supportsBackdrop: boolean;
  readonly prefersReducedTransparency: boolean;
  readonly prefersMoreContrast: boolean;
  readonly forcedColors: boolean;
  readonly saveData: boolean | undefined;
  readonly deviceMemoryGb: number | undefined;
  /** The in-app "Solid surfaces" switch. */
  readonly solidPreferred: boolean;
  /** Whether this build ships glass at all (GLASS_RELEASED, plan D17). */
  readonly glassReleased: boolean;
}

export const MIN_GLASS_MEMORY_GB = 4;

export function shouldUseGlass(env: GlassEnvironment): boolean {
  if (!env.glassReleased) return false;
  if (!env.supportsBackdrop) return false;
  if (env.prefersReducedTransparency || env.prefersMoreContrast || env.forcedColors) return false;
  if (env.solidPreferred) return false;
  if (env.saveData === true) return false;
  return env.deviceMemoryGb === undefined || env.deviceMemoryGb >= MIN_GLASS_MEMORY_GB;
}

type NavHints = Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };

function media(query: string): boolean {
  try {
    return typeof matchMedia === "function" && matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Reads the live environment. Browser only. */
export function readGlassEnvironment(solidPreferred: boolean): GlassEnvironment {
  const supports = (rule: string) => typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports(rule);
  const nav = (typeof navigator !== "undefined" ? navigator : undefined) as NavHints | undefined;
  return {
    supportsBackdrop: supports("backdrop-filter: blur(1px)") || supports("-webkit-backdrop-filter: blur(1px)"),
    prefersReducedTransparency: media("(prefers-reduced-transparency: reduce)"),
    prefersMoreContrast: media("(prefers-contrast: more)"),
    forcedColors: media("(forced-colors: active)"),
    saveData: nav?.connection?.saveData,
    deviceMemoryGb: nav?.deviceMemory,
    solidPreferred,
    glassReleased: GLASS_RELEASED,
  };
}

export function applyGlassGate(useGlass: boolean, root: HTMLElement | null = typeof document !== "undefined" ? document.documentElement : null): void {
  if (!root) return;
  if (useGlass) root.setAttribute("data-glass", "");
  else root.removeAttribute("data-glass");
}
