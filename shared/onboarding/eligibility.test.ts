import { describe, expect, it } from "vitest";
import { ELIGIBILITY_DIMENSIONS, type EligibilityRule, type EligibilityRuleSet } from "../contracts/eligibility";
import { EMPTY_STUDENT_PROFILE, type StudentProfile } from "../contracts/student";
import { defaultEligibility, engineEligibility, facetEligibility, toChecks } from "./eligibility";
import { findMatches } from "./match";
import { makeCard, makePreferences } from "./testing";

const NOW = "2026-11-11T15:00:00Z";
const TODAY = "2026-11-11";

const firstYear: StudentProfile = { ...EMPTY_STUDENT_PROFILE, classYear: "first_year" };
const noYear: StudentProfile = { ...EMPTY_STUDENT_PROFILE };

function standing(years: readonly string[], text: string): EligibilityRule {
  return {
    id: "standing",
    dimension: "standing",
    group: "all",
    logic: { in: [{ var: "classYear" }, [...years]] },
    fields: ["classYear"],
    sensitive: false,
    asOf: "today",
    borderline: [],
    officialText: text,
    evidenceKey: null,
  };
}

/** A verified SAMPLE rule set with every dimension reviewed, so only the given rules decide. */
function verified(cycleId: string, rules: readonly EligibilityRule[]): EligibilityRuleSet {
  const coverage = Object.fromEntries(ELIGIBILITY_DIMENSIONS.map((d) => [d, rules.some((r) => r.dimension === d) ? "encoded" : "no_restriction"]));
  return {
    id: "00000000-0000-4000-8000-0000000e1100",
    programCycleId: cycleId,
    version: 1,
    format: "jsonlogic-v1",
    state: "verified",
    templateKey: null,
    coverage: coverage as EligibilityRuleSet["coverage"],
    rules: [...rules],
    anyOf: [],
    attestations: [],
    nomination: null,
    evidence: {},
    hash: "b".repeat(64),
    createdVia: "sample",
    verifiedAt: "2026-11-01T00:00:00.000Z",
    verifiedBy: "Sample Curator",
    fromCycleKey: null,
  };
}

function cardWith(rules: (cycleId: string) => EligibilityRuleSet | null, classYears: StudentProfile["classYear"][] = []) {
  const card = makeCard({ today: TODAY, classYears: classYears.filter((y): y is NonNullable<typeof y> => y !== null) });
  return { ...card, rules: rules(card.programCycleId) };
}

describe("defaultEligibility", () => {
  it("lets shared/eligibility's engine decide verified rule sets, even where the card's facet is silent", () => {
    // No class-year facet on the card, but the verified rule says juniors and seniors only.
    const card = cardWith((id) => verified(id, [standing(["third_year", "fourth_year"], "Open to juniors and seniors")]));
    expect(defaultEligibility(card, firstYear, TODAY).status).toBe("not_eligible");
    expect(engineEligibility(card, firstYear, TODAY).status).toBe("not_eligible");
    // The facet-only check could not have known.
    expect(facetEligibility(card, firstYear, TODAY).status).not.toBe("not_eligible");
  });

  it("keeps a verified program open with a student check when the year is unanswered", () => {
    const card = cardWith((id) => verified(id, [standing(["first_year", "second_year"], "Open to first- and second-year students")]));
    const out = defaultEligibility(card, noYear, TODAY);
    expect(out.status).toBe("conditional");
    expect(out.pending.every((p) => p.resolver === "student" && !p.sensitive)).toBe(true);
  });

  it("falls back to the card's class-year facet when there is no rule set", () => {
    const seniorsOnly = cardWith(() => null, ["fourth_year"]);
    expect(defaultEligibility(seniorsOnly, firstYear, TODAY).status).toBe("not_eligible");
    const open = defaultEligibility(cardWith(() => null, ["first_year"]), firstYear, TODAY);
    expect(open.status).toBe("unknown");
    expect(toChecks(open).map((c) => c.text)).toEqual(["Novus has not checked this program's rules yet: see the official page"]);
  });

  it("never lets a rule set the engine cannot read take down matching", () => {
    const broken = { ...cardWith((id) => verified(id, [])), rules: { ...verified("x", []), rules: "not a list" } as unknown as EligibilityRuleSet };
    const out = defaultEligibility(broken, firstYear, TODAY);
    expect(out.status).toBe("unknown");
    expect(out.pending.some((p) => p.id === "rule_set_unreadable" && p.resolver === "novus")).toBe(true);
  });

  it("is what findMatches uses when no adapter is passed", () => {
    const blocked = { ...cardWith((id) => verified(id, [standing(["third_year", "fourth_year"], "Open to juniors and seniors")])), slug: "juniors-only", summary: "Python internship." };
    const open = { ...cardWith((id) => verified(id, [])), slug: "open-to-all", summary: "Python internship." };
    const prefs = makePreferences({ categories: ["internships"], opportunityTypes: ["summer_internship"], classYear: "first_year", skills: ["python"], skillsConfirmed: true });
    expect(findMatches({ preferences: prefs, programs: [blocked, open], now: NOW }).items.map((i) => i.slug)).toEqual(["open-to-all"]);
  });
});

describe("facetEligibility", () => {
  it("asks about class year once, not once for the facet and again for the standing rule", () => {
    const card = cardWith((id) => verified(id, [standing(["first_year"], "Open to first-year students")]), ["first_year"]);
    const checks = toChecks(facetEligibility(card, noYear, TODAY));
    expect(checks.filter((c) => /first-year/i.test(c.text))).toHaveLength(1);
  });
});
