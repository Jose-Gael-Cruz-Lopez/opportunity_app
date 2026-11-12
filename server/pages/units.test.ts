import { describe, expect, it } from "vitest";
import type { DeadlineView, ProgramCard } from "@shared/contracts";
import { computeDueAt, computeSortAt, toIsoInstant } from "@shared/time";
import { assetForPath, assetPath, contentHash } from "./assets";
import { PAGE_CONTRAST_PAIRS, PAGE_TOKENS, contrastRatio } from "./assets/tokens";
import { LANDING_JS } from "./assets/landing-js";
import { PAGE_JS } from "./assets/page-js";
import { clampWords, daysUntil, formatDate, formatMoney, formatTime12, joinList, relativeAge } from "./format";
import { jsonForScript, metaDescription, programTitle } from "./seo";
import { llmsTxt, robotsTxt, sitemapXml } from "./text";
import { browserCache } from "./headers";
import { publicPointer, releasePageData, RELEASE_POINTER_KEY, type ReleaseBucket } from "./release";
import { classYearText, compensationText, costText, describeDeadline, describeStatus, describeVerification, nextDeadline } from "./view-model";
import { featuredProgram, featuredRules, seasonLabel } from "./views/landing";
import { parseExploreQuery } from "./views/explore";
import { parseRange, upcomingDeadlines } from "./views/deadlines";
import { windowSpan } from "./views/program";
import { Hono } from "hono";

const NOW = Date.parse("2026-11-11T15:00:00Z");
let seq = 0;

/** A DeadlineView with dueAt and sortAt computed the way the registry computes them. */
function deadline(fields: Partial<DeadlineView>): DeadlineView {
  seq += 1;
  const base: DeadlineView = {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    kind: "application",
    scope: "national",
    roundLabel: "",
    basis: "official",
    precision: "exact",
    tzMode: "fixed",
    localDate: "2026-12-01",
    localTime: "23:59",
    windowStart: null,
    windowEnd: null,
    timeZone: "America/New_York",
    dueAt: null,
    sortAt: null,
    revision: 1,
    ...fields,
  };
  const due = computeDueAt(base);
  const sort = computeSortAt(base);
  return { ...base, dueAt: due === null ? null : toIsoInstant(due), sortAt: sort === null ? null : toIsoInstant(sort) };
}

function card(fields: Partial<ProgramCard> = {}): ProgramCard {
  seq += 1;
  const id = `00000000-0000-4000-9000-${String(seq).padStart(12, "0")}`;
  return {
    programId: id,
    programCycleId: id.replace("9000", "a000"),
    slug: `example-program-${seq}`,
    cycleKey: "2027",
    name: `Example Program ${seq}`,
    organizationName: "Example Org",
    summary: null,
    opportunityTypes: ["summer_internship"],
    status: "open",
    verification: { state: "verified", verifiedOn: "2026-11-01", verifiedBy: "Sample Curator", freshness: "fresh" },
    deadlines: [deadline({})],
    opensOn: "2026-10-01",
    prediction: null,
    classYears: ["first_year", "second_year"],
    majorFamilies: [],
    cipPrefixes: [],
    interestTags: [],
    aliases: [],
    flags: {
      paid: true,
      participantCost: false,
      applicationFee: false,
      pellDisplacement: false,
      sensitiveAudience: false,
      identityAudience: false,
      nominationRequired: false,
    },
    compensation: null,
    applicationUrl: null,
    officialUrl: "https://example.org/program",
    prepDays: null,
    rules: null,
    rulesFromPreviousCycle: null,
    isSample: false,
    ...fields,
  } as ProgramCard;
}

