import { describe, expect, it } from "vitest";
import { FORBIDDEN_STUDENT_SCORE_FIELDS } from "../contracts/readiness";
import type { ProgramCard } from "../contracts/registry";
import { personaRecall } from "./eval";
import type { MatchingProfile } from "./facets";
import { SAMPLE_CARDS, SAMPLE_NOW, SAMPLE_TODAY, sampleCard, sampleCardBySlug, sampleDeadline } from "./fixtures/sample-cards";
import { SAMPLE_PERSONAS } from "./fixtures/queries";
import { diversify, rankForStudent, type EligibilityLike, type RankedItem } from "./order";
import { explainWhyShown } from "./why-shown";

const fyBio: MatchingProfile = { classYear: "first_year", majorFamily: "life_sciences", timeZone: "America/New_York" };

/** SAMPLE stand-in for shared/eligibility over the fixture cards (which carry no rule sets). */
function standInEval(card: ProgramCard, profile: MatchingProfile): EligibilityLike {
  if (card.classYears.length > 0) {
    if (!profile.classYear) return { status: "unknown", pending: [{ dimension: "standing", resolver: "student", selfCheckText: "Add your class year." }] };
    if (!card.classYears.includes(profile.classYear)) return { status: "not_eligible" };
  }
  if (card.flags.nominationRequired) {
    return { status: "conditional", pending: [{ dimension: null, resolver: "student", selfCheckText: "Eligible if your campus nominates you." }] };
  }
  return { status: "eligible", rules: card.classYears.length ? [{ dimension: "standing", verdict: "met" }] : [] };
}

function evalsFor(profile: MatchingProfile, cards: readonly ProgramCard[] = SAMPLE_CARDS): Map<string, EligibilityLike> {
  return new Map(cards.map((c) => [c.programCycleId, standInEval(c, profile)]));
}

function rank(profile: MatchingProfile, cards: readonly ProgramCard[] = SAMPLE_CARDS, extra: Partial<Parameters<typeof rankForStudent>[3]> = {}) {
  return rankForStudent(cards, profile, evalsFor(profile, cards), { now: SAMPLE_NOW, ...extra });
}

function bySlug(items: readonly RankedItem[], slug: string): RankedItem {
  const item = items.find((i) => i.slug === slug);
  if (!item) throw new Error(`missing ${slug}`);
  return item;
}

describe("timing buckets", () => {
  const items = rank({ classYear: "second_year", majorFamily: "computing" }, SAMPLE_CARDS, { includeNotEligible: true });

  it("puts a start-by inside 14 days in start_now", () => {
    expect(bySlug(items, "harbor-data-sprint").timingBucket).toBe("start_now");
  });

  it("marks a deadline shorter than the preparation time as tight", () => {
    const g = bySlug(items, "granite-engineering-scholars");
    expect(g.timingBucket).toBe("tight");
    expect(g.whyShown.map((w) => w.code)).toContain("TIGHT_TIMELINE");
  });

  it("leads with an uncertain campus date for nomination programs instead of reading tight", () => {
    const m = bySlug(items, "meridian-undergraduate-scholarship");
    expect(m.timingBucket).toBe("start_now");
    expect(m.timing.step).toBe("e1");
    expect(m.timing.effectiveDate).toBe("2026-11-20"); // 2027-01-29 minus the 70-day default
    expect(m.whyShown[0]).toMatchObject({ code: "CAMPUS_DATE_UNCERTAIN", step: "e1" });
    expect(m.timing.tight).toBe(false);
  });

  it("uses a known campus date before any estimate", () => {
    const m = rank({ classYear: "second_year" }, SAMPLE_CARDS, {
      campusDates: new Map([[sampleCardBySlug("meridian-undergraduate-scholarship").programCycleId, ["2026-12-04"]]]),
    });
    const item = bySlug(m, "meridian-undergraduate-scholarship");
    expect(item.timing.step).toBe("campus");
    expect(item.timing.effectiveDate).toBe("2026-12-04");
    expect(item.whyShown.map((w) => w.code)).toContain("CAMPUS_DATE");
  });

  it("treats rolling, expected and closed cycles by their own rules", () => {
    expect(bySlug(items, "pivot-micro-internships").timing.rolling).toBe(true);
    expect(bySlug(items, "pivot-micro-internships").timingBucket).toBe("later");
    const oss = bySlug(items, "open-source-season");
    expect(oss.timingBucket).toBe("later");
    expect(oss.whyShown.map((w) => w.code)).toContain("PREDICTED_WINDOW");
    expect(bySlug(items, "civic-leaders-fellowship").section).toBe("plan_ahead");
    expect(bySlug(items, "quartz-lab-summer-research").section).toBe("closed");
  });

  it("resolves an applicant-local deadline in the student's zone", () => {
    const ny = rank({ timeZone: "America/New_York" });
    const hi = rank({ timeZone: "Pacific/Honolulu" });
    expect(bySlug(ny, "keystone-software-apprenticeship").timing.effectiveDate).toBe("2026-12-05");
    expect(bySlug(hi, "keystone-software-apprenticeship").timing.effectiveDate).toBe("2026-12-05");
  });
});

