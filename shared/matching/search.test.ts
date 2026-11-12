import { describe, expect, it } from "vitest";
import { SearchHitSchema } from "../contracts/api";
import { ProgramCardSchema, ReleaseArtifactSchema } from "../contracts/registry";
import { aliasExpansions } from "./aliases";
import { SAMPLE_CARDS, SAMPLE_NOW, sampleCardBySlug } from "./fixtures/sample-cards";
import { buildIndex, filterCards, nextDeadlineDate, search, searchIds, toSearchHit } from "./search";

const index = buildIndex(SAMPLE_CARDS);
const id = (slug: string) => sampleCardBySlug(slug).programCycleId;
const slugsOf = (query: string, limit = 10) => search(index, query, { limit, now: SAMPLE_NOW }).map((r) => r.card.slug);

describe("sample fixtures", () => {
  it("are valid ProgramCards and all labelled sample", () => {
    for (const card of SAMPLE_CARDS) {
      expect(() => ProgramCardSchema.parse(card)).not.toThrow();
      expect(card.isSample).toBe(true);
      expect(card.officialUrl.startsWith("https://example.org/")).toBe(true);
    }
  });
});

describe("buildIndex", () => {
  it("accepts a release artifact and keeps its release number", () => {
    const artifact = ReleaseArtifactSchema.parse({
      v: 1,
      release: 42,
      generatedAt: "2026-11-11T12:00:00Z",
      cards: SAMPLE_CARDS,
      merged: {},
      containsSample: true,
    });
    const fromRelease = buildIndex(artifact);
    expect(fromRelease.release).toBe(42);
    expect(fromRelease.cards.size).toBe(SAMPLE_CARDS.length);
  });

  it("ignores a duplicate cycle instead of throwing", () => {
    const dup = buildIndex([...SAMPLE_CARDS, SAMPLE_CARDS[0] as (typeof SAMPLE_CARDS)[number]]);
    expect(dup.cards.size).toBe(SAMPLE_CARDS.length);
  });
});

describe("search", () => {
  it("finds a program by an acronym in its name or aliases", () => {
    expect(slugsOf("reu")[0]).toBe("coastal-ecology-reu");
    expect(slugsOf("surf")[0]).toBe("granite-surf-fellowship");
  });

  it("tolerates a typo in a longer word", () => {
    expect(slugsOf("meridan scholarship")).toContain("meridian-undergraduate-scholarship");
    expect(slugsOf("hackathn")).toContain("riverside-civic-hackathon");
  });

  it("matches prefixes of partially typed words", () => {
    expect(slugsOf("apprentice")).toContain("keystone-software-apprenticeship");
    expect(slugsOf("fello")).toContain("lattice-ml-fellowship");
  });

  it("puts all-words matches before any-word matches", () => {
    const results = slugsOf("summit bank technology");
    expect(results[0]).toBe("summit-technology-internship");
  });

  it("expands generic aliases on whole tokens only", () => {
    expect(aliasExpansions("sprintship")).toContain("sprinternship sprint");
    expect(aliasExpansions("physics")).toEqual([]);
    expect(aliasExpansions("spring week london")[0]).toContain("spring week");
    const sprints = slugsOf("sprintship");
    expect(sprints).toEqual(expect.arrayContaining(["harbor-data-sprint", "summit-markets-sprint"]));
  });

  it("does not fuzzy-match very short terms", () => {
    // "ai" with fuzzy would hit many words; it should match nothing in this fixture set.
    expect(slugsOf("zq")).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(search(index, "   ")).toEqual([]);
  });

  it("returns integer positions, codes and terms, and no relevance value", () => {
    const results = search(index, "research", { limit: 5, now: SAMPLE_NOW });
    expect(results.length).toBeGreaterThan(0);
    results.forEach((r, i) => {
      expect(r.rank).toBe(i);
      expect(Object.keys(r).sort()).toEqual(["card", "matchedTerms", "rank", "whyShown"]);
      expect(r.whyShown.length).toBeGreaterThan(0);
    });
  });

  it("names the field that matched", () => {
    const [top] = search(index, "Example Lumen Institute", { now: SAMPLE_NOW });
    expect(top?.card.slug).toBe("lumen-language-fellowship");
    expect(top?.whyShown.map((w) => w.code)).toContain("ORG_MATCH");
  });

  it("pages with offset and keeps absolute positions", () => {
    const all = search(index, "program", { limit: 20, now: SAMPLE_NOW });
    const page2 = search(index, "program", { limit: 2, offset: 2, now: SAMPLE_NOW });
    expect(page2.map((r) => r.card.slug)).toEqual(all.slice(2, 4).map((r) => r.card.slug));
    expect(page2.map((r) => r.rank)).toEqual([2, 3]);
  });

  it("serializes to the SearchHit wire schema", () => {
    for (const r of search(index, "summit", { now: SAMPLE_NOW })) {
      const hit = toSearchHit(r);
      expect(() => SearchHitSchema.parse(hit)).not.toThrow();
      expect(hit.whyShown.every((w) => w.length <= 60)).toBe(true);
    }
  });

  it("fuses a dense ranking by RRF when one is given (Phase 3 path)", () => {
    const dense = [id("prairie-service-year"), id("civic-leaders-fellowship")];
    const fused = search(index, "civic", { denseRanking: dense, now: SAMPLE_NOW, limit: 10 }).map((r) => r.card.slug);
    expect(fused).toContain("prairie-service-year");
    expect(fused[0]).toBe("civic-leaders-fellowship"); // in both legs
  });

  it("searchIds returns ids only", () => {
    expect(searchIds(index, "reu", 3)[0]).toBe(id("coastal-ecology-reu"));
  });
});

