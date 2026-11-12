import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { blend, contrastRatio, parseHex, relativeLuminance, tokenContrast } from "./contrast";
import { CONTRAST_PAIRS, CSS_VAR, LOOKS, PALETTES, type LookPalette, type TokenColor } from "./tokens";
import { GLASS_RELEASED, shouldUseGlass, type GlassEnvironment } from "./glass-gate";
import { parseLook, readStoredLook, storeLook, type KeyValueStore } from "./look";

describe("contrast math", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio(parseHex("#000"), parseHex("#fff"))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseHex("#777777"), parseHex("#ffffff"))).toBeCloseTo(4.48, 2);
    expect(relativeLuminance(parseHex("#ffffff"))).toBeCloseTo(1, 6);
  });

  it("blends alpha in sRGB", () => {
    expect(blend({ r: 255, g: 255, b: 255 }, 0.5, { r: 0, g: 0, b: 0 })).toEqual({ r: 128, g: 128, b: 128 });
  });

  it("rejects malformed hex", () => {
    expect(() => parseHex("rgb(0,0,0)")).toThrow();
  });
});

describe("token pairs", () => {
  for (const look of LOOKS) {
    for (const pair of CONTRAST_PAIRS) {
      it(`${look}: ${pair.fg} on ${pair.bg} >= ${pair.min}`, () => {
        const ratio = tokenContrast(PALETTES[look][pair.fg], PALETTES[look][pair.bg]);
        expect(ratio).toBeGreaterThanOrEqual(pair.min);
      });
    }
  }
});

/** Pulls `--name: value;` declarations out of one CSS block. */
function declarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out.set(m[1] as string, (m[2] as string).trim());
  return out;
}

function blockAfter(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`selector not found: ${selector}`);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}

function cssValue(color: TokenColor): string {
  if (color.alpha === undefined) return color.hex.toUpperCase();
  const { r, g, b } = parseHex(color.hex);
  return `rgba(${r}, ${g}, ${b}, ${color.alpha})`;
}

describe("index.css stays in sync with tokens.ts", () => {
  const css = readFileSync(resolve(import.meta.dirname, "..", "index.css"), "utf8");
  const blocks = {
    ember: declarations(blockAfter(css, ":root")),
    meadow: declarations(blockAfter(css, ':root[data-look="meadow"]')),
  };
  for (const look of LOOKS) {
    for (const key of Object.keys(CSS_VAR) as (keyof LookPalette)[]) {
      it(`${look} ${CSS_VAR[key]}`, () => {
        expect(blocks[look].get(CSS_VAR[key])?.toUpperCase()).toBe(cssValue(PALETTES[look][key]).toUpperCase());
      });
    }
  }
});

describe("glass gate", () => {
  const capable: GlassEnvironment = {
    supportsBackdrop: true,
    prefersReducedTransparency: false,
    prefersMoreContrast: false,
    forcedColors: false,
    saveData: undefined,
    deviceMemoryGb: undefined,
    solidPreferred: false,
    glassReleased: true,
  };

  it("ships solid surfaces on every device until glass is released in Phase 3 (plan D17)", () => {
    expect(GLASS_RELEASED).toBe(false);
    expect(shouldUseGlass({ ...capable, glassReleased: GLASS_RELEASED })).toBe(false);
    expect(shouldUseGlass({ ...capable, glassReleased: false, deviceMemoryGb: 16 })).toBe(false);
  });

  it("once released, turns glass on for capable devices, including engines that hide deviceMemory", () => {
    expect(shouldUseGlass(capable)).toBe(true);
    expect(shouldUseGlass({ ...capable, deviceMemoryGb: 8 })).toBe(true);
  });

  it("keeps surfaces solid whenever any preference or limit says so", () => {
    expect(shouldUseGlass({ ...capable, supportsBackdrop: false })).toBe(false);
    expect(shouldUseGlass({ ...capable, prefersReducedTransparency: true })).toBe(false);
    expect(shouldUseGlass({ ...capable, prefersMoreContrast: true })).toBe(false);
    expect(shouldUseGlass({ ...capable, forcedColors: true })).toBe(false);
    expect(shouldUseGlass({ ...capable, saveData: true })).toBe(false);
    expect(shouldUseGlass({ ...capable, deviceMemoryGb: 2 })).toBe(false);
    expect(shouldUseGlass({ ...capable, solidPreferred: true })).toBe(false);
  });
});

describe("look preference", () => {
  const memory = (): KeyValueStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };

  it("defaults to ember for missing or unknown values", () => {
    expect(parseLook(undefined)).toBe("ember");
    expect(parseLook("neon")).toBe("ember");
    expect(parseLook("meadow")).toBe("meadow");
  });

  it("round-trips through storage and survives a throwing store", () => {
    const store = memory();
    storeLook("meadow", store);
    expect(readStoredLook(store)).toBe("meadow");
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredLook(broken)).toBe("ember");
    expect(() => storeLook("ember", broken)).not.toThrow();
  });
});