describe("format", () => {
  it("formats calendar dates from their parts, never through UTC midnight", () => {
    expect(formatDate("2027-01-15")).toBe("Fri 15 Jan 2027");
    expect(formatDate("2027-01-15", { weekday: false, year: false })).toBe("15 Jan");
    expect(formatDate("not a date")).toBe("not a date");
  });
  it("formats times, money, ages and lists", () => {
    expect(formatTime12("23:59")).toBe("11:59 PM");
    expect(formatTime12("12:00")).toBe("12:00 PM");
    expect(formatTime12("00:30")).toBe("12:30 AM");
    expect(formatMoney(750000)).toBe("$7,500");
    expect(formatMoney(1850)).toBe("$18.50");
    expect(relativeAge("2026-10-21", "2026-11-11")).toBe("3 weeks ago");
    expect(relativeAge("2026-11-10", "2026-11-11")).toBe("yesterday");
    expect(joinList(["a", "b", "c"])).toBe("a, b and c");
    expect(clampWords("one two three four", 2)).toBe("one two…");
  });
  it("counts days up and never below zero", () => {
    expect(daysUntil(NOW + 30 * 3_600_000, NOW)).toBe(2);
    expect(daysUntil(NOW - 1, NOW)).toBe(0);
  });
});

describe("describeDeadline", () => {
  it("shows exact deadlines in the official zone with the instant for the local-time island", () => {
    const d = describeDeadline(deadline({ localDate: "2026-12-01", localTime: "23:59" }), NOW);
    expect(d.primary).toBe("Tue 1 Dec 2026, 11:59 PM ET");
    expect(d.instantIso).toBe("2026-12-02T04:59:00.000Z");
    expect(d.daysLeft).toBe(21);
    expect(d.passed).toBe(false);
    expect(d.jsonLdDate).toBe("2026-12-01");
  });
  it("says when no time is stated and advises a day early, counting to the start of the day", () => {
    const d = describeDeadline(deadline({ precision: "date_only", localTime: null, localDate: "2026-11-20" }), NOW);
    expect(d.primary).toBe("Fri 20 Nov 2026, time not stated");
    expect(d.advice).toBe("Time not stated: plan to submit by Thu 19 Nov 2026.");
    expect(d.countdownAt).toBe(Date.parse("2026-11-20T05:00:00Z"));
    expect(d.instantIso).toBeNull();
    const london = describeDeadline(deadline({ precision: "date_only", localTime: null, localDate: "2026-11-20", timeZone: "Europe/London" }), NOW);
    expect(london.primary).toBe("Fri 20 Nov 2026 (UK time), time not stated");
  });
  it("resolves applicant-local deadlines on the viewer's clock, not the server's", () => {
    const d = describeDeadline(deadline({ tzMode: "applicant_local", timeZone: null }), NOW);
    expect(d.primary).toBe("Tue 1 Dec 2026, 11:59 PM your time zone");
    expect(d.instantIso).toBeNull();
    expect(d.applicantLocal).toEqual({ date: "2026-12-01", time: "23:59" });
  });
  it("handles month-only, window, rolling and undated rows", () => {
    expect(describeDeadline(deadline({ precision: "month_only", localDate: "2027-01", localTime: null }), NOW).primary).toBe(
      "Sometime in January 2027, day not stated",
    );
    const window = describeDeadline(
      deadline({ basis: "predicted", precision: "window", localDate: "2027-02-10", localTime: null, windowStart: "2027-02-01", windowEnd: "2027-02-20" }),
      NOW,
    );
    expect(window.primary).toBe("Expected around February 2027");
    expect(window.basisNote).toBe("Estimate from past cycles");
    expect(describeDeadline(deadline({ precision: "rolling", localDate: null, localTime: null }), NOW).primary).toBe("Rolling: apply early");
    expect(describeDeadline(deadline({ precision: "tbd", localDate: null, localTime: null }), NOW).primary).toBe("Date not announced yet");
  });
  it("marks a deadline that passed under 72 hours ago as checking for extensions", () => {
    const d = describeDeadline(deadline({ localDate: "2026-11-10", localTime: "12:00" }), NOW);
    expect(d.passed).toBe(true);
    expect(d.recentlyPassed).toBe(true);
    expect(describeStatus("open", d)).toEqual({ label: "Deadline passed: checking for extensions", tone: "late" });
  });
  it("leads cards with the next national submission deadline", () => {
    const c = card({
      deadlines: [
        deadline({ kind: "decision_expected", localDate: "2026-11-15" }),
        deadline({ kind: "application", localDate: "2026-12-05" }),
        deadline({ kind: "campus_internal", scope: "campus", localDate: "2026-11-20" }),
      ],
    });
    expect(nextDeadline(c, NOW)?.listDate).toBe("2026-12-05");
  });
});

