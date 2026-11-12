import { describe, expect, it, vi } from "vitest";
import { isSensitiveKey } from "../contracts/sensitive";
import type { StudentProfile } from "../contracts/student";
import type { EligibilityAdapter } from "./eligibility";
import { findMatches } from "./match";
import { buildSamplePrograms } from "./sample";
import { makeCard, makePreferences } from "./testing";
import { MatchSetSchema, type OnboardingProgram } from "./types";

const NOW = "2026-11-11T15:00:00Z";
const TODAY = "2026-11-11";

const computingPrefs = makePreferences({
  categories: ["internships"],
  opportunityTypes: ["summer_internship", "off_cycle_internship", "new_grad_rotational", "micro_internship"],
  interests: ["software"],
  skills: ["python", "sql"],
  skillsConfirmed: true,
  classYear: "first_year",
  majorFamily: "computing",
});

const swe = (over: Partial<Parameters<typeof makeCard>[0]> = {}): OnboardingProgram =>
  makeCard({
    today: TODAY,
    name: "Sample: Software Internship",
    summary: "Build software in Python and SQL with a product team.",
    majorFamilies: ["computing"],
    classYears: ["first_year", "second_year"],
    interestTags: ["software"],
    extras: { requirements: [{ kind: "resume" }] },
    ...over,
  });

describe("hard filters", () => {
  it("drops closed, far-off, passed and too-late programs, but keeps ones opening soon", () => {
    const programs = [
      swe({ slug: "open-one" }),
      swe({ slug: "closed-one", status: "closed" }),
      swe({ slug: "ended-one", status: "ended" }),
      swe({ slug: "passed-one", deadlineIn: -1 }),
      swe({ slug: "soon-one", status: "expected", opensOn: "2026-11-25", deadlineIn: 60 }),
      swe({ slug: "later-one", status: "expected", opensOn: "2027-03-01", deadlineIn: 150 }),
    ];
    const slugs = findMatches({ preferences: computingPrefs, programs, now: NOW }).items.map((i) => i.slug);
    expect(slugs).toEqual(expect.arrayContaining(["open-one", "soon-one"]));
    for (const gone of ["closed-one", "ended-one", "passed-one", "later-one"]) expect(slugs).not.toContain(gone);
  });

  it("drops class years the program does not take, and keeps unknown ones as a check", () => {
    const seniors = swe({ slug: "seniors", classYears: ["fourth_year"] });
    expect(findMatches({ preferences: computingPrefs, programs: [seniors], now: NOW }).items).toHaveLength(0);
    const unknownYear = findMatches({ preferences: { ...computingPrefs, classYear: null }, programs: [seniors], now: NOW });
    expect(unknownYear.items).toHaveLength(1);
    expect(unknownYear.items[0]?.missing).toContain("Your class year (tell us to check)");
  });

  it("applies must-be-paid and remote-only only against known facts", () => {
    const unpaid = swe({ slug: "unpaid", compensation: { kind: "none", amountCents: null, period: null } });
    const unknownPay = swe({ slug: "unknown-pay", compensation: null });
    const inPerson = swe({ slug: "in-person", extras: { format: ["in_person"] } });
    const unknownFormat = swe({ slug: "unknown-format" });
    const slugs = findMatches({ preferences: { ...computingPrefs, pay: "must", location: "remote" }, programs: [unpaid, unknownPay, inPerson, unknownFormat], now: NOW }).items.map((i) => i.slug);
    expect(slugs.sort()).toEqual(["unknown-format", "unknown-pay"]);
  });

  it("leaves status-defined programs out unless the device opts in, and honours Not for me", () => {
    const sensitive = swe({ slug: "status-defined", flags: { sensitiveAudience: true } });
    const hidden = swe({ slug: "hidden-one" });
    expect(findMatches({ preferences: computingPrefs, programs: [sensitive], now: NOW }).items).toHaveLength(0);
    expect(findMatches({ preferences: computingPrefs, programs: [sensitive], now: NOW, includeSensitiveAudience: true }).items).toHaveLength(1);
    expect(findMatches({ preferences: computingPrefs, programs: [hidden], now: NOW, hidden: [hidden.programId] }).items).toHaveLength(0);
  });
});