describe("filters", () => {
  const ctx = { now: SAMPLE_NOW, timeZone: "America/New_York" };

  it("filters by type, category and group", () => {
    expect(slugsOf("summit").length).toBeGreaterThan(1);
    const sprints = search(index, "summit", { filters: { types: ["sprinternship"] }, now: SAMPLE_NOW }).map((r) => r.card.slug);
    expect(sprints).toEqual(["summit-markets-sprint"]);
    const insight = filterCards(SAMPLE_CARDS, { categories: ["insight_weeks"] }, ctx).map((c) => c.slug);
    expect(insight).toEqual(expect.arrayContaining(["summit-insight-week", "helix-biotech-discovery", "thames-markets-spring-week"]));
    const research = filterCards(SAMPLE_CARDS, { groups: ["research"] }, ctx).map((c) => c.slug);
    expect(research).toContain("open-source-season");
  });

  it("keeps cards open to every class year or major under those filters", () => {
    const fy = filterCards(SAMPLE_CARDS, { classYears: ["first_year"] }, ctx).map((c) => c.slug);
    expect(fy).toContain("lattice-ml-fellowship"); // no class-year restriction
    expect(fy).not.toContain("summit-sophomore-analyst");
    const bio = filterCards(SAMPLE_CARDS, { majorFamilies: ["life_sciences"] }, ctx).map((c) => c.slug);
    expect(bio).toContain("cedar-undergraduate-research-grant"); // open to all majors
    expect(bio).not.toContain("harbor-data-sprint");
  });

  it("filters paid, no-cost and status", () => {
    expect(filterCards(SAMPLE_CARDS, { paid: true }, ctx).every((c) => c.flags.paid)).toBe(true);
    expect(filterCards(SAMPLE_CARDS, { statuses: ["expected"] }, ctx).map((c) => c.slug).sort()).toEqual(["civic-leaders-fellowship", "open-source-season"]);
  });

  it("filters by the next deadline in the viewer's zone", () => {
    const dec = filterCards(SAMPLE_CARDS, { deadlineAfter: "2026-12-01", deadlineBefore: "2026-12-31" }, ctx).map((c) => c.slug);
    expect(dec).toEqual(expect.arrayContaining(["summit-insight-week", "keystone-software-apprenticeship", "summit-markets-sprint"]));
    expect(dec).not.toContain("harbor-data-sprint");
    expect(dec).not.toContain("pivot-micro-internships"); // no dated deadline
  });

  it("reads a month-only deadline as the end of that month", () => {
    expect(nextDeadlineDate(sampleCardBySlug("thames-markets-spring-week"), ctx)).toBe("2027-01-31");
  });
});
