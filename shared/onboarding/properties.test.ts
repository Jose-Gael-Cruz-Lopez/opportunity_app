import { describe, expect, it } from "vitest";
import type { EligibilityRuleSet } from "../contracts/eligibility";
import { FORBIDDEN_STUDENT_SCORE_FIELDS } from "../contracts/readiness";
import { CLASS_YEARS, EXPERIENCE_KINDS, MAJOR_FAMILIES, OPPORTUNITY_CATEGORY_KEYS, OPPORTUNITY_TYPES, REQUIREMENT_KINDS, type CycleStatus } from "../taxonomy";
import { localDateIn } from "../time/zones";
import { effectiveDeadline } from "./feasibility";
import { pickFirstDoor, planFirstApplication } from "./first-door";
import { findMatches } from "./match";
import { SKILLS, SKILL_IDS } from "./skills";
import { makeCard } from "./testing";
import { FirstApplicationPlanSchema, MatchSetSchema, type MatchSet, type OnboardingProgram, type StudentPreferences } from "./types";
import { INTEREST_TOPICS, typesForCategories } from "./vocab";

/**
 * Property tests with a seeded generator (no extra dependency): random students and random
 * catalogues, checked against the invariants that matter for students.
 */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZONES = ["America/New_York", "America/Chicago", "America/Los_Angeles", "Pacific/Honolulu", "Pacific/Pago_Pago"];
const STATUSES: CycleStatus[] = ["open", "open", "open", "open", "expected", "closed", "paused", "ended", "relaunched"];
const IN_SCOPE_TYPES = OPPORTUNITY_TYPES.filter((t) => t.inScope).map((t) => t.slug);

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)] as T;
}
function some<T>(r: () => number, xs: readonly T[], max: number): T[] {
  const n = Math.floor(r() * (max + 1));
  const out = new Set<T>();
  for (let i = 0; i < n; i++) out.add(pick(r, xs));
  return [...out];
}

function randomPreferences(r: () => number): StudentPreferences {
  const categories = some(r, OPPORTUNITY_CATEGORY_KEYS, 3);
  return {
    v: 1,
    categories,
    opportunityTypes: typesForCategories(categories),
    interests: some(r, INTEREST_TOPICS.map((t) => t.id), 5),
    skills: some(r, SKILL_IDS, 6),
    skillsConfirmed: r() < 0.5,
    classYear: r() < 0.85 ? pick(r, CLASS_YEARS) : null,
    majorFamily: r() < 0.85 ? pick(r, MAJOR_FAMILIES) : null,
    leanings: {
      style: r() < 0.5 ? pick(r, ["build", "investigate"] as const) : null,
      length: r() < 0.5 ? pick(r, ["short", "long"] as const) : null,
      value: r() < 0.5 ? pick(r, ["experience", "funding"] as const) : null,
    },
    timing: some(r, ["next_summer", "during_term", "winter_break"] as const, 2),
    location: r() < 0.7 ? pick(r, ["remote", "nearby", "travel"] as const) : null,
    pay: pick(r, ["must", "prefer", "any"] as const),
    weeklyHours: 1 + Math.floor(r() * 10),
    experience: some(r, EXPERIENCE_KINDS, 3),
    goal: r() < 0.8 ? pick(r, ["first_yes", "explore", "funding", "specific"] as const) : null,
    hasResume: r() < 0.5,
    timeZone: pick(r, ZONES),
    target: r() < 0.2 ? "Org 3" : null,
  };
}

function minimalRules(cycleId: string, years: readonly string[], citizenship: boolean): EligibilityRuleSet {
  return {
    id: "00000000-0000-4000-8000-00000000abcd",
    programCycleId: cycleId,
    version: 1,
    format: "jsonlogic-v1",
    state: "verified",
    templateKey: null,
    coverage: { standing: years.length ? "encoded" : "no_restriction", enrollment: "no_restriction", transfer: "no_restriction", gpa: "no_restriction", citizenship: citizenship ? "encoded" : "no_restriction", pell: "no_restriction" },
    rules: citizenship
      ? [{ id: "citizenship", dimension: "citizenship", group: "all", logic: { in: [{ var: "citizenship" }, ["us_citizen"]] }, fields: ["citizenship"], sensitive: true, asOf: "today", borderline: [], officialText: "U.S. citizens", evidenceKey: null }]
      : [],
    anyOf: [],
    attestations: [],
    nomination: null,
    evidence: {},
    hash: "a".repeat(64),
    createdVia: "sample",
    verifiedAt: "2026-11-01T00:00:00.000Z",
    verifiedBy: "Sample Curator",
    fromCycleKey: null,
  };
}

