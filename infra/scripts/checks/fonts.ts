/**
 * Fonts check: the web fonts are self-hosted, so the CSP keeps `font-src 'self'` and no page
 * request leaves for a third-party font host (which would also leak every visitor's IP and page).
 *
 * - client code and styles load nothing from a font CDN;
 * - every `url("/fonts/...")` in client CSS names a file in client/public/fonts;
 * - every font file there is listed in SOURCES.txt, and each family ships its SIL OFL text;
 * - the Worker's CSP (server/config/security.ts) admits fonts from 'self' only.
 */
import { lineOf, type Finding } from "./files";

const CHECK = "fonts";
export const FONT_DIR = "client/public/fonts";

const REMOTE_FONT_HOSTS = /\b(?:fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net|fast\.fonts\.net|cdn\.jsdelivr\.net\/npm\/@fontsource)\b/g;

export function isFontScope(file: string): boolean {
  if (/\.test\.tsx?$/.test(file)) return false;
  return /^client\/(?:src\/|index\.html$)/.test(file) && /\.(?:css|html|tsx?|jsx?)$/.test(file);
}

/** Findings for one client file: remote font hosts and /fonts/ URLs without a file. */
export function checkFontReferences(file: string, text: string, fontFiles: ReadonlySet<string>): Finding[] {
  const findings: Finding[] = [];
  REMOTE_FONT_HOSTS.lastIndex = 0;
  for (const m of text.matchAll(REMOTE_FONT_HOSTS)) {
    findings.push({ check: CHECK, file, line: lineOf(text, m.index ?? 0), message: "loads fonts from a third-party host; self-host them in client/public/fonts" });
  }
  if (file.endsWith(".css")) {
    for (const m of text.matchAll(/url\(\s*["']?\/fonts\/([^"')\s]+)["']?\s*\)/g)) {
      if (!fontFiles.has(m[1] as string)) findings.push({ check: CHECK, file, line: lineOf(text, m.index ?? 0), message: `no file client/public/fonts/${m[1]}` });
    }
  }
  return findings;
}

/** Findings for the font folder itself: every font listed in SOURCES.txt and licensed. */
export function checkFontFolder(names: readonly string[], read: (name: string) => string | null): Finding[] {
  const findings: Finding[] = [];
  const fonts = names.filter((n) => /\.(?:woff2?|ttf|otf)$/i.test(n));
  if (fonts.length === 0) return findings;
  const sources = read("SOURCES.txt");
  if (sources === null) findings.push({ check: CHECK, file: `${FONT_DIR}/SOURCES.txt`, message: "missing: say where each font came from and under which license" });
  const licenses = names.filter((n) => /^OFL-.+\.txt$/.test(n));
  for (const lic of licenses) {
    const text = read(lic) ?? "";
    if (!/SIL OPEN FONT LICENSE/i.test(text)) findings.push({ check: CHECK, file: `${FONT_DIR}/${lic}`, message: "is not the SIL Open Font License text" });
  }
  for (const font of fonts) {
    const family = font.split("-")[0]?.toLowerCase() ?? "";
    if (!licenses.some((l) => l.toLowerCase().startsWith(`ofl-${family}`))) {
      findings.push({ check: CHECK, file: `${FONT_DIR}/${font}`, message: `no license file OFL-<Family>.txt for "${family}"` });
    }
    if (sources !== null && !sourcesMention(sources, font)) {
      findings.push({ check: CHECK, file: `${FONT_DIR}/${font}`, message: "not listed in SOURCES.txt" });
    }
  }
  return findings;
}

/** SOURCES.txt lists files with brace groups, e.g. dm-mono-{400,500}-{latin,latin-ext}.woff2. */
export function sourcesMention(sources: string, font: string): boolean {
  for (const token of sources.split(/\s+/)) {
    if (expandBraces(token).includes(font)) return true;
  }
  return false;
}

export function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]*)\}/.exec(pattern);
  if (!m) return [pattern];
  const head = pattern.slice(0, m.index);
  const tail = pattern.slice(m.index + m[0].length);
  return (m[1] as string).split(",").flatMap((alt) => expandBraces(`${head}${alt}${tail}`));
}

/** The CSP must keep fonts (and styles) on our own origin. */
export function checkCspFonts(policies: Readonly<Record<string, string>>): Finding[] {
  const findings: Finding[] = [];
  for (const [name, policy] of Object.entries(policies)) {
    const directives = new Map(policy.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k as string, v]));
    const fontSrc = directives.get("font-src") ?? directives.get("default-src") ?? [];
    if (fontSrc.length !== 1 || fontSrc[0] !== "'self'") findings.push({ check: CHECK, file: "server/config/security.ts", message: `${name} CSP font-src is "${fontSrc.join(" ")}", expected 'self' only` });
    const styleSrc = directives.get("style-src") ?? directives.get("default-src") ?? [];
    if (styleSrc.some((s) => /^https?:/.test(s))) findings.push({ check: CHECK, file: "server/config/security.ts", message: `${name} CSP style-src allows a remote host` });
  }
  return findings;
}
