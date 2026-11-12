import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

function stripTsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/**
 * The evaluator is pure: no clock, no network, no storage, no randomness. Checked two ways:
 * statically (no banned API in the module's source) and at runtime (the golden suite runs with
 * every banned global stubbed to throw).
 */

const dir = import.meta.dirname;
const sources = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => ({ file: f, code: stripTsComments(readFileSync(path.join(dir, f), "utf8")) }));

const BANNED: readonly [string, RegExp][] = [
  ["Date.now", /\bDate\.now\b/],
  ["new Date", /\bnew\s+Date\b/],
  ["Date(", /(?<![.\w])Date\(/],
  ["Intl", /\bIntl\./],
  ["Math.random", /\bMath\.random\b/],
  ["fetch", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["localStorage", /\blocalStorage\b/],
  ["sessionStorage", /\bsessionStorage\b/],
  ["indexedDB", /\bindexedDB\b/],
  ["caches", /\bcaches\./],
  ["document.cookie", /\bdocument\.cookie\b/],
  ["crypto.randomUUID", /\brandomUUID\b/],
  ["console", /\bconsole\./],
];

describe("shared/eligibility purity", () => {
  it.each(BANNED)("source never uses %s", (_name, re) => {
    expect(sources.filter((s) => re.test(s.code)).map((s) => s.file)).toEqual([]);
  });

  it("does not import json-logic-js (two-valued and coercive)", () => {
    expect(sources.filter((s) => /json-logic-js/.test(s.code)).map((s) => s.file)).toEqual([]);
  });

  describe("runtime, with I/O and clock globals stubbed to throw", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("evaluates every golden case (server and device paths) without touching them", async () => {
      const boom = (name: string) => () => {
        throw new Error(`${name} used during evaluation`);
      };
      const throwing = new Proxy({}, { get: (_t, p) => boom(`storage.${String(p)}`)() });
      vi.stubGlobal("fetch", boom("fetch"));
      vi.stubGlobal("XMLHttpRequest", boom("XMLHttpRequest"));
      vi.stubGlobal("localStorage", throwing);
      vi.stubGlobal("sessionStorage", throwing);
      vi.stubGlobal("indexedDB", throwing);
      vi.stubGlobal("caches", throwing);
      const realNow = Date.now;
      Date.now = boom("Date.now");
      const realRandom = Math.random;
      Math.random = boom("Math.random");
      try {
        const { evaluateEligibility, parseRuleSet } = await import("./index");
        const { evaluateWithAnswers } = await import("./sensitive");
        const cases = JSON.parse(readFileSync(path.join(dir, "golden", "cases.json"), "utf8")) as {
          contexts: Record<string, unknown>;
          cases: { ruleSet: string | null; context: string; asOf: string; profile: Record<string, unknown>; device?: { answers: never; attestations: Record<string, boolean> } }[];
        };
        const sets = JSON.parse(readFileSync(path.join(dir, "golden", "rule-sets.json"), "utf8")) as { ruleSets: Record<string, { ruleSet: unknown }> };
        let n = 0;
        for (const c of cases.cases) {
          const rs = c.ruleSet ? parseRuleSet(sets.ruleSets[c.ruleSet]!.ruleSet) : null;
          const opts = { asOf: c.asOf, context: cases.contexts[c.context] as never };
          evaluateEligibility(rs, c.profile, opts);
          if (c.device) evaluateWithAnswers(rs, c.profile, { ...opts, answers: c.device.answers, attestations: new Map(Object.entries(c.device.attestations)) });
          n++;
        }
        expect(n).toBe(cases.cases.length);
      } finally {
        Date.now = realNow;
        Math.random = realRandom;
      }
    });
  });
});