function randomProgram(r: () => number, today: string, i: number): OnboardingProgram {
  const skills = some(r, SKILLS, 3);
  const years = some(r, CLASS_YEARS, 3);
  const reqKinds = some(r, REQUIREMENT_KINDS, 3);
  const deadlineRoll = r();
  const status = pick(r, STATUSES);
  const card = makeCard({
    today,
    slug: `prop-${i}-${Math.floor(r() * 1e6)}`,
    organizationName: `Org ${Math.floor(r() * 6)} (sample)`,
    name: `Sample: Program ${i}`,
    status,
    opensOn: status === "open" && r() < 0.5 ? today : null,
    deadlineIn: deadlineRoll < 0.08 ? "rolling" : deadlineRoll < 0.12 ? "tbd" : deadlineRoll < 0.15 ? null : Math.floor(r() * 140) - 20,
    opportunityTypes: some(r, IN_SCOPE_TYPES, 2).length ? some(r, IN_SCOPE_TYPES, 2).concat(pick(r, IN_SCOPE_TYPES)) : [pick(r, IN_SCOPE_TYPES)],
    classYears: years,
    majorFamilies: some(r, MAJOR_FAMILIES, 2),
    interestTags: some(r, INTEREST_TOPICS.flatMap((t) => t.terms), 3),
    summary: skills.map((s) => s.aliases[0]).join(", ") || null,
    compensation: r() < 0.3 ? null : { kind: pick(r, ["stipend", "salary_hourly", "award", "tuition", "travel", "none", "varies"] as const), amountCents: null, period: null },
    prepDays: r() < 0.5 ? null : Math.floor(r() * 40),
    flags: { sensitiveAudience: r() < 0.1, identityAudience: r() < 0.1, nominationRequired: r() < 0.1, paid: r() < 0.4 },
    extras: {
      ...(r() < 0.5 ? { format: some(r, ["remote", "in_person", "hybrid"] as const, 2) } : {}),
      ...(r() < 0.6 ? { requirements: reqKinds.map((kind) => ({ kind, quantity: 1 + Math.floor(r() * 2) })) } : {}),
      ...(r() < 0.5 ? { skills: skills.map((s) => s.id) } : {}),
    },
  });
  // Expected cycles need an opening date to count as "opening soon".
  const opensOn = card.status === "expected" || card.status === "relaunched" ? localAdd(today, Math.floor(r() * 60) - 5) : card.opensOn;
  const rules = r() < 0.3 ? null : minimalRules(card.programCycleId, years, r() < 0.5);
  return { ...card, opensOn, rules };
}

function localAdd(today: string, days: number): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function shuffle<T>(r: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

const NUMERIC_KEYS = new Set(["v", "daysLeft", "prepDays", "prepHours", "met", "total", "strong", "good", "stretch", "considered", "shown", "letters", "essays", "hours", "minutes", "doableNow"]);
const FORBIDDEN = new Set<string>(FORBIDDEN_STUDENT_SCORE_FIELDS);

function walkKeys(value: unknown, visit: (key: string, v: unknown) => void): void {
  if (Array.isArray(value)) value.forEach((x) => walkKeys(x, visit));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v);
      walkKeys(v, visit);
    }
  }
}

const CASES = 150;
const BASE_NOW = Date.UTC(2026, 10, 11, 15);