describe("status, verification and money", () => {
  it("labels closing-soon, verified and stale records with words, not colour alone", () => {
    const soon = describeDeadline(deadline({ localDate: "2026-11-20" }), NOW);
    expect(describeStatus("open", soon).label).toBe("Open · closes soon");
    expect(describeVerification({ state: "verified", verifiedOn: "2026-11-04", verifiedBy: "Curator AB", freshness: "fresh" }, "2026-11-11").label).toBe(
      "Verified 4 Nov 2026",
    );
    expect(describeVerification({ state: "stale", verifiedOn: "2026-06-01", verifiedBy: null, freshness: "stale" }, "2026-11-11").tone).toBe("late");
  });
  it("writes pay and cost plainly", () => {
    expect(compensationText({ kind: "stipend", amountCents: 600000, period: "total", note: null } as never)).toBe("Stipend $6,000 in total");
    expect(compensationText(null)).toBeNull();
    expect(costText({ applicationFeeCents: null, participantCostCents: null })).toBe("No cost to apply");
    expect(costText({ applicationFeeCents: 2500, participantCostCents: null })).toBe("Application fee $25");
    expect(classYearText(["first_year", "second_year"])).toBe("First- and second-years");
  });
});

describe("seo", () => {
  it("escapes data blocks so no script can be closed or broken", () => {
    const out = jsonForScript({ name: "</script><img src=x onerror=alert(1)>", line: "a\u2028b\u2029c", amp: "&" });
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toEqual({ name: "</script><img src=x onerror=alert(1)>", line: "a\u2028b\u2029c", amp: "&" });
  });
  it("cuts descriptions at a word boundary and titles programs by cycle", () => {
    const long = "word ".repeat(60);
    const cut = metaDescription(long);
    expect(cut.length).toBeLessThanOrEqual(160);
    expect(cut.endsWith("…")).toBe(true);
    expect(programTitle("Example Program", "Summer 2027")).toBe("Example Program Summer 2027: deadlines, eligibility and requirements | Novus");
  });
});