describe("start-by golden case", () => {
  it("two letters before a 15 Jan deadline read 'Start by Dec 23'", () => {
    const card = sampleCard(90, {
      slug: "letters-golden",
      name: "Golden Letters Award",
      organizationName: "Example Golden Org",
      deadlines: [sampleDeadline({ date: "2027-01-15" })],
      prepDays: 23,
    });
    const [item] = rankForStudent([card], {}, new Map([[card.programCycleId, { status: "eligible" }]]), { now: SAMPLE_NOW });
    expect(item?.timing.startBy).toBe("2026-12-23");
    const lines = explainWhyShown(item as RankedItem).map((l) => l.text);
    expect(lines[0]).toBe("Start by Dec 23 to be ready for the Jan 15 deadline.");
  });

  it("shows the deadline, never a tight timeline, when prepDays is unknown", () => {
    const card = sampleCard(91, {
      slug: "no-prep",
      name: "Unchecked Requirements Program",
      organizationName: "Example Unchecked Org",
      deadlines: [sampleDeadline({ date: "2026-11-13" })],
      prepDays: null,
    });
    const [item] = rankForStudent([card], {}, {}, { now: SAMPLE_NOW });
    expect(item?.timing.tight).toBe(false);
    expect(item?.whyShown.map((w) => w.code)).toEqual(expect.arrayContaining(["DEADLINE", "NOT_FULLY_CHECKED"]));
    expect(item?.timingBucket).toBe("start_now");
  });
});