describe("tiers", () => {
  it("gives strong only with eligibility, time, field match, skill evidence and the asked-for type", () => {
    const set = findMatches({ preferences: computingPrefs, programs: [swe({ slug: "fit", rules: null })], now: NOW });
    // No verified rule set: Novus has not checked eligibility, so at most good.
    expect(set.items[0]?.tier).toBe("good");
    expect(set.items[0]?.reasonCodes).toContain("NOT_FULLY_CHECKED");
  });

  it("calls a tight timeline a stretch, never a strong fit", () => {
    const sample = buildSamplePrograms(NOW);
    const tight = sample.find((p) => p.slug === "sample-ai-research-experience") as OnboardingProgram;
    const set = findMatches({
      preferences: { ...computingPrefs, categories: ["research"], opportunityTypes: ["research_program"], interests: ["ai_data"], skills: ["python", "machine_learning"] },
      programs: [tight],
      now: NOW,
    });
    expect(set.items[0]?.tier).toBe("stretch");
    expect(set.items[0]?.feasibility.enoughTime).toBe(false);
    expect(set.items[0]?.reasons.some((r) => r.startsWith("Tight timeline"))).toBe(true);
  });

  it("keeps community-specific programs out of strong and says why", () => {
    const sample = buildSamplePrograms(NOW);
    const community = sample.find((p) => p.slug === "sample-women-in-engineering-fellowship") as OnboardingProgram;
    const set = findMatches({
      preferences: makePreferences({ categories: ["fellowships"], interests: ["hardware"], majorFamily: "engineering_technology", classYear: "first_year", skills: ["leadership"], skillsConfirmed: true }),
      programs: [community],
      now: NOW,
    });
    expect(set.items[0]?.tier).not.toBe("strong");
    expect(set.items[0]?.reasonCodes).toContain("COMMUNITY_PROGRAM");
    expect(set.items[0]?.audience.identity).toBe(true);
    // On the card itself, not only behind "Why this?", however many fit reasons it has.
    expect(set.items[0]?.reasons).toContain("Serves a specific community: check the official rules privately");
  });

  it("orders strong before good before stretch", () => {
    const set = findMatches({ preferences: computingPrefs, programs: buildSamplePrograms(NOW), now: NOW, k: 30 });
    const rank = { strong: 0, good: 1, stretch: 2 };
    for (let i = 1; i < set.items.length; i++) {
      expect(rank[set.items[i - 1]!.tier] <= rank[set.items[i]!.tier]).toBe(true);
    }
  });
});

describe("diversity and limits", () => {
  it("shows at most two programs per organization and respects k", () => {
    const programs = Array.from({ length: 6 }, (_, i) => swe({ slug: `same-org-${i}`, organizationName: "One Org (sample)" }));
    const other = swe({ slug: "other-org", organizationName: "Other Org (sample)" });
    const set = findMatches({ preferences: computingPrefs, programs: [...programs, other], now: NOW, k: 3 });
    expect(set.items).toHaveLength(3);
    expect(set.items.filter((i) => i.organizationName === "One Org (sample)").length).toBeLessThanOrEqual(2);
    expect(set.items.map((i) => i.slug)).toContain("other-org");
  });

  it("shows at least two of the asked-for kinds among a tier's first six", () => {
    const prefs = { ...computingPrefs, categories: ["internships", "research"], opportunityTypes: ["summer_internship", "research_program"] } as typeof computingPrefs;
    const internships = Array.from({ length: 7 }, (_, i) => swe({ slug: `intern-${i}`, organizationName: `Intern Org ${i} (sample)` }));
    // A research program in the same tier (a major match) that ranks below all seven internships.
    const research = swe({ slug: "zz-research", organizationName: "Lab (sample)", opportunityTypes: ["research_program"], interestTags: [], summary: "Lab work.", deadlineIn: 90 });
    const set = findMatches({ preferences: prefs, programs: [...internships, research], now: NOW, k: 10 });
    expect(new Set(set.items.map((i) => i.tier)).size).toBe(1);
    const index = set.items.findIndex((i) => i.slug === "zz-research");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(6);
    // Asking for one kind only leaves the order to relevance and diversity.
    const internshipOnly = findMatches({ preferences: computingPrefs, programs: [...internships, research], now: NOW, k: 10 });
    expect(internshipOnly.items.some((i) => i.slug === "zz-research" && i.tier !== "stretch")).toBe(false);
  });

  it("fills in other types as labelled stretches when too few of the asked-for type match", () => {
    const research = swe({ slug: "a-research-program", opportunityTypes: ["research_program"] });
    const set = findMatches({ preferences: computingPrefs, programs: [research], now: NOW });
    expect(set.relaxed).toBe(true);
    expect(set.items[0]?.tier).toBe("stretch");
    expect(set.items[0]?.reasonCodes).toContain("DIFFERENT_TYPE");
  });
});

