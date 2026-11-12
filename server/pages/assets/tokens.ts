/**
 * Colour tokens for public pages, from the Dusk-to-Day landing design: near-black night, warm
 * taupe dusk, paper for reading. The CSS custom properties are generated from this object, and
 * tokens.test.ts checks every text/surface pair it lists against WCAG 2.2 contrast.
 */

export const PAGE_TOKENS = {
  black: "#090A0C",
  taupe: "#60483E",
  /** Solid dark card fill (glass is a later progressive enhancement, never required to read). */
  surface: "#211611",
  surfaceLine: "#3A2B22",
  paper: "#F3F0EC",
  /** Cards on paper. */
  card: "#FBF9F6",
  cardLine: "#D9D1C6",
  espresso: "#2E2521",
  soil: "#1F0E07",
  inkMuted: "#665B52",
  clay: "#9F4A1C",
  ivory: "#F0EBE2",
  ivoryMuted: "#BDB6AA",
  // Status words (always paired with an icon), on paper.
  good: "#2F5D2A",
  warn: "#7A4E00",
  late: "#8A2E1E",
  // Status words on the dark surfaces.
  goodDark: "#CFE3B0",
  warnDark: "#F2B36B",
  lateDark: "#F4A48E",
  focusDark: "#F8E0B0",
  focusLight: "#1F0E07",
} as const;

export type PageToken = keyof typeof PAGE_TOKENS;

/** Text tokens and the surfaces they sit on, with the minimum ratio each pair must reach. */
export const PAGE_CONTRAST_PAIRS: readonly { fg: PageToken; bg: PageToken; min: number }[] = [
  { fg: "espresso", bg: "paper", min: 4.5 },
  { fg: "espresso", bg: "card", min: 4.5 },
  { fg: "soil", bg: "paper", min: 4.5 },
  { fg: "inkMuted", bg: "paper", min: 4.5 },
  { fg: "inkMuted", bg: "card", min: 4.5 },
  { fg: "clay", bg: "paper", min: 4.5 },
  { fg: "clay", bg: "card", min: 4.5 },
  { fg: "good", bg: "card", min: 4.5 },
  { fg: "warn", bg: "card", min: 4.5 },
  { fg: "late", bg: "card", min: 4.5 },
  { fg: "good", bg: "paper", min: 4.5 },
  { fg: "warn", bg: "paper", min: 4.5 },
  { fg: "late", bg: "paper", min: 4.5 },
  { fg: "ivory", bg: "black", min: 4.5 },
  { fg: "ivory", bg: "surface", min: 4.5 },
  { fg: "ivory", bg: "taupe", min: 4.5 },
  { fg: "ivoryMuted", bg: "black", min: 4.5 },
  { fg: "ivoryMuted", bg: "surface", min: 4.5 },
  { fg: "goodDark", bg: "surface", min: 4.5 },
  { fg: "warnDark", bg: "surface", min: 4.5 },
  { fg: "lateDark", bg: "surface", min: 4.5 },
  { fg: "goodDark", bg: "black", min: 4.5 },
  { fg: "warnDark", bg: "black", min: 4.5 },
  { fg: "lateDark", bg: "black", min: 4.5 },
  // Focus rings and control borders need 3:1 (WCAG 1.4.11).
  { fg: "focusDark", bg: "black", min: 3 },
  { fg: "focusDark", bg: "surface", min: 3 },
  { fg: "focusLight", bg: "paper", min: 3 },
  { fg: "cardLine", bg: "paper", min: 1 },
];

function toCssName(token: string): string {
  return `--${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** `:root{--black:#090A0C;…}` */
export function tokensCss(): string {
  const body = Object.entries(PAGE_TOKENS)
    .map(([k, v]) => `${toCssName(k)}:${v}`)
    .join(";");
  return `:root{${body}}`;
}

/** WCAG relative luminance of a #RRGGBB colour. */
export function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
