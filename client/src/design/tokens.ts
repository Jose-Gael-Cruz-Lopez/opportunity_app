/**
 * Design tokens for the two app looks, Ember (default) and Meadow, ported from the Novus app
 * mockup. index.css holds the same values as CSS custom properties on `:root` (Ember) and
 * `:root[data-look="meadow"]`; tokens.test.ts checks that the two stay in sync and that every
 * text token passes WCAG contrast on every solid surface it may sit on.
 *
 * Colours are warm, never pure: ivory text instead of #FFF and a warm near-black ground instead
 * of #000, which is what keeps the look from reading as generic dark mode.
 */

export const LOOKS = ["ember", "meadow"] as const;
export type Look = (typeof LOOKS)[number];
export const DEFAULT_LOOK: Look = "ember";

export const LOOK_LABELS: Record<Look, string> = {
  ember: "Ember",
  meadow: "Meadow",
};

/** A colour as hex plus an optional alpha, so contrast can be computed after blending. */
export interface TokenColor {
  readonly hex: string;
  readonly alpha?: number;
}

export interface LookPalette {
  /** Page ground behind everything. */
  readonly night: TokenColor;
  /** Solid card fill, used whenever glass is off (the default on low-end devices). */
  readonly surface: TokenColor;
  /** Solid fill for the rail, tab bar and sheets. */
  readonly surfaceStrong: TokenColor;
  /** Body text and headings. */
  readonly ink: TokenColor;
  /** Secondary text. */
  readonly ink2: TokenColor;
  /** Labels and metadata. */
  readonly ink3: TokenColor;
  /** Text on cream buttons and pressed chips. */
  readonly inkDark: TokenColor;
  readonly cream: TokenColor;
  readonly wheat: TokenColor;
  /** Accent for icons and the switch track. */
  readonly leaf: TokenColor;
  /** Positive status text ("Likely eligible", "Open"). */
  readonly good: TokenColor;
  /** Caution status text ("Check privately", "Closes soon"). */
  readonly warn: TokenColor;
  /** Done marks and the checked ring. */
  readonly done: TokenColor;
  /** Focus ring: sand on dark, readable on every ground. */
  readonly focus: TokenColor;
}

export const PALETTES: Record<Look, LookPalette> = {
  ember: {
    night: { hex: "#0D0A08" },
    surface: { hex: "#24170F" },
    surfaceStrong: { hex: "#1A110B" },
    ink: { hex: "#FFF6EA" },
    ink2: { hex: "#FFF6EA", alpha: 0.82 },
    ink3: { hex: "#FFF6EA", alpha: 0.66 },
    inkDark: { hex: "#1D1C15" },
    cream: { hex: "#FFF4E4" },
    wheat: { hex: "#F7D9A6" },
    leaf: { hex: "#F3B26A" },
    good: { hex: "#D3E5B6" },
    warn: { hex: "#F6B36C" },
    done: { hex: "#AECBD0" },
    focus: { hex: "#F8E0B0" },
  },
  meadow: {
    night: { hex: "#15180F" },
    surface: { hex: "#262B1A" },
    surfaceStrong: { hex: "#1C2013" },
    ink: { hex: "#FBF7EA" },
    ink2: { hex: "#FBF7EA", alpha: 0.82 },
    ink3: { hex: "#FBF7EA", alpha: 0.66 },
    inkDark: { hex: "#1D1C15" },
    cream: { hex: "#FBF7EA" },
    wheat: { hex: "#E6D3A6" },
    leaf: { hex: "#A9D37A" },
    good: { hex: "#C3E6A0" },
    warn: { hex: "#F2D08A" },
    done: { hex: "#DCCBFB" },
    focus: { hex: "#F3F1DA" },
  },
};

/** CSS custom property for each palette key (index.css uses these names). */
export const CSS_VAR: Record<keyof LookPalette, string> = {
  night: "--nv-night",
  surface: "--nv-surface",
  surfaceStrong: "--nv-surface-strong",
  ink: "--nv-ink",
  ink2: "--nv-ink-2",
  ink3: "--nv-ink-3",
  inkDark: "--nv-ink-dark",
  cream: "--nv-cream",
  wheat: "--nv-wheat",
  leaf: "--nv-leaf",
  good: "--nv-good",
  warn: "--nv-warn",
  done: "--nv-done",
  focus: "--nv-focus",
};

/** Easing and duration tokens. Interface motion stays at or under 200 ms (plan s01 4). */
export const MOTION = {
  easeOut: "cubic-bezier(.22,1,.36,1)",
  fastMs: 120,
  baseMs: 200,
} as const;

/** Type families; Doto is display-only (32 px and up) and always duplicated in plain text. */
export const FONTS = {
  sans: '"Urbanist", "Avenir Next", "Segoe UI", system-ui, sans-serif',
  mono: '"DM Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  dot: '"Doto", "DM Mono", ui-monospace, monospace',
} as const;

/**
 * Text/surface pairs that must pass WCAG AA (4.5:1 for body text, 3:1 for large text and
 * focus indicators). tokens.test.ts walks this list for every look.
 */
export const CONTRAST_PAIRS: readonly {
  readonly fg: keyof LookPalette;
  readonly bg: keyof LookPalette;
  readonly min: number;
}[] = [
  { fg: "ink", bg: "night", min: 4.5 },
  { fg: "ink", bg: "surface", min: 4.5 },
  { fg: "ink", bg: "surfaceStrong", min: 4.5 },
  { fg: "ink2", bg: "surface", min: 4.5 },
  { fg: "ink2", bg: "surfaceStrong", min: 4.5 },
  { fg: "ink3", bg: "surface", min: 4.5 },
  { fg: "ink3", bg: "surfaceStrong", min: 4.5 },
  { fg: "ink3", bg: "night", min: 4.5 },
  { fg: "good", bg: "surface", min: 4.5 },
  { fg: "warn", bg: "surface", min: 4.5 },
  { fg: "leaf", bg: "surface", min: 3 },
  { fg: "inkDark", bg: "cream", min: 4.5 },
  { fg: "inkDark", bg: "wheat", min: 4.5 },
  { fg: "focus", bg: "night", min: 3 },
  { fg: "focus", bg: "surface", min: 3 },
];