describe("explainable output", () => {
  it("returns plain reasons and counts, validated by the strict schema, with no score anywhere", () => {
    const set = findMatches({ preferences: computingPrefs, programs: buildSamplePrograms(NOW), now: NOW });
    expect(MatchSetSchema.parse(set)).toEqual(set);
    for (const item of set.items) {
      expect(item.reasons.length).toBeGreaterThanOrEqual(1);
      expect(item.reasons.length).toBeLessThanOrEqual(3);
      for (const r of item.reasons) expect(r).not.toMatch(/%|score|\b\d+(\.\d+)? ?\/ ?\d+\b/i);
      expect(item.requirementsMet.met).toBeLessThanOrEqual(item.requirementsMet.total);
    }
  });

  it("names the student's skills from the resume and what is missing", () => {
    const set = findMatches({
      preferences: { ...computingPrefs, skills: [], skillsConfirmed: false },
      signals: { skills: ["Python", "SQL"] },
      programs: [swe({ slug: "fit", summary: "Build software in Python, SQL and Java." })],
      now: NOW,
    });
    const item = set.items[0];
    expect(item?.reasons[0]).toBe("Uses Python and SQL from your resume");
    expect(item?.skills.missing).toContain("Java");
    expect(item?.missing).toContain("Java");
  });

  it("never lists a program's tags or unknown labels as missing skills", () => {
    const set = findMatches({
      preferences: computingPrefs,
      programs: [swe({ slug: "tagged", summary: "Work with a city team.", extras: { skills: ["civic tech", "public service", "python"] } })],
      now: NOW,
    });
    expect(set.items[0]?.skills.missing).toEqual([]);
    expect(set.items[0]?.skills.matched).toEqual(["Python"]);
  });

  it("shows a program only for evidence its card can state, never for a stray word", () => {
    // "clean energy" must not pull in a program because its summary says "clean data".
    const set = findMatches({ preferences: makePreferences({ interests: ["climate"] }), programs: buildSamplePrograms(NOW), now: NOW });
    expect(set.items.map((i) => i.slug)).not.toContain("sample-civic-data-internship");
    for (const item of set.items) expect(item.reasonCodes.some((c) => c === "INTEREST_MATCH" || c === "EXPLORE")).toBe(true);
  });

  it("counts an unlisted resume skill the program names, and says so plainly", () => {
    const kotlin = swe({ slug: "kotlin-shop", summary: "Build Android features in Kotlin with a small team.", interestTags: [], majorFamilies: [] });
    const set = findMatches({
      preferences: makePreferences({ classYear: "first_year" }),
      signals: { skills: ["Kotlin"] },
      programs: [kotlin],
      now: NOW,
    });
    expect(set.items[0]?.reasons).toContain("Mentions Kotlin, which is on your resume");
    expect(set.items[0]?.reasonCodes).not.toContain("EXPLORE");
  });

  it("does not read everyday words as resume skills (Go, Scratch, Assembly)", () => {
    const programs = [
      swe({ slug: "go-idea", summary: "Students go from idea to prototype.", interestTags: [], majorFamilies: [] }),
      swe({ slug: "scratch-app", summary: "Build a web app from scratch.", interestTags: [], majorFamilies: [] }),
      swe({ slug: "mun", summary: "Model UN general assembly.", interestTags: [], majorFamilies: [] }),
      swe({ slug: "golang-shop", summary: "Write services in Golang.", interestTags: [], majorFamilies: [] }),
    ];
    const set = findMatches({ preferences: makePreferences({ classYear: "first_year" }), signals: { skills: ["Go", "Scratch", "Assembly"] }, programs, now: NOW });
    // They may still appear as labelled "explore" picks, never as a skill match or above stretch.
    for (const item of set.items.filter((i) => i.slug !== "golang-shop")) {
      expect(item.reasons.join(" ")).not.toMatch(/Mentions (?:Go|Scratch|Assembly)/);
      expect(item.tier).toBe("stretch");
    }
    expect(set.items.find((i) => i.slug === "golang-shop")?.reasons).toContain("Mentions Go, which is on your resume");
  });

  it("ignores interest words in summary boilerplate when the program has curated tags", () => {
    const finance = swe({ slug: "finance-analyst", name: "Sample: Analyst Internship", summary: "A paid summer analyst role in a supportive, fast-paced work environment.", interestTags: ["finance"], majorFamilies: [] });
    const set = findMatches({ preferences: makePreferences({ interests: ["climate"], classYear: "first_year" }), programs: [finance], now: NOW });
    for (const item of set.items) expect(item.reasons.join(" ")).not.toMatch(/climate/i);
  });

  it("uses confirmed skills only once the student has reviewed them", () => {
    const set = findMatches({
      preferences: { ...computingPrefs, skills: ["sql"], skillsConfirmed: true },
      signals: { skills: ["Python"] },
      programs: [swe({ slug: "fit", summary: "Python work." })],
      now: NOW,
    });
    expect(set.items[0]?.skills.matched).toEqual([]);
  });
});

