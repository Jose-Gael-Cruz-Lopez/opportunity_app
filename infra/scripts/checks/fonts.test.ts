import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCsp } from "../../../server/config/security";
import { REPO_ROOT, readText } from "./files";
import { checkCspFonts, checkFontFolder, checkFontReferences, expandBraces, FONT_DIR, isFontScope, sourcesMention } from "./fonts";

const dir = join(REPO_ROOT, FONT_DIR);
const names = readdirSync(dir);

describe("self-hosted fonts", () => {
  it("ship woff2 files with a license per family and a SOURCES.txt entry", () => {
    expect(names.filter((n) => n.endsWith(".woff2")).length).toBeGreaterThanOrEqual(8);
    expect(checkFontFolder(names, (n) => readText(dir, n))).toEqual([]);
  });

  it("are the only fonts index.css and start.css load, and every url exists", () => {
    const files = new Set(names);
    for (const rel of ["client/src/index.css", "client/src/components/start/start.css", "client/index.html"]) {
      expect(checkFontReferences(rel, readFileSync(join(REPO_ROOT, rel), "utf8"), files), rel).toEqual([]);
    }
    const css = readFileSync(join(REPO_ROOT, "client/src/index.css"), "utf8");
    for (const family of ["DM Mono", "Doto", "Urbanist"]) expect(css).toContain(`font-family: "${family}"`);
  });

  it("keep the Worker CSP at font-src 'self'", () => {
    expect(checkCspFonts({ base: buildCsp(), spa: buildCsp({ turnstile: true, inlineStyles: true }) })).toEqual([]);
  });
});

describe("fonts check (negative controls)", () => {
  it("flags a font CDN and a missing file", () => {
    const css = '@import url("https://fonts.googleapis.com/css2?family=Doto");\n@font-face { src: url("/fonts/nope.woff2"); }';
    const findings = checkFontReferences("client/src/x.css", css, new Set(["a.woff2"]));
    expect(findings.map((f) => f.line)).toEqual([1, 2]);
  });

  it("flags an unlicensed or unlisted font and a fake license", () => {
    const files: Record<string, string> = { "SOURCES.txt": "inter-{400}-latin.woff2", "OFL-Inter.txt": "MIT License" };
    const findings = checkFontFolder(["inter-400-latin.woff2", "lato-400.woff2", "OFL-Inter.txt", "SOURCES.txt"], (n) => files[n] ?? null);
    expect(findings.map((f) => f.message)).toEqual([
      "is not the SIL Open Font License text",
      'no license file OFL-<Family>.txt for "lato"',
      "not listed in SOURCES.txt",
    ]);
  });

  it("flags a CSP that widens font-src or style-src", () => {
    const wide = "default-src 'self'; font-src 'self' https://fonts.gstatic.com; style-src 'self' https://fonts.googleapis.com";
    expect(checkCspFonts({ wide })).toHaveLength(2);
  });

  it("expands brace groups and scopes to client code", () => {
    expect(expandBraces("a-{1,2}-{x,y}.woff2")).toEqual(["a-1-x.woff2", "a-1-y.woff2", "a-2-x.woff2", "a-2-y.woff2"]);
    expect(sourcesMention("  dm-mono-{400,500}-{latin,latin-ext}.woff2  ", "dm-mono-500-latin-ext.woff2")).toBe(true);
    expect(isFontScope("client/src/index.css")).toBe(true);
    expect(isFontScope("client/index.html")).toBe(true);
    expect(isFontScope("server/ai/config.ts")).toBe(false);
    expect(isFontScope("client/src/a.test.ts")).toBe(false);
  });
});