describe("order", () => {
  it("orders buckets start_now, start_soon, tight, later, plan_ahead, closed", () => {
    const items = rank({ classYear: "first_year" });
    const order = ["start_now", "start_soon", "tight", "later", "plan_ahead", "closed"];
    const seen = items.map((i) => order.indexOf(i.timingBucket));
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    items.forEach((item, i) => expect(item.rankKey).toBe(i));
  });

  it("orders eligible before conditional before unknown inside a bucket", () => {
    const cards = [1, 2, 3].map((n) =>
      sampleCard(100 + n, { slug: `tie-${n}`, name: `Tie ${n}`, organizationName: `Example Org ${n}`, deadlines: [sampleDeadline({ date: "2026-11-20" })], prepDays: 1 }),
    );
    const evals = new Map<string, EligibilityLike>([
      [cards[0]!.programCycleId, { status: "unknown" }],
      [cards[1]!.programCycleId, { status: "eligible" }],
      [cards[2]!.programCycleId, { status: "conditional", pending: [] }],
    ]);
    const items = rankForStudent(cards, {}, evals, { now: SAMPLE_NOW });
    expect(items.map((i) => i.eligibility)).toEqual(["eligible", "conditional", "unknown"]);
  });

  it("puts a major-family match before open-to-all before other inside a segment", () => {
    const mk = (n: number, families: ProgramCard["majorFamilies"]) =>
      sampleCard(110 + n, { slug: `fit-${n}`, name: `Fit ${n}`, organizationName: `Example Fit ${n}`, majorFamilies: families, deadlines: [sampleDeadline({ date: "2026-11-20" })], prepDays: 1 });
    const cards = [mk(1, ["business"]), mk(2, []), mk(3, ["life_sciences"])];
    const items = rankForStudent(cards, fyBio, new Map(cards.map((c) => [c.programCycleId, { status: "eligible" } as const])), { now: SAMPLE_NOW });
    expect(items.map((i) => i.fitBand)).toEqual(["major_match", "open_to_all", "other"]);
    expect(items[0]?.whyShown.map((w) => w.code)).toContain("MAJOR_MATCH");
  });

  it("treats a cycle with no eligibility result as unknown, never eligible", () => {
    const items = rankForStudent(SAMPLE_CARDS, fyBio, {}, { now: SAMPLE_NOW });
    expect(items.every((i) => i.eligibility === "unknown")).toBe(true);
  });

  it("sets not-eligible cycles aside unless asked, then appends them last", () => {
    const without = rank({ classYear: "first_year" });
    expect(without.find((i) => i.slug === "summit-sophomore-analyst")).toBeUndefined();
    const withAll = rank({ classYear: "first_year" }, SAMPLE_CARDS, { includeNotEligible: true });
    const last = withAll.filter((i) => i.section === "not_eligible");
    expect(last.map((i) => i.slug)).toContain("summit-sophomore-analyst");
    expect(withAll.slice(-last.length)).toEqual(last);
  });

  it("hides 'Not interested' programs", () => {
    const hidden = new Set([sampleCardBySlug("harbor-data-sprint").programId]);
    expect(rank(fyBio, SAMPLE_CARDS, { hidden }).find((i) => i.slug === "harbor-data-sprint")).toBeUndefined();
  });

  it("is deterministic and independent of input order", () => {
    const a = rank(fyBio).map((i) => i.slug);
    const b = rank(fyBio, [...SAMPLE_CARDS].reverse()).map((i) => i.slug);
    expect(b).toEqual(a);
    expect(rank(fyBio).map((i) => i.slug)).toEqual(a);
  });
});

describe("rotating tie-break", () => {
  const ties = Array.from({ length: 12 }, (_, n) =>
    sampleCard(200 + n, {
      slug: `${String.fromCharCode(97 + n)}-tied-program`,
      name: `Tied ${n}`,
      organizationName: `Example Tie Org ${n}`,
      opportunityTypes: [n % 2 ? "grant" : "competition"],
      deadlines: [sampleDeadline({ date: "2026-12-20" })],
      prepDays: 7,
    }),
  );
  const evals = new Map(ties.map((c) => [c.programCycleId, { status: "eligible" } as const]));
  const order = (isoWeek: string) => rankForStudent(ties, {}, evals, { now: SAMPLE_NOW, isoWeek, diversity: false }).map((i) => i.slug);

  it("is stable within a week and not alphabetical", () => {
    expect(order("2026-W46")).toEqual(order("2026-W46"));
    expect(order("2026-W46")).not.toEqual([...ties.map((t) => t.slug)].sort());
  });

  it("changes across weeks", () => {
    expect(order("2026-W46")).not.toEqual(order("2026-W47"));
  });

  it("defaults to the week of `now`", () => {
    expect(rankForStudent(ties, {}, evals, { now: SAMPLE_NOW, diversity: false }).map((i) => i.slug)).toEqual(order("2026-W46"));
  });
});