describe("caching", () => {
  it("re-indexes when the same catalogue array is changed in place", () => {
    const catalogue: OnboardingProgram[] = [swe({ slug: "first-one", organizationName: "Org A (sample)" })];
    expect(findMatches({ preferences: computingPrefs, programs: catalogue, now: NOW }).items).toHaveLength(1);
    catalogue.push(swe({ slug: "added-later", organizationName: "Org B (sample)", summary: "Python and SQL every day." }));
    const set = findMatches({ preferences: computingPrefs, programs: catalogue, now: NOW });
    expect(set.items.map((i) => i.slug)).toContain("added-later");
    expect(set.items.find((i) => i.slug === "added-later")?.skills.matched).toEqual(["Python", "SQL"]);
  });

  it("treats duplicate cards for one cycle as one", () => {
    const one = swe({ slug: "dup" });
    expect(findMatches({ preferences: computingPrefs, programs: [one, one], now: NOW }).items).toHaveLength(1);
  });
});

describe("injection points", () => {
  it("calls the eligibility adapter with a non-sensitive profile and honours its verdict", () => {
    const seen: StudentProfile[] = [];
    const adapter = vi.fn<EligibilityAdapter>((program, profile) => {
      seen.push(profile);
      return program.slug === "blocked" ? { status: "not_eligible", pending: [] } : { status: "eligible", pending: [] };
    });
    const set = findMatches({ preferences: computingPrefs, programs: [swe({ slug: "blocked" }), swe({ slug: "allowed" })], now: NOW, eligibility: adapter });
    expect(set.items.map((i) => i.slug)).toEqual(["allowed"]);
    expect(set.items[0]?.eligibility.status).toBe("eligible");
    expect(adapter).toHaveBeenCalledTimes(2);
    for (const profile of seen) for (const key of Object.keys(profile)) expect(isSensitiveKey(key)).toBe(false);
  });

  it("lets the exposure boost reorder near-equals within a tier but never change a tier", () => {
    const a = swe({ slug: "twin-a", organizationName: "Org A (sample)" });
    const b = swe({ slug: "twin-b", organizationName: "Org B (sample)" });
    // Weaker programs pull the slate median below the top two, as on a real slate; the boost
    // applies only above that median (plan 06).
    const weak = ["ccc", "ddd", "eee"].map((x) => swe({ slug: `${x}-weaker`, organizationName: `Org ${x} (sample)`, interestTags: [], summary: "Office work.", majorFamilies: [] }));
    const programs = [a, b, ...weak];
    const base = findMatches({ preferences: computingPrefs, programs, now: NOW });
    // The twins tie exactly, so this week's rotation orders them; the boost must beat it.
    const [first, second] = base.items.slice(0, 2).map((i) => i.programId) as [string, string];
    expect(new Set([first, second])).toEqual(new Set([a.programId, b.programId]));
    const exposure = { [first]: 50, [second]: 1, ...Object.fromEntries(weak.map((w) => [w.programId, 10])) };
    const boosted = findMatches({ preferences: computingPrefs, programs, now: NOW, exposure });
    expect(boosted.items.slice(0, 2).map((i) => i.programId)).toEqual([second, first]);
    expect(boosted.items.map((i) => i.tier)).toEqual(base.items.map((i) => i.tier));
  });

  it("adds an on-device semantic list when program vectors are supplied", () => {
    const a = swe({ slug: "twin-a", organizationName: "Org A (sample)" });
    const b = swe({ slug: "twin-b", organizationName: "Org B (sample)" });
    const plain = findMatches({ preferences: computingPrefs, programs: [a, b], now: NOW });
    const [first, second] = plain.items.map((i) => i.programId) as [string, string];
    const semantic = findMatches({
      preferences: computingPrefs,
      programs: [a, b],
      now: NOW,
      semantic: { studentVector: [1, 0], programVectors: { [first]: [0, 1], [second]: [1, 0] } },
    });
    expect(semantic.items.map((i) => i.programId)).toEqual([second, first]);
  });

  it("breaks exact ties by plan 06's weekly rotation: stable within a week, not alphabetical", () => {
    const twins = ["twin-a", "twin-b"].map((slug, i) => swe({ slug, organizationName: `Org ${i} (sample)`, deadlineIn: 150 }));
    const firstOn = (now: string) => findMatches({ preferences: computingPrefs, programs: twins, now }).items[0]?.slug;
    // Same answer all week (Wednesday and the next Sunday share ISO week 2026-W46)...
    expect(firstOn("2026-11-11T15:00:00Z")).toBe(firstOn("2026-11-15T15:00:00Z"));
    // ...and over eight weeks each twin leads at least once.
    const leaders = new Set(Array.from({ length: 8 }, (_, w) => firstOn(new Date(Date.parse(NOW) + w * 7 * 86_400_000).toISOString())));
    expect(leaders).toEqual(new Set(["twin-a", "twin-b"]));
  });
});

