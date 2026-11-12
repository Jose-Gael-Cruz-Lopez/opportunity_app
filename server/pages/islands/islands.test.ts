import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ageInYears as serverAge, RemindMeBodySchema } from "@server/api/v1/remind/service";
import { AnalyticsBatchSchema } from "@shared/contracts/api";
import { ClientErrorReportSchema } from "@server/api/v1/events/client-errors";
import { checkProps } from "@server/api/v1/events/allowlist";
import { birthYears, RemindMeIsland } from "./remind-me";
import { REMIND_CORE_JS, REMIND_JS } from "./remind-me-js";
import { ISLANDS_CSS } from "./islands-css";
import { createIslandAssetRoutes, islandAssetForPath, islandAssetPath, REMIND_PAGE_CSP } from "./assets";

interface Core {
  MIN_AGE: number;
  ADULT_AGE: number;
  mayTrack(age: unknown, outcome: string): boolean;
  ageInYears(year: number, month: number, nowMs: number): number;
  yearMonth(year: unknown, month: unknown): string;
  validEmail(s: unknown): boolean;
  outcomeFor(status: number, code?: string): { outcome: string; text: string };
  randomId(c: { getRandomValues(a: Uint8Array): Uint8Array }): string;
  errorClass(err: unknown): string;
  browserFamily(ua: string): string;
}

const core = new Function(`return (${REMIND_CORE_JS});`)() as Core;
const NOW = Date.UTC(2026, 10, 11, 15, 0);
const CYCLE = "0190f7a2-5c3e-7b4d-8e9f-0a1b2c3d4e5f";