describe("diversity", () => {
  it("keeps any window of 10 to at most 2 per Organization when alternatives exist", () => {
    const cards = Array.from({ length: 16 }, (_, n) =>
      sampleCard(300 + n, {
        slug: `div-${String(n).padStart(2, "0")}`,
        name: `Diverse ${n}`,
        organizationName: n < 8 ? "Example Big Bank" : `Example Small Org ${n}`,
        opportunityTypes: n < 8 ? ["summer_internship"] : n % 2 ? ["sprinternship"] : ["research_program"],
        deadlines: [sampleDeadline({ date: "2026-12-20" })],
        prepDays: 7,
      }),
    );
    const items = rankForStudent(cards, {}, new Map(cards.map((c) => [c.programCycleId, { status: "eligible" } as const])), { now: SAMPLE_NOW });
    const orgs = items.map((i) => cards.find((c) => c.slug === i.slug)!.organizationName);
    // 8 small orgs exist, so the first 10 positions can hold at most 2 big-bank cards.
    expect(orgs.slice(0, 10).filter((o) => o === "Example Big Bank").length).toBeLessThanOrEqual(2);
    expect(items).toHaveLength(16); // nothing dropped
  });

  it("never drops items when every candidate violates the caps", () => {
    const same = Array.from({ length: 5 }, (_, n) => ({ card: { organizationName: "Example Only", opportunityTypes: ["grant" as const] }, n }));
    expect(diversify(same).map((x) => x.n)).toEqual([0, 1, 2, 3, 4]);
  });

  it("never moves a card across a timing bucket", () => {
    const items = rank(fyBio);
    const order = ["start_now", "start_soon", "tight", "later", "plan_ahead", "closed"];
    const seen = items.map((i) => order.indexOf(i.timingBucket));
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});

describe("facets", () => {
  it("lists facets as a checklist without any tally", () => {
    const item = bySlug(rank(fyBio), "coastal-ecology-reu");
    expect(item.facets.map((f) => [f.facet, f.status])).toEqual([
      ["standing", "matches"],
      ["major", "matches"],
    ]);
    expect(item.facets[1]?.detail).toBe("Matches your major family (Life sciences).");
  });

  it("names materials gaps when Requirements and materials are supplied", () => {
    const card = sampleCardBySlug("granite-engineering-scholars");
    const items = rankForStudent([card], {}, {}, {
      now: SAMPLE_NOW,
      requirements: new Map([[card.programCycleId, [{ kind: "recommendation", quantity: 2 }, { kind: "resume", quantity: 1 }]]]),
      materials: { resume: "draft", recommendersIdentified: 1, transcriptAccess: null },
    });
    const materials = items[0]!.facets.filter((f) => f.facet === "material");
    expect(materials).toEqual([
      { facet: "material", status: "missing", detail: "Asks for 2 letters; you listed 1 recommender." },
      { facet: "material", status: "missing", detail: "Asks for a résumé; yours is a draft." },
    ]);
  });
});

describe("no score about the student", () => {
  const banned = new Set<string>([...FORBIDDEN_STUDENT_SCORE_FIELDS, "relevance", "fitScore", "matchScore", "percentMatch", "sortDays", "rotation"]);

  function walk(value: unknown, path: string, out: string[]): void {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`, out));
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (banned.has(k)) out.push(`${path}.${k}`);
        walk(v, `${path}.${k}`, out);
      }
    }
  }

  it("ranked items carry no forbidden field and no numeric facet", () => {
    const items = rank(fyBio, SAMPLE_CARDS, { includeNotEligible: true });
    const found: string[] = [];
    walk(items, "items", found);
    expect(found).toEqual([]);
    for (const item of items) {
      for (const f of item.facets) expect(Object.values(f).every((v) => typeof v === "string")).toBe(true);
      const numericTop = Object.entries(item).filter(([, v]) => typeof v === "number").map(([k]) => k);
      expect(numericTop).toEqual(["rankKey"]);
    }
  });

  it("why-shown copy never states a percentage", () => {
    for (const persona of SAMPLE_PERSONAS) {
      for (const item of rank(persona.profile)) {
        for (const line of explainWhyShown(item)) expect(line.text).not.toMatch(/%|percent|score|chance/i);
      }
    }
  });
});

describe("persona surfacing (sample personas)", () => {
  it("keeps every near-term eligible or conditional item in the top 20 for each persona", () => {
    for (const persona of SAMPLE_PERSONAS) {
      const items = rank(persona.profile);
      const { recall } = personaRecall(items, SAMPLE_TODAY);
      expect(recall, persona.id).toBeGreaterThanOrEqual(0.9);
    }
  });
});