describe("properties of findMatches, pickFirstDoor and planFirstApplication", () => {
  const runs: { seed: number; prefs: StudentPreferences; programs: OnboardingProgram[]; now: number; set: MatchSet; k: number }[] = [];
  for (let seed = 1; seed <= CASES; seed++) {
    const r = rng(seed);
    const now = BASE_NOW + Math.floor(r() * 300) * 86_400_000 + Math.floor(r() * 86_400_000);
    const prefs = randomPreferences(r);
    const today = localDateIn(now, prefs.timeZone ?? "America/New_York");
    const programs = Array.from({ length: 5 + Math.floor(r() * 35) }, (_, i) => randomProgram(r, today, i));
    const k = 1 + Math.floor(r() * 15);
    runs.push({ seed, prefs, programs, now, k, set: findMatches({ preferences: prefs, programs, now, k }) });
  }

  it("is deterministic and independent of input order", () => {
    for (const run of runs) {
      const again = findMatches({ preferences: run.prefs, programs: run.programs, now: run.now, k: run.k });
      expect(again).toEqual(run.set);
      const shuffled = findMatches({ preferences: run.prefs, programs: shuffle(rng(run.seed * 7), run.programs), now: run.now, k: run.k });
      expect(shuffled).toEqual(run.set);
    }
  });

  it("never returns a score, percentage or fused value: numbers appear only as counts and days", () => {
    for (const run of runs) {
      expect(MatchSetSchema.safeParse(run.set).success).toBe(true);
      walkKeys(run.set, (key, v) => {
        expect(FORBIDDEN.has(key)).toBe(false);
        expect(/score|percent|probab|rating|chance|rrf|relevance/i.test(key)).toBe(false);
        if (typeof v === "number") expect(NUMERIC_KEYS.has(key)).toBe(true);
      });
      expect(JSON.stringify(run.set)).not.toMatch(/\d+(\.\d+)?\s?%/);
    }
  });

  it("never recommends a closed cycle or a passed deadline", () => {
    for (const run of runs) {
      const byId = new Map(run.programs.map((p) => [p.programId, p]));
      const tz = run.prefs.timeZone ?? "America/New_York";
      for (const item of run.set.items) {
        const p = byId.get(item.programId)!;
        expect(["open", "expected", "relaunched"]).toContain(p.status);
        expect(effectiveDeadline(p, run.now, tz, run.set.asOf)).not.toBe("passed");
        if (item.feasibility.deadline !== null) expect(item.feasibility.deadline >= run.set.asOf).toBe(true);
        if (item.feasibility.enoughTime) expect(item.feasibility.startBy >= run.set.asOf).toBe(true);
        if (!item.feasibility.enoughTime) expect(item.tier).toBe("stretch");
        expect(p.flags.sensitiveAudience).toBe(false);
        // Picks to explore are always labelled stretches with time to spare, never community-specific.
        if (item.reasonCodes.includes("EXPLORE")) {
          expect(item.tier).toBe("stretch");
          expect(item.feasibility.enoughTime).toBe(true);
          expect(item.audience.identity).toBe(false);
          expect(run.set.relaxed).toBe(true);
        }
      }
    }
  });

  it("orders tiers, respects k and caps each organization at two", () => {
    const rank = { strong: 0, good: 1, stretch: 2 };
    for (const run of runs) {
      expect(run.set.items.length).toBeLessThanOrEqual(run.k);
      for (let i = 1; i < run.set.items.length; i++) expect(rank[run.set.items[i - 1]!.tier] <= rank[run.set.items[i]!.tier]).toBe(true);
      const perOrg = new Map<string, number>();
      for (const item of run.set.items) perOrg.set(item.organizationName, (perOrg.get(item.organizationName) ?? 0) + 1);
      for (const n of perOrg.values()) expect(n).toBeLessThanOrEqual(2);
      const ids = run.set.items.map((i) => i.programId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("offers first doors only from feasible matches, and plans never date a step outside today..deadline", () => {
    for (const run of runs) {
      const door = pickFirstDoor(run.set, run.prefs, run.now);
      expect(door.options.length).toBeLessThanOrEqual(3);
      expect(new Set(door.options.map((o) => o.programId)).size).toBe(door.options.length);
      for (const o of door.options) {
        const item = run.set.items.find((i) => i.programId === o.programId);
        expect(item).toBeDefined();
        expect(item?.feasibility.enoughTime).toBe(true);
        const program = run.programs.find((p) => p.programId === o.programId)!;
        const plan = planFirstApplication({ program, requirements: program.extras?.requirements ?? [], now: run.now, preferences: run.prefs });
        expect(FirstApplicationPlanSchema.safeParse(plan).success).toBe(true);
        expect(plan.steps[plan.steps.length - 1]?.kind).toBe("submit");
        // Nothing after the submit step, and the submit step never after the deadline.
        const submitDue = plan.steps[plan.steps.length - 1]?.due ?? plan.asOf;
        if (plan.deadline) expect(submitDue <= plan.deadline).toBe(true);
        const last = submitDue;
        for (const s of plan.steps) {
          if (!s.due) continue;
          expect(s.due >= plan.asOf).toBe(true);
          expect(s.due <= last).toBe(true);
        }
      }
    }
  });
});