describe("Remind me island script", () => {
  it("parses as a script", () => {
    expect(() => new Function(REMIND_JS)).not.toThrow();
  });

  it("computes age exactly like the server's age screen", () => {
    for (const ym of ["2010-11", "2010-10", "2010-12", "2008-11", "2009-01", "2000-06"]) {
      const [y, m] = ym.split("-").map(Number) as [number, number];
      expect(core.ageInYears(y, m, NOW)).toBe(serverAge(ym, NOW));
    }
    expect(core.MIN_AGE).toBe(16);
  });

  it("builds a birth month the server schema accepts, or nothing", () => {
    expect(core.yearMonth("2008", "3")).toBe("2008-03");
    expect(core.yearMonth("2008", "12")).toBe("2008-12");
    expect(core.yearMonth("", "3")).toBe("");
    expect(core.yearMonth("2008", "13")).toBe("");
    expect(core.yearMonth("2008.5", "1")).toBe("");
    const body = { email: "a@example.org", programCycleId: CYCLE, turnstileToken: "tok", sensitiveOptIn: false, birthYearMonth: core.yearMonth(2008, 3) };
    expect(RemindMeBodySchema.safeParse(body).success).toBe(true);
  });

  it("checks addresses loosely and maps every answer to fixed copy and an allowlisted outcome", () => {
    expect(core.validEmail("student@example.edu")).toBe(true);
    expect(core.validEmail("no-at-sign")).toBe(false);
    expect(core.validEmail("a@b")).toBe(false);
    for (const [status, code] of [[202], [400, "bad_request"], [400, "validation_failed"], [403], [404], [409], [429], [503], [0], [500]] as [number, string?][]) {
      const o = core.outcomeFor(status, code);
      // under_age is a display outcome only: never sent, and refused by the server's allowlist.
      expect(checkProps("remind_me_submit", { cycleId: CYCLE, outcome: o.outcome }).ok).toBe(o.outcome !== "under_age");
      if (status !== 202) expect(o.text.length).toBeGreaterThan(10);
    }
    expect(core.outcomeFor(400, "bad_request").outcome).toBe("under_age");
  });

  it("sends no event for under-16s or minor mode (16-17), and never the under_age outcome", () => {
    expect(core.ADULT_AGE).toBe(18);
    expect(core.mayTrack(15, "failed")).toBe(false);
    expect(core.mayTrack(16, "accepted")).toBe(false);
    expect(core.mayTrack(17, "accepted")).toBe(false);
    expect(core.mayTrack(undefined, "accepted")).toBe(false);
    expect(core.mayTrack(18, "accepted")).toBe(true);
    expect(core.mayTrack(30, "under_age")).toBe(false);
    // The under-16 branch returns before any track() call; every track() call passes the age.
    const underBranch = REMIND_JS.slice(REMIND_JS.indexOf("if (age < core.MIN_AGE)"), REMIND_JS.indexOf("if (needsConsent"));
    expect(underBranch).toContain("return;");
    expect(underBranch).not.toContain("track(");
    expect(REMIND_JS.match(/(?<!function )track\(cycleId[^)]*\)/g)).toEqual(["track(cycleId, o.outcome, age)"]);
    expect(checkProps("remind_me_submit", { cycleId: CYCLE, outcome: "under_age" })).toEqual({ ok: false, reason: "bad_value" });
  });

  it("sends events the events endpoint accepts: one-time id, the day only, an allowlisted outcome", () => {
    const id = core.randomId(webcrypto);
    expect(id).toMatch(/^[0-9A-Za-z_-]{22}$/);
    expect(core.randomId(webcrypto)).not.toBe(id);
    const day = new Date(NOW);
    day.setUTCHours(0, 0, 0, 0);
    const batch = { events: [{ name: "remind_me_submit", deviceId: id, at: day.toISOString(), path: "/programs/:slug", props: { cycleId: CYCLE, outcome: "accepted" } }] };
    expect(AnalyticsBatchSchema.safeParse(batch).success).toBe(true);
    // The script's literal event shape matches this test's.
    expect(REMIND_JS).toContain('name: "remind_me_submit"');
    expect(REMIND_JS).toContain('credentials: "omit"');
  });

  it("reports its own crashes with the class only", () => {
    expect(core.errorClass(new TypeError("secret text"))).toBe("TypeError");
    expect(core.errorClass({ name: "has spaces: and text" })).toBe("Error");
    expect(core.errorClass(null)).toBe("Error");
    expect(core.browserFamily("Mozilla/5.0 (iPhone) AppleWebKit Instagram 300.0")).toBe("in_app");
    expect(core.browserFamily("Mozilla/5.0 Chrome/131.0 Safari/537.36 Edg/131.0")).toBe("edge");
    const report = { kind: "island", surface: "island", errorClass: "TypeError", route: "/programs/:slug", release: "remind-me.v1", browser: "safari", file: "remind-me.js", line: null, column: null };
    expect(ClientErrorReportSchema.safeParse(report).success).toBe(true);
    for (const key of Object.keys(report)) expect(REMIND_JS).toContain(`${key}:`);
  });

  it("never touches cookies or Web Storage and never sets inline styles", () => {
    expect(REMIND_JS).not.toMatch(/document\.cookie|localStorage|sessionStorage|indexedDB/);
    expect(REMIND_JS).not.toMatch(/\.style\b|setAttribute\(\s*["']style/);
    expect(REMIND_JS).not.toMatch(/console\./);
  });
});

describe("RemindMeIsland markup", () => {
  const html = (restricted: boolean) => String(RemindMeIsland({ cycleId: CYCLE, programSlug: "sample-program", restricted, now: NOW }));

  it("renders a hidden form, a no-JavaScript fallback and the hashed assets", () => {
    const out = html(false);
    expect(out).toContain('data-island="remind-me"');
    expect(out).toContain(`data-cycle="${CYCLE}"`);
    expect(out).toContain('data-consent="0"');
    expect(out).toMatch(/<form[^>]*hidden/);
    expect(out).toContain('href="/cal/p/sample-program.ics"');
    expect(out).toContain(`src="${islandAssetPath("remind-me.js")}"`);
    expect(out).toContain(`href="${islandAssetPath("islands.css")}"`);
    expect(out).not.toContain("optIn");
    // Labels for every control; no inline style or script body.
    expect(out).toContain('for="rm-email"');
    expect(out).toContain('aria-label="Birth month"');
    expect(out).not.toMatch(/style=/);
    expect(out).not.toMatch(/<script(?![^>]*src=)[^>]*>[^<]/);
  });

  it("asks for an explicit opt-in on status- or identity-defined programs", () => {
    const out = html(true);
    expect(out).toContain('data-consent="1"');
    expect(out).toContain('name="optIn"');
    expect(out).not.toMatch(/name="optIn"[^>]*checked/);
  });

  it("offers birth years young enough to answer truthfully and old enough for adults", () => {
    const years = birthYears(NOW);
    expect(years[0]).toBe(2016);
    expect(years.at(-1)).toBe(1946);
  });
});

describe("island assets", () => {
  it("serves hashed files immutable and old hashes briefly", async () => {
    const app = createIslandAssetRoutes();
    const js = await app.request(islandAssetPath("remind-me.js"));
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(js.headers.get("cache-control")).toContain("immutable");
    expect(await js.text()).toBe(REMIND_JS);
    const css = await app.request(islandAssetPath("islands.css"));
    expect(await css.text()).toBe(ISLANDS_CSS);
    const old = await app.request("/p/i/remind-me.00000000.js");
    expect(old.status).toBe(200);
    expect(old.headers.get("cache-control")).not.toContain("immutable");
    expect((await app.request("/p/i/other.00000000.js")).status).toBe(404);
    expect(islandAssetForPath("/p/remind-me.00000000.js")).toBeUndefined();
  });

  it("gives the Program page a CSP that admits Turnstile and nothing inline", () => {
    expect(REMIND_PAGE_CSP).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(REMIND_PAGE_CSP).toContain("frame-src https://challenges.cloudflare.com");
    expect(REMIND_PAGE_CSP).not.toContain("unsafe-inline");
  });
});
