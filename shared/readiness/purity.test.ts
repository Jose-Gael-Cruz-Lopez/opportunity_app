import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assessReadiness } from "./assess";
import { predictCycleEvent } from "./predict";
import {
  CAMPUS_ID,
  CYCLE_ID,
  GOLDWATER_DEADLINE,
  GOLDWATER_NOMINATION,
  SAMPLE_CHECKLIST,
  GOLDWATER_STAGE_ODDS,
  PROGRAM_ID,
  conditionalEligibility,
} from "./test-fixtures";

/**
 * Readiness is pure: the clock is an input, and nothing reads the network, storage, randomness
 * or an LLM. Checked statically over the module's sources and at runtime with those globals
 * stubbed to throw. Imports stay inside shared/ (plus zod), so no server, client, AI or
 * analytics module can leak in (plan 7.2 principles 4 and 6).
 */

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function sourcesIn(dir: string, prefix = ""): { file: string; code: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return sourcesIn(path.join(dir, entry.name), `${prefix}${entry.name}/`);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [{ file: `${prefix}${entry.name}`, code: stripComments(readFileSync(path.join(dir, entry.name), "utf8")) }];
  });
}

const sources = sourcesIn(import.meta.dirname);

const BANNED: readonly [string, RegExp][] = [
  ["Date.now", /\bDate\.now\b/],
  ["new Date", /\bnew\s+Date\b/],
  ["Math.random", /\bMath\.random\b/],
  ["fetch", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["localStorage", /\blocalStorage\b/],
  ["sessionStorage", /\bsessionStorage\b/],
  ["indexedDB", /\bindexedDB\b/],
  ["document.cookie", /\bdocument\.cookie\b/],
  ["console", /\bconsole\./],
  ["process.env", /\bprocess\.env\b/],
];

describe("shared/readiness purity", () => {
  it("found the module's sources", () => {
    expect(sources.map((s) => s.file)).toContain("assess.ts");
    expect(sources.map((s) => s.file)).toContain("math/special.ts");
  });

  it.each(BANNED)("source never uses %s", (_name, re) => {
    expect(sources.filter((s) => re.test(s.code)).map((s) => s.file)).toEqual([]);
  });

  it("imports only shared modules and zod", () => {
    const allowed = /^(\.\/|\.\.\/(contracts|time|taxonomy|config)\/|\.\.\/(contracts|time|taxonomy|config)$|\.\/math\/|\.\.\/(math|calendar|special|random|intervals|linalg)|zod$)/;
    const bad: string[] = [];
    for (const s of sources) {
      for (const m of s.code.matchAll(/from\s+"([^"]+)"/g)) if (!allowed.test(m[1]!)) bad.push(`${s.file}: ${m[1]}`);
    }
    expect(bad).toEqual([]);
  });

  describe("runtime, with clock, randomness, network and storage stubbed to throw", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("computes a full report and a prediction without touching them", () => {
      const boom = (name: string) => () => {
        throw new Error(`${name} used during readiness`);
      };
      const throwing = new Proxy({}, { get: (_t, p) => boom(`storage.${String(p)}`)() });
      vi.stubGlobal("fetch", boom("fetch"));
      vi.stubGlobal("localStorage", throwing);
      vi.stubGlobal("sessionStorage", throwing);
      vi.spyOn(Date, "now").mockImplementation(boom("Date.now"));
      vi.spyOn(Math, "random").mockImplementation(boom("Math.random"));
      const report = assessReadiness({
        program: { id: PROGRAM_ID, slug: "goldwater-scholarship" },
        cycle: { id: CYCLE_ID, cycleKey: "ay-2026-27" },
        deadlines: [GOLDWATER_DEADLINE],
        requirements: SAMPLE_CHECKLIST,
        requirementsChecked: true,
        eligibility: conditionalEligibility(),
        nomination: GOLDWATER_NOMINATION,
        profile: { timeZone: "America/Chicago", institutionId: CAMPUS_ID },
        stageOdds: GOLDWATER_STAGE_ODDS,
        now: "2026-11-09T15:00:00Z",
      });
      expect(report.nextActions.length).toBeGreaterThan(0);
      const p = predictCycleEvent({ history: [{ event: "opens", cycleYear: 2026, lo: "2026-09-01", hi: "2026-09-01" }] }, "opens", 2027);
      expect(p?.p50).toBe("2027-08-31");
    });
  });
});
