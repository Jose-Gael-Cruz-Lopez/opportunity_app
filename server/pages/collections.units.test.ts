import { describe, expect, it } from "vitest";
import type { ProgramCard } from "@shared/contracts";
import { accuracyText, AUDIT_SCHEDULE, findReport, latestReport, milestoneState, plannedPublication, REPORT_ID, totalOf, wilsonInterval, type AuditReport } from "./audit";
import { renderDocument, type SiteContext } from "./components/layout";
import { collectionCounts } from "./components/collection";
import { toPublicList } from "./data";
import { allHubKeys, availableHubs, HUB_MIN_VERIFIED, hubAvailable, hubIndexable, hubPath, parseHubParam, subtypeCounts, verifiedCount } from "./hubs";
import { robotsTxt, sitemapXml } from "./text";
import { AuditPage } from "./views/audit";
import { NOT_COVERED, WORKFLOW_STEPS } from "./views/methods";
import { PLEDGE_ITEMS } from "./views/pledge";

const NOW = Date.parse("2026-11-11T15:00:00Z");
const ORIGIN = "https://novus.example.org";
const SITE: SiteContext = { origin: ORIGIN, indexable: true, containsSample: false, year: 2026, notice: null };

let seq = 0;
/** A minimal valid card; `opportunityTypes` and verification are what hubs read. */
function card(fields: Partial<ProgramCard> = {}): ProgramCard {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return {
    programId: id,
    programCycleId: id.replace(/^0/, "1"),
    slug: `program-${seq}`,
    cycleKey: "2027",
    name: `Program ${seq}`,
    organizationName: "Example Org",
    summary: null,
    opportunityTypes: ["research_program"],
    status: "open",
    verification: { state: "verified", verifiedOn: "2026-11-01", verifiedBy: "curator-a", freshness: "fresh" },
    deadlines: [],
    opensOn: null,
    prediction: null,
    classYears: ["first_year", "second_year"],
    majorFamilies: [],
    cipPrefixes: [],
    interestTags: [],
    aliases: [],
    flags: { sensitiveAudience: false, identityAudience: [], nominationRequired: false, inSeason: true, isWedge: false },
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

const many = (n: number, fields: Partial<ProgramCard> = {}): ProgramCard[] => Array.from({ length: n }, () => card(fields));

describe("type hub keys", () => {
  it("parses families and types in hyphen form and flags other spellings for a 301", () => {
    expect(parseHubParam("research")).toEqual({ key: { kind: "group", group: "research" }, canonical: true });
    expect(parseHubParam("early-career")).toEqual({ key: { kind: "group", group: "early_career" }, canonical: true });
    expect(parseHubParam("early_career")).toEqual({ key: { kind: "group", group: "early_career" }, canonical: false });
    expect(parseHubParam("Research-Program")).toEqual({ key: { kind: "type", type: "research_program" }, canonical: false });
    expect(parseHubParam("research-program")?.canonical).toBe(true);
  });

  it("has no hub for the catch-all family, out-of-scope types or unknown names", () => {
    for (const raw of ["other", "campus-ambassador", "gap-year", "high-school-pathway", "nope", "", "a/b", "x".repeat(65)]) expect(parseHubParam(raw), raw).toBeNull();
  });

  it("gives every hub a unique hyphenated path", () => {
    const paths = allHubKeys().map(hubPath);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(p).toMatch(/^\/types\/[a-z0-9-]+$/);
  });
});

describe("type hub bar", () => {
  const research = { kind: "group", group: "research" } as const;

  it("exists only at HUB_MIN_VERIFIED verified programs", () => {
    expect(HUB_MIN_VERIFIED).toBe(10);
    expect(hubAvailable(many(9), research, NOW)).toBe(false);
    expect(hubAvailable(many(10), research, NOW)).toBe(true);
  });

  it("does not count unverified, stale or re-checking programs", () => {
    const cards = [
      ...many(9),
      card({ verification: { state: "unverified", verifiedOn: null, verifiedBy: null, freshness: "stale" } }),
      card({ verification: { state: "stale", verifiedOn: "2025-01-01", verifiedBy: "c", freshness: "stale" } }),
      card({ verification: { state: "reverifying", verifiedOn: "2026-10-01", verifiedBy: "c", freshness: "fresh" } }),
    ];
    expect(verifiedCount(cards)).toBe(9);
    expect(hubAvailable(cards, research, NOW)).toBe(false);
  });

  it("is indexable only when real programs alone pass", () => {
    const mixed = [...many(6), ...many(6, { isSample: true })];
    expect(hubAvailable(mixed, research, NOW)).toBe(true);
    expect(hubIndexable(mixed, research, NOW)).toBe(false);
    expect(availableHubs(mixed, NOW, { indexableOnly: true })).toEqual([]);
    expect(hubIndexable(many(10), research, NOW)).toBe(true);
  });

  it("counts a type hub over its own type and a family over all its types", () => {
    const cards = [...many(6, { opportunityTypes: ["research_program"] }), ...many(4, { opportunityTypes: ["pipeline_program"] })];
    expect(hubAvailable(cards, research, NOW)).toBe(true);
    expect(hubAvailable(cards, { kind: "type", type: "research_program" }, NOW)).toBe(false);
    expect(subtypeCounts(cards, research)).toEqual([
      { type: "research_program", label: "Research programs (REU, SURF, labs)", count: 6 },
      { type: "pipeline_program", label: "Pre-professional and PhD pipelines", count: 4 },
    ]);
  });

  it("lists only indexable hubs in the sitemap", () => {
    const xml = sitemapXml(ORIGIN, many(10), NOW);
    expect(xml).toContain(`<loc>${ORIGIN}/types/research</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/types/research-program</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/pledge</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/research/ai-deadline-audit</loc>`);
    expect(sitemapXml(ORIGIN, many(10, { isSample: true }), NOW)).not.toContain("/types/");
  });

  it("keeps unlisted list links out of crawlers' reach", () => {
    expect(robotsTxt(ORIGIN, true)).toContain("Disallow: /lists/u/");
  });
});

describe("collection counts", () => {
  it("counts listed, verified, open and closing programs", () => {
    const counts = collectionCounts([card(), card({ status: "closed" }), card({ verification: { state: "draft", verifiedOn: null, verifiedBy: null, freshness: "stale" } })], NOW);
    expect(counts).toEqual({ listed: 3, verified: 2, open: 2, closingSoon: 0 });
  });
});

describe("public lists", () => {
  it("keeps the advisor's order, drops unpublished programs and marks a pinned older cycle", () => {
    const a = card({ slug: "alpha", cycleKey: "2027" });
    const b = card({ slug: "beta", cycleKey: "2027" });
    const list = toPublicList(
      {
        id: "00000000-0000-4000-8000-000000009999",
        title: "Sample picks",
        description: null,
        visibility: "public",
        slug: "sample-picks-abc123",
        token: null,
        restricted: false,
        updatedAt: "2026-11-10T12:00:00.000Z",
        items: [
          { programSlug: "beta", cycleKey: "2026", note: "Start early", position: 1 },
          { programSlug: "gone", cycleKey: null, note: null, position: 0 },
          { programSlug: "alpha", cycleKey: "2027", note: null, position: 2 },
        ],
      },
      [a, b],
    );
    expect(list.entries.map((e) => e.card.slug)).toEqual(["beta", "alpha"]);
    expect(list.entries[0]).toMatchObject({ note: "Start early", cycleKey: "2026" });
    expect(list.entries[1]?.cycleKey).toBeNull();
    expect(Object.keys(list)).not.toContain("workspaceId");
    expect(Object.keys(list)).not.toContain("token");
  });
});

describe("audit statistics", () => {
  it("matches the plan's worked Wilson example (45 of 50 is 79 to 96%)", () => {
    const { low, high } = wilsonInterval(45, 50);
    expect(low).toBeCloseTo(0.786, 3);
    expect(high).toBeCloseTo(0.957, 3);
    expect(accuracyText(45, 50)).toBe("45 of 50 (90%; 95% interval 79 to 96%)");
  });

  it("stays inside [0, 1] at the edges and refuses impossible counts", () => {
    expect(wilsonInterval(0, 50).low).toBe(0);
    expect(wilsonInterval(50, 50).high).toBe(1);
    expect(wilsonInterval(5, 0)).toEqual({ low: 0, high: 0 });
    expect(wilsonInterval(6, 5)).toEqual({ low: 0, high: 0 });
    expect(accuracyText(0, 0)).toBe("no answers scored");
  });

  it("orders the schedule and publishes on 27 Jan 2027", () => {
    const dates = AUDIT_SCHEDULE.map((m) => m.start);
    expect([...dates].sort()).toEqual(dates);
    for (const m of AUDIT_SCHEDULE) expect(m.end >= m.start).toBe(true);
    expect(plannedPublication()).toBe("2027-01-27");
    expect(milestoneState(AUDIT_SCHEDULE[0]!, "2026-11-11")).toBe("planned");
    expect(milestoneState({ start: "2027-01-05", end: "2027-01-09", label: "", detail: "" }, "2027-01-07")).toBe("now");
    expect(milestoneState({ start: "2027-01-05", end: "2027-01-09", label: "", detail: "" }, "2027-01-10")).toBe("done");
  });

  it("publishes no results before the first report", () => {
    expect(latestReport()).toBeNull();
    expect(findReport("2027-01")).toBeNull();
    expect(REPORT_ID.test("2027-01")).toBe(true);
    expect(REPORT_ID.test("2027-13")).toBe(false);
  });
});

describe("audit report rendering", () => {
  const sample: AuditReport = {
    id: "2027-01",
    title: "Sample AI deadline audit",
    publishedOn: "2027-01-27",
    sampleSize: 50,
    arms: [
      { assistant: "Sample Assistant A", arm: "Main (free tier)", plan: "Free", modelLabel: "default", correct: 30, partlyCorrect: 8, incorrect: 9, noAnswer: 3, unsupportedCitations: 4 },
      { assistant: "Novus", arm: "Novus's own published deadlines", plan: "n/a", modelLabel: "n/a", correct: 48, partlyCorrect: 1, incorrect: 1, noAnswer: 0, unsupportedCitations: 0 },
    ],
    kappa: 0.87,
    pooledNovusAccuracy: { correct: 49, n: 50, window: "December 2026" },
    limitations: ["Sample limitation text."],
    evidenceUrl: null,
    isSample: true,
  };

  it("leads with an accessible table, labels sample numbers and is never indexed", () => {
    expect(sample.arms.map(totalOf)).toEqual([50, 50]);
    const html = renderDocument(AuditPage({ model: { report: sample, path: "/research/ai-deadline-audit/2027-01", now: NOW }, site: SITE }));
    expect(html).toContain("<table");
    expect(html).toContain('<th scope="col">Correct</th>');
    expect(html).toContain("30 of 50 (60%; 95% interval");
    expect(html).toContain("Cohen&#39;s kappa 0.87");
    expect(html).toContain("invented numbers");
    expect(html).toContain('content="noindex, nofollow"');
    expect(html).not.toContain("application/ld+json");
    expect(html.indexOf("<table")).toBeLessThan(html.indexOf('id="protocol"'));
  });

  it("shows the plan and no results before publication", () => {
    const html = renderDocument(AuditPage({ model: { report: null, path: "/research/ai-deadline-audit", now: NOW }, site: SITE }));
    expect(html).toContain("No results are published yet");
    expect(html).not.toContain("<table");
    expect(html).toContain("27 Jan 2027");
    expect(html).toContain('content="index, follow"');
  });
});

describe("editorial content", () => {
  it("keeps the pledge at nine promises with unique anchors", () => {
    expect(PLEDGE_ITEMS).toHaveLength(9);
    expect(new Set(PLEDGE_ITEMS.map((p) => p.id)).size).toBe(9);
  });

  it("names the workflow steps and the types Novus does not cover", () => {
    expect(WORKFLOW_STEPS.length).toBeGreaterThanOrEqual(6);
    expect(NOT_COVERED).toEqual(["Gap-year programs", "High-school-senior pathways"]);
  });
});
