import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Lint-style proof that SensitiveAnswers stay on the device (rule N1/N2). ESLint is not installed,
 * so this test walks the real import graph instead:
 *
 * 1. No file reachable from server/** (the Worker, MCP, jobs) imports shared/eligibility/sensitive.ts,
 *    directly or through any chain of imports, including through shared/eligibility/index.ts.
 * 2. Server code names none of the device-only identifiers.
 * 3. Pipeline (Python) code never loads the device-only half of the golden cases or names the
 *    device-only API.
 * Negative controls feed synthetic violations through the same checks to show they bite.
 */

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SENSITIVE_MODULE = path.join(ROOT, "shared", "eligibility", "sensitive.ts");
const DEVICE_ONLY_IDENTIFIERS = /\b(SensitiveAnswers(?:Schema)?|evaluateWithAnswers|createAnswerBox|AnswerBox|DeviceEligibilityResult)\b/;

function walk(dir: string, exts: readonly string[], skip: readonly string[] = ["node_modules", ".venv", "dist", "__pycache__"]): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (skip.includes(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, exts, skip));
    else if (exts.some((e) => name.endsWith(e))) out.push(full);
  }
  return out;
}

/** Removes comments (and so mentions of identifiers in prose) before scanning code. */
export function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

export function importSpecifiers(source: string): string[] {
  const code = stripTsComments(source);
  const specs: string[] = [];
  const patterns = [/(?:import|export)\s[^;]*?from\s*["']([^"']+)["']/g, /import\s*["']([^"']+)["']/g, /import\(\s*["']([^"']+)["']\s*\)/g, /require\(\s*["']([^"']+)["']\s*\)/g];
  for (const re of patterns) for (const m of code.matchAll(re)) specs.push(m[1] as string);
  return specs;
}

const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

export function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith(".")) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith("@shared/")) base = path.join(ROOT, "shared", spec.slice("@shared/".length));
  else if (spec.startsWith("@server/")) base = path.join(ROOT, "server", spec.slice("@server/".length));
  else return null; // a package
  base = base.replace(/\.js$/, "");
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = base + suffix;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Every local file reachable from `roots`, with the chain that reached it. */
export function reachable(roots: readonly string[], read: (file: string) => string = (f) => readFileSync(f, "utf8")): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue: [string, string[]][] = roots.map((r) => [r, [r]]);
  while (queue.length > 0) {
    const [file, chain] = queue.shift() as [string, string[]];
    if (seen.has(file)) continue;
    seen.set(file, chain);
    for (const spec of importSpecifiers(read(file))) {
      const target = resolveImport(file, spec);
      if (target && !seen.has(target)) queue.push([target, [...chain, target]]);
    }
  }
  return seen;
}

function rel(file: string): string {
  return path.relative(ROOT, file);
}

describe("privacy boundary: shared/eligibility/sensitive.ts is browser-only", () => {
  const serverFiles = walk(path.join(ROOT, "server"), [".ts", ".tsx"]);

  it("is not reachable from any server file", () => {
    expect(serverFiles.length).toBeGreaterThan(0);
    const graph = reachable(serverFiles);
    const chain = graph.get(SENSITIVE_MODULE);
    expect(chain ? chain.map(rel).join(" -> ") : null).toBeNull();
  });

  it("is not reachable from the server-safe entry point shared/eligibility/index.ts", () => {
    const graph = reachable([path.join(ROOT, "shared", "eligibility", "index.ts")]);
    expect(graph.has(SENSITIVE_MODULE)).toBe(false);
    expect(graph.size).toBeGreaterThan(5);
  });

  it("no other shared module imports it (shared code is compiled into the Worker)", () => {
    const sharedFiles = walk(path.join(ROOT, "shared"), [".ts", ".tsx"]).filter((f) => !f.endsWith(".test.ts") && f !== SENSITIVE_MODULE);
    const offenders = sharedFiles.filter((f) => importSpecifiers(readFileSync(f, "utf8")).some((s) => resolveImport(f, s) === SENSITIVE_MODULE));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("server code names no device-only identifier", () => {
    const offenders = serverFiles.filter((f) => DEVICE_ONLY_IDENTIFIERS.test(stripTsComments(readFileSync(f, "utf8"))));
    expect(offenders.map(rel)).toEqual([]);
  });

  it("pipeline code never reads the device-only half of golden cases or the device API", () => {
    const pyFiles = walk(path.join(ROOT, "pipeline"), [".py"]);
    const strip = (s: string): string => s.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, "").replace(/#.*$/gm, "");
    const banned = /\[\s*["']device["']\s*\]|\.get\(\s*["']device["']|evaluate_with_answers|SensitiveAnswers|AnswerBox/;
    const offenders = pyFiles.filter((f) => banned.test(strip(readFileSync(f, "utf8"))));
    expect(offenders.map(rel)).toEqual([]);
  });

  describe("negative controls (the checks detect synthetic violations)", () => {
    const fake = path.join(ROOT, "server", "__fake__.ts");
    const fakeShared = path.join(ROOT, "shared", "__fake_shared__.ts");
    const sources: Record<string, string> = {
      [fake]: 'import { thing } from "@shared/__fake_shared__";\n// import { evaluateWithAnswers } from "@shared/eligibility/sensitive";',
      [fakeShared]: 'export { evaluateWithAnswers as thing } from "./eligibility/sensitive";',
    };
    const read = (f: string): string => sources[f] ?? readFileSync(f, "utf8");

    it("follows re-exports through intermediate modules and ignores commented imports", () => {
      // resolveImport checks the disk, so map the fake files by hand for this control.
      const graph = new Map<string, string[]>();
      const queue: string[] = [fake];
      while (queue.length) {
        const f = queue.shift() as string;
        if (graph.has(f)) continue;
        graph.set(f, []);
        for (const spec of importSpecifiers(read(f))) {
          const target = spec === "@shared/__fake_shared__" ? fakeShared : resolveImport(f, spec);
          if (target) queue.push(target);
        }
      }
      expect(graph.has(SENSITIVE_MODULE)).toBe(true);
      expect(importSpecifiers(sources[fake] as string)).toEqual(["@shared/__fake_shared__"]);
    });

    it("resolves alias, relative and index paths to the module file", () => {
      expect(resolveImport(fake, "@shared/eligibility/sensitive")).toBe(SENSITIVE_MODULE);
      expect(resolveImport(path.join(ROOT, "shared", "eligibility", "x.ts"), "./sensitive.js")).toBe(SENSITIVE_MODULE);
      expect(resolveImport(fake, "@shared/eligibility")).toBe(path.join(ROOT, "shared", "eligibility", "index.ts"));
      expect(resolveImport(fake, "hono")).toBeNull();
    });

    it("flags identifiers in code but not in comments", () => {
      expect(DEVICE_ONLY_IDENTIFIERS.test(stripTsComments("// SensitiveAnswers never reach here"))).toBe(false);
      expect(DEVICE_ONLY_IDENTIFIERS.test(stripTsComments("const a: SensitiveAnswers = {};"))).toBe(true);
      expect(DEVICE_ONLY_IDENTIFIERS.test(stripTsComments('const u = "https://example.org"; evaluateWithAnswers(x)'))).toBe(true);
    });
  });
});