describe("never an empty screen", () => {
  const sample = buildSamplePrograms(NOW);
  const nothing = makePreferences();

  it("gives a student who skipped every question open, feasible programs to explore, labelled as such", () => {
    const set = findMatches({ preferences: nothing, programs: sample, now: NOW });
    expect(set.items.length).toBeGreaterThanOrEqual(2);
    expect(set.relaxed).toBe(true);
    for (const item of set.items) {
      expect(item.tier).toBe("stretch");
      expect(item.feasibility.enoughTime).toBe(true);
      expect(item.audience.identity).toBe(false);
      expect(item.reasonCodes).toContain("EXPLORE");
      expect(item.reasons.some((r) => r.startsWith("Picked to help you explore"))).toBe(true);
      expect(item.reasonCodes.some((c) => c === "NO_EXPERIENCE_NEEDED" || c === "FIRST_YEAR_OPEN")).toBe(true);
    }
    expect(MatchSetSchema.parse(set)).toEqual(set);
  });

  it("fills a whole list for a first-year who gave only their year, never a closed or tight program", () => {
    const set = findMatches({ preferences: makePreferences({ classYear: "first_year" }), programs: sample, now: NOW, k: 10 });
    expect(set.items.length).toBeGreaterThanOrEqual(6);
    for (const item of set.items) {
      const card = sample.find((p) => p.programId === item.programId)!;
      expect(card.status === "open" || card.status === "expected").toBe(true);
      expect(item.feasibility.enoughTime).toBe(true);
      expect(card.classYears.length === 0 || card.classYears.includes("first_year")).toBe(true);
    }
    // Programs whose rules Novus has checked come before ones it has not.
    const unchecked = set.items.findIndex((i) => i.eligibility.status === "unknown");
    if (unchecked >= 0) for (const later of set.items.slice(unchecked)) expect(later.eligibility.status).toBe("unknown");
  });

  it("calls a kind-only student's programs good when they welcome the student, and says why", () => {
    const set = findMatches({ preferences: makePreferences({ categories: ["internships"], opportunityTypes: ["summer_internship"], classYear: "first_year" }), programs: sample, now: NOW });
    const good = set.items.filter((i) => i.tier === "good");
    expect(good.length).toBeGreaterThan(0);
    for (const item of good) {
      expect(item.categories).toContain("internships");
      expect(item.reasons).toContain("Open to first-year students");
      expect(item.reasons).toContain("One of the internships you asked for");
    }
    expect(set.items.some((i) => i.tier === "strong")).toBe(false);
  });

  it("does not pad a list that already has enough real matches", () => {
    const set = findMatches({ preferences: computingPrefs, programs: sample, now: NOW });
    expect(set.items.length).toBeGreaterThanOrEqual(3);
    expect(set.items.some((i) => i.reasonCodes.includes("EXPLORE"))).toBe(false);
  });
});
