import { describe, expect, it } from "vitest";
import { FIRST_REVEAL, applyFilters, categoriesPresent, categorySlugs, tierCounts, toggleIn, visibleMatches, type MatchFacts } from "./filters";
import type { MatchView } from "./normalize";
import { EMPTY_FILTERS } from "./storage";
import { compensationLabel, experiencePhrase, feasibilityLine, lowerFirst, requirementsLine, shortDate, yearLabel } from "./wording";

const m = (programId: string, tier: MatchView["tier"]): MatchView => ({
  programId,
  tier,
  reasons: [],
  startBy: null,
  daysLeft: null,
  enoughTime: true,
  met: 0,
  total: 0,
  missing: [],
  feasibilityLabel: null,
  evidence: [],
  name: null,
  organizationName: null,
});

const FACTS: Record<string, MatchFacts> = {
  a: { types: ["summer_internship"], paid: true, remote: true },
  b: { types: ["research_program"], paid: true, remote: false },
  c: { types: ["national_scholarship"], paid: false, remote: true },
};
const facts = (id: string) => FACTS[id];
const list = [m("a", "strong"), m("b", "good"), m("c", "stretch"), m("z", "good")];

describe("filters", () => {
  it("narrows without re-ranking", () => {
    expect(applyFilters(list, EMPTY_FILTERS, facts).map((x) => x.programId)).toEqual(["a", "b", "c", "z"]);
    expect(applyFilters(list, { ...EMPTY_FILTERS, tiers: ["good"] }, facts).map((x) => x.programId)).toEqual(["b", "z"]);
    expect(applyFilters(list, { ...EMPTY_FILTERS, paidOnly: true }, facts).map((x) => x.programId)).toEqual(["a", "b", "z"]);
    expect(applyFilters(list, { ...EMPTY_FILTERS, remoteOnly: true }, facts).map((x) => x.programId)).toEqual(["a", "c", "z"]);
    expect(applyFilters(list, { ...EMPTY_FILTERS, types: ["research"] }, facts).map((x) => x.programId)).toEqual(["b", "z"]);
  });

  it("expands categories to type slugs and passes single slugs through", () => {
    expect(categorySlugs("sprints")).toEqual(["sprinternship"]);
    expect(categorySlugs("summer_internship")).toEqual(["summer_internship"]);
  });

  it("lists only categories present, in taxonomy order", () => {
    expect(categoriesPresent(list, facts)).toEqual(["internships", "research", "scholarships"]);
  });

  it("counts tiers and reveals three first", () => {
    expect(tierCounts(list)).toEqual({ strong: 1, good: 2, stretch: 1 });
    expect(visibleMatches(list, false)).toHaveLength(FIRST_REVEAL);
    expect(visibleMatches(list, true)).toHaveLength(4);
    expect(toggleIn(["a"], "a")).toEqual([]);
    expect(toggleIn(["a"], "b")).toEqual(["a", "b"]);
  });
});

describe("wording", () => {
  it("formats dates in UTC regardless of zone", () => {
    expect(shortDate("2026-12-02")).toBe("Wed 2 Dec");
    expect(shortDate(null)).toBe("");
    expect(shortDate("soon")).toBe("");
  });

  it("describes feasibility with counts and dates only", () => {
    expect(feasibilityLine({ startBy: "2026-12-02", daysLeft: 45, enoughTime: true })).toBe("Start by Wed 2 Dec · 45 days left");
    expect(feasibilityLine({ startBy: "2026-11-10", daysLeft: 1, enoughTime: false })).toBe("Tight timeline: closes in 1 day");
    expect(feasibilityLine({ startBy: null, daysLeft: null, enoughTime: true })).toBe("Rolling: apply any time");
  });

  it("says requirements as counts", () => {
    expect(requirementsLine(3, 5)).toBe("You meet 3 of 5 listed requirements.");
    expect(requirementsLine(2, 2)).toBe("You already have everything listed (2 of 2).");
    expect(requirementsLine(0, 0)).toBe("");
  });

  it("labels pay", () => {
    expect(compensationLabel({ compensation: { kind: "stipend", amountCents: 600000, period: "total" } })).toBe("Stipend · $6,000");
    expect(compensationLabel({ compensation: { kind: "salary_hourly", amountCents: 2000, period: "hour" } })).toBe("Paid · $20 an hour");
    expect(compensationLabel({ compensation: { kind: "travel", amountCents: null, period: null, note: "Travel covered" } })).toBe("Travel covered");
    expect(compensationLabel({ compensation: null })).toBe("");
  });

  it("names years and experience kinds", () => {
    expect(yearLabel(1)).toBe("a first-year");
    expect(yearLabel(9)).toBe("a fifth-year");
    expect(experiencePhrase(["unknown", "club"])).toBe("a club or team");
    expect(experiencePhrase([])).toBeNull();
    expect(lowerFirst("Climate and environment")).toBe("climate and environment");
    expect(lowerFirst("AI and data")).toBe("AI and data");
  });
});
