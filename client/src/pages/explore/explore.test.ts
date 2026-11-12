import { describe, expect, it } from "vitest";
import { sampleProgramCards } from "@/lib/fixtures/programs";
import { activeFilterCount, applyFilters, DEFAULT_FILTERS, groupCounts, parseFilters, serializeFilters } from "./filters";
import { buildProgramIndex, expandQuery, searchPrograms } from "./search";

const NOW = Date.parse("2026-11-11T15:00:00Z");
const cards = sampleProgramCards(NOW);
const index = buildProgramIndex(cards);
const slugsFor = (ids: readonly string[]) => ids.map((id) => cards.find((c) => c.programCycleId === id)?.slug);

describe("search", () => {
  it("finds by name, organization and tag, best match first", () => {
    expect(slugsFor(searchPrograms(index, "coastal"))[0]).toBe("sample-coastal-research-scholars");
    expect(slugsFor(searchPrograms(index, "lumen"))).toContain("sample-software-sophomore-internship");
    expect(slugsFor(searchPrograms(index, "open source"))[0]).toBe("sample-open-source-sprint");
  });

  it("tolerates typos and prefixes", () => {
    expect(slugsFor(searchPrograms(index, "conservaton"))).toContain("sample-conservation-crews");
    expect(slugsFor(searchPrograms(index, "apprent"))).toContain("sample-tech-apprenticeship");
  });

  it("expands shorthand students type", () => {
    expect(expandQuery("REU")).toMatch(/research/);
    expect(slugsFor(searchPrograms(index, "reu"))).toContain("sample-summer-lab-research");
    expect(slugsFor(searchPrograms(index, "sprintship"))).toContain("sample-open-source-sprint");
  });

  it("returns nothing for an empty query", () => {
    expect(searchPrograms(index, "   ")).toEqual([]);
  });
});

describe("filters", () => {
  it("round-trips through the URL and drops defaults", () => {
    const f = { ...DEFAULT_FILTERS, q: "lab", group: "research" as const, paid: true };
    const qs = serializeFilters(f);
    expect(qs).toBe("?q=lab&group=research&paid=1");
    expect(parseFilters(qs)).toEqual(f);
    expect(serializeFilters(DEFAULT_FILTERS)).toBe("");
    expect(parseFilters("?group=not-a-group").group).toBe("all");
    expect(activeFilterCount(f)).toBe(2);
  });

  it("counts groups that have programs", () => {
    const groups = groupCounts(cards);
    expect(groups.find((g) => g.group === "research")?.count).toBeGreaterThanOrEqual(2);
    expect(groups.every((g) => g.count > 0)).toBe(true);
  });

  it("filters by group, pay, status and year, soonest first", () => {
    const ctx = { profile: { classYear: "first_year" as const, majorFamily: null, timeZone: "America/New_York" }, now: NOW, searchHits: null };
    const research = applyFilters(cards, { ...DEFAULT_FILTERS, group: "research" }, ctx);
    expect(research.length).toBeGreaterThan(0);
    const open = applyFilters(cards, { ...DEFAULT_FILTERS, openNow: true }, ctx);
    expect(open.every((c) => c.status === "open")).toBe(true);
    expect(open[0]?.slug).toBe("sample-early-insight-week");
    const paid = applyFilters(cards, { ...DEFAULT_FILTERS, paid: true }, ctx);
    expect(paid.every((c) => c.flags.paid)).toBe(true);
    const mine = applyFilters(cards, { ...DEFAULT_FILTERS, openToMyYear: true }, ctx);
    expect(mine.every((c) => c.classYears.length === 0 || c.classYears.includes("first_year"))).toBe(true);
  });

  it("keeps search rank order when there is a query", () => {
    const hits = searchPrograms(index, "research");
    const result = applyFilters(cards, DEFAULT_FILTERS, { profile: null, now: NOW, searchHits: hits });
    expect(result.map((c) => c.programCycleId)).toEqual(hits.filter((id) => result.some((c) => c.programCycleId === id)));
  });
});