describe("tokens and assets", () => {
  it("meets WCAG contrast for every listed text and surface pair", () => {
    for (const pair of PAGE_CONTRAST_PAIRS) {
      expect(contrastRatio(PAGE_TOKENS[pair.fg], PAGE_TOKENS[pair.bg]), `${pair.fg} on ${pair.bg}`).toBeGreaterThanOrEqual(pair.min);
    }
  });
  it("serves assets from content-hashed paths", () => {
    expect(assetPath("site.css")).toMatch(/^\/p\/site\.[0-9a-f]{8}\.css$/);
    expect(assetForPath(assetPath("landing.js"))?.current).toBe(true);
    expect(assetForPath("/p/landing.deadbeef.js")?.current).toBe(false);
    expect(assetForPath("/p/../secrets.js")).toBeUndefined();
    expect(contentHash("a")).not.toBe(contentHash("b"));
  });
  it("ships scripts that parse and that never store or send anything", () => {
    for (const src of [PAGE_JS, LANDING_JS]) {
      expect(() => new Function(src)).not.toThrow();
      expect(src).not.toMatch(/localStorage|sessionStorage|document\.cookie|fetch\(|XMLHttpRequest|sendBeacon/);
    }
  });
});

describe("text files", () => {
  const real = card({ name: "Real [Program]\nName" });
  const sample = card({ isSample: true });
  it("blocks training crawlers in production and everything elsewhere", () => {
    const prod = robotsTxt("https://novus.example.org", true);
    for (const bot of ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended"]) expect(prod).toContain(`User-agent: ${bot}\nDisallow: /`);
    expect(robotsTxt("https://novus.example.org", false)).toBe("User-agent: *\nDisallow: /\n");
  });
  it("lists real programs with their verification date and never sample ones", () => {
    const xml = sitemapXml("https://novus.example.org", [real, sample], NOW);
    expect(xml).toContain(`/programs/${real.slug}</loc><lastmod>2026-11-01</lastmod>`);
    expect(xml).not.toContain(sample.slug);
    const llms = llmsTxt("https://novus.example.org", [real, sample], NOW);
    expect(llms).toContain("[Real Program Name]");
    expect(llms).not.toContain(sample.slug);
  });
});

describe("landing helpers", () => {
  it("names the season", () => {
    expect(seasonLabel("2026-11-11")).toBe("Fall 2026");
    expect(seasonLabel("2027-01-05")).toBe("Winter 2027");
    expect(seasonLabel("2027-04-01")).toBe("Spring 2027");
    expect(seasonLabel("2027-07-01")).toBe("Summer 2027");
  });
  it("never features a program for a sensitive audience, and prefers one with a private question", () => {
    const rule = (id: string, sensitive: boolean) => ({ id, officialText: id, sensitive }) as never;
    const rules = (list: never[]) => ({ rules: list }) as never;
    const health = card({ flags: { ...card().flags, sensitiveAudience: true }, rules: rules([rule("h", true)]) });
    const plain = card({ rules: rules([rule("p1", false)]) });
    const priv = card({ rules: rules([rule("a", false), rule("b", false), rule("c", false), rule("lock", true)]) });
    expect(featuredProgram([health, plain, priv], NOW)?.slug).toBe(priv.slug);
    expect(featuredProgram([health], NOW)).toBeNull();
    expect(featuredRules(priv).map((r) => r.id)).toEqual(["a", "b", "lock"]);
  });
  it("measures the application window in days, never as a percentage", () => {
    expect(windowSpan("2026-10-01", "2026-12-01", NOW)).toEqual({ fraction: 41 / 61, day: 41, total: 61 });
    expect(windowSpan("2026-10-01", "2026-12", NOW)).toBeNull();
    expect(windowSpan(null, "2026-12-01", NOW)).toBeNull();
  });
});

describe("explore and deadlines queries", () => {
  it("parses and clamps query parameters", () => {
    expect(parseExploreQuery(new URLSearchParams("q=%20lab%20&group=research&status=open&paid=1"))).toEqual({
      q: "lab",
      group: "research",
      status: "open",
      paid: true,
      free: false,
    });
    expect(parseExploreQuery(new URLSearchParams("group=nope&status=weird")).group).toBeNull();
    expect(parseRange("30")).toBe(30);
    expect(parseRange("7")).toBe(90);
  });
  it("lists only official national submission deadlines that have not passed", () => {
    const c = card({
      deadlines: [
        deadline({ localDate: "2026-11-01" }),
        deadline({ localDate: "2026-11-25" }),
        deadline({ basis: "predicted", localDate: "2026-11-26" }),
        deadline({ scope: "campus", kind: "campus_internal", localDate: "2026-11-24" }),
      ],
    });
    expect(upcomingDeadlines([c], NOW, 30).map((r) => r.d.listDate)).toEqual(["2026-11-25"]);
    expect(upcomingDeadlines([card({ status: "paused" })], NOW, 30)).toEqual([]);
  });
});

describe("browser cache policy", () => {
  it("overrides Cache-Control on success only", async () => {
    const app = new Hono();
    app.get("/ok", browserCache("private"), (c) => c.text("ok", 200, { "cache-control": "public, max-age=60" }));
    app.get("/err", browserCache("private"), (c) => c.text("no", 503, { "cache-control": "no-store" }));
    expect((await app.request("/ok")).headers.get("cache-control")).toBe("no-store");
    expect((await app.request("/err")).headers.get("cache-control")).toBe("no-store");
  });
});

describe("release reader", () => {
  it("publishes the browser pointer and survives a missing or corrupt release", async () => {
    expect(publicPointer({ release: 3, path: "releases/3/client-core.json", sha256: "b", publishedAt: "2026-11-11T00:00:00Z" }).path).toBe(
      "/data/client-core/3.json",
    );
    const corrupt: ReleaseBucket = { get: async (key) => (key === RELEASE_POINTER_KEY ? { text: async () => "{not json" } : null) };
    await expect(releasePageData(corrupt).listCards(NOW)).rejects.toThrow("no published release");
    const empty: ReleaseBucket = { get: async () => null };
    await expect(releasePageData(empty).resolveSlug("x")).rejects.toThrow();
  });
});
