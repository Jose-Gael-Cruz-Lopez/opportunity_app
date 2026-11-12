import { describe, expect, it } from "vitest";
import { assessReadiness, assessReadinessDetailed, type ReadinessInput, type TrackedWorkload } from "./assess";
import { aggregateBandCells, fitBandModel, toBandModel } from "./bands";
import { epochDayOf, isoFromEpochDay } from "./calendar";
import type { DeadlineLike } from "./deadline";
import { createRng, type Rng } from "./math/random";
import { applyItemKey, prepItemKey } from "./next-actions";
import type { RequirementLike } from "./requirements";
import { SYNTHETIC_SPECS, syntheticProgramId, syntheticReportSample } from "./synthetic";
import {
  APPLICATION_DEADLINE,
  CAMPUS_ID,
  CYCLE_ID,
  GOLDWATER_DEADLINE,
  GOLDWATER_NOMINATION,
  SAMPLE_CHECKLIST,
  GOLDWATER_STAGE_ODDS,
  PROGRAM_ID,
  TRUMAN_STAGE_ODDS,
  conditionalEligibility,
  eligibleResult,
  fixtureId,
  notEligibleResult,
} from "./test-fixtures";
import { findSensitiveKeys } from "../contracts/sensitive";
import { FORBIDDEN_STUDENT_SCORE_FIELDS, ReadinessReportSchema } from "../contracts/readiness";
import { ItemKeySchema } from "../contracts/roadmap";
import { REQUIREMENT_KINDS } from "../taxonomy";

/** 7.4.3's example: a community-college sophomore in biology looks at Goldwater 2027 on 9 Nov 2026. */
function goldwaterInput(extra: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    program: { id: PROGRAM_ID, slug: "goldwater-scholarship" },
    cycle: { id: CYCLE_ID, cycleKey: "ay-2026-27" },
    deadlines: [GOLDWATER_DEADLINE],
    requirements: SAMPLE_CHECKLIST,
    requirementsChecked: true,
    eligibility: conditionalEligibility(),
    nomination: GOLDWATER_NOMINATION,
    profile: { timeZone: "America/Chicago", institutionId: CAMPUS_ID, classYear: "second_year", gpaBand: "3_5_to_3_74", priorExperience: [] },
    stageOdds: GOLDWATER_STAGE_ODDS,
    now: "2026-11-09T15:00:00Z",
    ...extra,
  };
}

/** Walks a JSON value and yields every key and every number. */
function walk(value: unknown, onKey: (k: string) => void, onNumber: (n: number) => void): void {
  if (typeof value === "number") onNumber(value);
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v) => walk(v, onKey, onNumber));
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    onKey(k);
    walk(v, onKey, onNumber);
  }
}

describe("assessReadiness: the 7.4.3 golden example", () => {
  const detail = assessReadinessDetailed(goldwaterInput());
  const report = detail.report;

  it("returns exactly the four parts and validates against the contract", () => {
    expect(ReadinessReportSchema.parse(report)).toEqual(report);
    expect(Object.keys(report).sort()).toEqual(
      ["algoVersion", "competitiveness", "cycleKey", "eligibility", "generatedAt", "nextActions", "programCycleId", "programSlug", "requirements"].sort(),
    );
  });

  it("part 1 shows the evaluator's conditional result unchanged", () => {
    expect(report.eligibility).toEqual(conditionalEligibility());
    expect(detail.eligibilitySummary.headline).toBe("Eligible if 2 more rules apply to you.");
  });

  it("part 2 counts back from the estimated campus deadline: letters and essay are already late", () => {
    expect(report.requirements.effectiveDeadline).toEqual({
      date: "2026-11-20",
      basis: "estimated",
      scope: "campus",
      label: "Estimated: confirm with your campus representative",
    });
    const byKind = Object.fromEntries(report.requirements.items.map((i) => [i.kind, i]));
    expect([byKind.recommendation!.startBy, byKind.recommendation!.severity]).toEqual(["2026-10-27", "late"]);
    expect([byKind.essay!.startBy, byKind.essay!.severity]).toEqual(["2026-10-31", "late"]);
    expect([byKind.campus_nomination!.startBy, byKind.campus_nomination!.severity]).toEqual(["2026-11-17", "soon"]);
    expect(byKind.recommendation!.gap).toBe("Ask three recommenders for letters");
  });

  it("part 3 shows official counts only, the national stage 'if nominated', and no campus-stage estimate", () => {
    const c = report.competitiveness;
    expect(c.status).toBe("official_odds_only");
    expect(c.band).toBeNull();
    expect(c.basis.kind).toBe("official_counts");
    expect(c.basis.currentStage).toBe("campus_applicants");
    expect(c.basis.summary).toContain("If you are nominated: In 2026, 454 of 1,485 nominees won: about 3 in 10.");
    expect(c.basis.summary).toContain("Novus does not estimate those odds");
    expect(c.basis.summary).toContain("at most 1 in 10");
    expect(detail.funnel.campusStage).toBe("official");
  });

  it("part 4: the first action is to confirm the real campus date with the fellowship office", () => {
    const [first, ...rest] = report.nextActions;
    expect(first!.id).toBe("campus-confirm");
    expect(first!.source).toBe("nomination");
    expect(first!.dueOn).toBe("2026-11-09");
    expect(detail.actionReasons["campus-confirm"]).toBe("CAMPUS_ESTIMATE");
    expect(report.nextActions).toHaveLength(5);
    // Private eligibility questions come before effort and stay on the device.
    expect(rest.map((a) => a.id)).toContain("eligibility-private");
    expect(rest.find((a) => a.id === "eligibility-private")!.detail).toMatch(/stay in your browser/);
    for (const a of report.nextActions) expect(ItemKeySchema.safeParse(a.roadmapItemKey).success).toBe(true);
  });

  it("cards show at most three actions", () => {
    expect(assessReadiness(goldwaterInput({ options: { maxNextActions: 3 } })).nextActions).toHaveLength(3);
  });

  it("is computed on read from the clock it is given", () => {
    expect(report.generatedAt).toBe("2026-11-09T15:00:00.000Z");
    expect(detail.today).toBe("2026-11-09");
    expect(assessReadiness(goldwaterInput({ now: Date.parse("2026-11-09T15:00:00Z") }))).toEqual(report);
  });
});

describe("assessReadiness: other states", () => {
  it("a month-only deadline whose first day has passed plans to the month's last day, not today", () => {
    const monthOnly: DeadlineLike = {
      id: fixtureId(130),
      kind: "application",
      scope: "national",
      institutionId: null,
      basis: "official",
      precision: "month_only",
      tzMode: "applicant_local",
      localDate: "2027-03",
      localTime: null,
      timeZone: null,
    };
    const d = assessReadinessDetailed({
      ...goldwaterInput(),
      deadlines: [monthOnly],
      requirements: [{ id: fixtureId(131), kind: "recommendation", label: "One letter of recommendation", quantity: 1 }],
      nomination: null,
      eligibility: eligibleResult(),
      now: "2027-03-03T15:00:00Z",
    });
    expect(d.today).toBe("2027-03-03");
    expect(d.report.requirements.effectiveDeadline!.date).toBe("2027-03-31");
    expect(d.effectiveDeadline!.earliestLikelyPassed).toBe("2027-03-01");
    expect(d.report.requirements.effectiveDeadline!.label).toContain("planning to the last likely day");
    const submit = d.report.nextActions.find((a) => a.label === "Submit your application");
    expect(submit?.dueOn).toBe("2027-03-31");
  });

  it("a month-only deadline still ahead plans to the first of the month", () => {
    const monthOnly: DeadlineLike = {
      id: fixtureId(132),
      kind: "application",
      scope: "national",
      institutionId: null,
      basis: "official",
      precision: "month_only",
      tzMode: "applicant_local",
      localDate: "2027-03",
      localTime: null,
      timeZone: null,
    };
    const d = assessReadinessDetailed({ ...goldwaterInput(), deadlines: [monthOnly], nomination: null, requirements: [], eligibility: eligibleResult(), now: "2027-02-10T15:00:00Z" });
    expect(d.report.requirements.effectiveDeadline!.date).toBe("2027-03-01");
    expect(d.effectiveDeadline!.earliestLikelyPassed).toBeUndefined();
  });

  it("after E2 the top action says the campus deadline may have passed", () => {
    const r = assessReadiness(goldwaterInput({ now: "2026-12-20T15:00:00Z" }));
    expect(r.nextActions[0]!.id).toBe("campus-passed");
    expect(r.nextActions[0]!.label).toBe("Your campus deadline may have passed: contact your fellowship office today");
    expect(r.requirements.effectiveDeadline!.scope).toBe("national");
  });

  it("a recorded campus date replaces the estimate", () => {
    const d = assessReadinessDetailed(goldwaterInput({ ownCampusDeadline: "2026-12-04" }));
    expect(d.report.requirements.effectiveDeadline).toMatchObject({ date: "2026-12-04", basis: "student_entered", scope: "campus" });
    expect(d.report.nextActions.some((a) => a.id === "campus-confirm")).toBe(false);
  });

  it("a closed cycle keeps the checklist without severities and points to the next cycle", () => {
    const r = assessReadiness(goldwaterInput({ now: "2027-02-05T15:00:00Z" }));
    expect(r.requirements.items.every((i) => i.severity === null)).toBe(true);
    expect(r.nextActions.map((a) => a.id)).toEqual(["next-cycle"]);
  });

  it("a student who is not eligible gets no effort actions", () => {
    expect(assessReadiness(goldwaterInput({ eligibility: notEligibleResult() })).nextActions).toEqual([]);
  });

  it("unchecked requirements show no checklist dates and point to the official page", () => {
    const r = assessReadiness(goldwaterInput({ requirementsChecked: false, eligibility: eligibleResult() }));
    expect(r.requirements.checked).toBe(false);
    expect(r.requirements.items).toEqual([]);
    expect(r.nextActions.map((a) => a.id)).toContain("requirements-official");
  });

  it("no rule set: eligibility is unknown with a Novus item, never eligible", () => {
    const r = assessReadiness(goldwaterInput({ eligibility: null }));
    expect(r.eligibility.status).toBe("unknown");
    expect(r.nextActions.map((a) => a.id)).toContain("eligibility-official");
  });

  it("progress marks items met, and a résumé done once counts everywhere", () => {
    const d = assessReadinessDetailed(
      goldwaterInput({
        progress: [{ subjectKey: "kind:resume", state: "met" }, { subjectKey: `req:${fixtureId(120)}`, state: "in_progress" }],
        options: { maxNextActions: 10 },
      }),
    );
    const byKind = Object.fromEntries(d.report.requirements.items.map((i) => [i.kind, i]));
    expect(byKind.resume!.state).toBe("met");
    expect(byKind.resume!.startBy).toBeNull();
    expect(byKind.recommendation!.state).toBe("in_progress");
    expect(d.report.nextActions.some((a) => a.relatesTo === fixtureId(123))).toBe(false);
    // Letters already requested get one check-in a week before the (estimated) campus date.
    const check = d.report.nextActions.find((a) => a.id === `gap:${fixtureId(120)}`)!;
    expect(check.label).toBe("Check that your recommenders have sent their letters");
    expect(check.dueOn).toBe("2026-11-13");
    expect(d.actionReasons[check.id]).toBe("CHECK_RECOMMENDER");
  });

  it("eligibility questions come before effort: due at the first suggested start", () => {
    const d = assessReadinessDetailed(goldwaterInput({ ownCampusDeadline: "2026-12-04", options: { maxNextActions: 10 } }));
    const ids = d.report.nextActions.map((a) => a.id);
    expect(ids.indexOf("eligibility-private")).toBeLessThan(ids.findIndex((id) => id.startsWith("gap:")));
    expect(ids[ids.length - 1]).toBe("submit");
  });

  it("other tracked applications share the student's hours and can raise an overload", () => {
    const heavy: TrackedWorkload[] = [0, 1, 2].map((i) => ({
      id: fixtureId(300 + i),
      requirements: [
        { id: fixtureId(310 + i), kind: "essay", label: "Essay", quantity: 3 },
        { id: fixtureId(320 + i), kind: "portfolio", label: "Portfolio" },
      ],
      deadlineDate: "2026-12-15",
    }));
    const input = goldwaterInput({ deadlines: [APPLICATION_DEADLINE], nomination: null, eligibility: eligibleResult(), requirements: SAMPLE_CHECKLIST.filter((r) => r.kind !== "campus_nomination") });
    const alone = assessReadinessDetailed(input);
    const busy = assessReadinessDetailed({ ...input, otherTracked: heavy });
    expect(alone.plan.overload).toBeNull();
    expect(busy.plan.overload).not.toBeNull();
    expect(busy.plan.neededWeeklyHours).toBeGreaterThan(busy.plan.weeklyHours);
    expect(busy.report.nextActions.map((a) => a.id)).toContain("capacity");
    expect(busy.actionReasons.capacity).toBe("OVERLOAD");
    // Shared hours can only pull start dates earlier.
    for (const item of busy.report.requirements.items) {
      const solo = alone.report.requirements.items.find((i) => i.key === item.key)!;
      if (item.startBy && solo.startBy) expect(item.startBy <= solo.startBy).toBe(true);
    }
  });

  it("competitiveness never depends on the student's school", () => {
    const a = assessReadiness(goldwaterInput()).competitiveness;
    const b = assessReadiness(goldwaterInput({ profile: { timeZone: "America/Chicago", institutionId: fixtureId(999), classYear: "second_year" } })).competitiveness;
    expect(b).toEqual(a);
  });
});

describe("assessReadiness with an approved band model (Phase 4)", () => {
  // SYNTHETIC: a strong GPA effect across 5 synthetic programs, 600 reports each type-stage.
  const sample = syntheticReportSample({
    seed: 7,
    programs: 5,
    total: 3000,
    baseRates: [0.3, 0.2, 0.25, 0.15, 0.35],
    effects: { gpaStep: 0.8, secondYear: 0, priorProgram: 0 },
    reporting: { rate: 0.3, admitRatio: 2 },
  });
  const fit = fitBandModel({ cells: aggregateBandCells(sample.reports, SYNTHETIC_SPECS), specs: SYNTHETIC_SPECS, officialRates: sample.officialRates });
  const model = toBandModel(fit, {
    modelVersion: "bands-synthetic-1",
    opportunityType: "fellowship",
    fromStage: "nominees",
    toStage: "awards",
    cycles: [2025, 2026],
    gates: { heldOut: "pass", representativeness: true, fairness: true, usefulness: true, approved: true },
    methodologyUrl: "https://example.org/methods/bands",
  });
  const programId = syntheticProgramId(0);
  const input = (gpaBand: string) =>
    goldwaterInput({
      program: { id: programId, slug: "synthetic-program" },
      bandModel: model,
      studentStage: "nominees",
      profile: { timeZone: "America/Chicago", classYear: "second_year", gpaBand, priorExperience: ["research"] },
    });

  it("shows a band word next to the official odds, never a number about the student", () => {
    const c = assessReadiness(input("3_75_plus")).competitiveness;
    expect(c.status).toBe("available");
    expect(c.band).toBe("above_typical");
    expect(c.basis.kind).toBe("outcome_model");
    expect(c.basis.summary).toContain("Above typical for nominees.");
    expect(c.basis.summary).toContain("Typical here means about 3 in 10 nominees win; most applicants at this stage are not selected.");
    expect(c.basis.nEff! % 5).toBe(0);
    walk(c, () => undefined, (n) => expect(Number.isInteger(n)).toBe(true));
    expect(assessReadiness(input("3_0_to_3_24")).competitiveness.band).toBe("below_typical");
  });

  it("raising the GPA band never lowers the band (monotone)", () => {
    const order = ["below_typical", "typical", "above_typical"];
    const bands = SYNTHETIC_SPECS[0]!.levels.map((g) => order.indexOf(assessReadiness(input(g)).competitiveness.band ?? "typical"));
    for (let i = 1; i < bands.length; i++) expect(bands[i]!).toBeGreaterThanOrEqual(bands[i - 1]!);
  });

  it("an unapproved model shows official odds only", () => {
    const r = assessReadiness({ ...input("3_75_plus"), bandModel: { ...model, gates: { ...model.gates, approved: false } } });
    expect(r.competitiveness.status).toBe("official_odds_only");
  });
});

// ---------------------------------------------------------------------------------------------
// Property tests: random cycles, deadlines, requirements, progress and workloads.
// ---------------------------------------------------------------------------------------------

const ZONES = ["America/New_York", "America/Chicago", "America/Los_Angeles", "Pacific/Honolulu", "America/Anchorage", "Asia/Tokyo"];
const pick = <T,>(rng: Rng, items: readonly T[]): T => items[rng.int(items.length)]!;

function randomDeadline(rng: Rng, n: number, date: string, kind: DeadlineLike["kind"] = "application"): DeadlineLike {
  const applicantLocal = rng.bernoulli(0.3);
  const exact = rng.bernoulli(0.6);
  return {
    id: fixtureId(400 + n),
    kind,
    scope: "national",
    institutionId: null,
    basis: "official",
    precision: exact ? "exact" : "date_only",
    tzMode: applicantLocal ? "applicant_local" : "fixed",
    localDate: date,
    localTime: exact ? `${String(rng.int(24)).padStart(2, "0")}:${pick(rng, ["00", "30", "59"])}` : null,
    timeZone: applicantLocal ? null : pick(rng, ZONES),
  };
}

function randomRequirements(rng: Rng, offset: number): RequirementLike[] {
  return Array.from({ length: 1 + rng.int(6) }, (_, i) => ({
    id: fixtureId(500 + offset + i),
    kind: pick(rng, REQUIREMENT_KINDS),
    label: `Sample requirement ${i}`,
    quantity: 1 + rng.int(3),
    effortHours: rng.bernoulli(0.2) ? rng.int(20) : null,
    leadTimeDays: rng.bernoulli(0.2) ? rng.int(40) : null,
  }));
}

function randomInput(seed: number): ReadinessInput {
  const rng = createRng(seed);
  const now = Date.parse("2026-09-01T00:00:00Z") + rng.int(200) * 86_400_000 + rng.int(86_400_000);
  const deadlineDate = isoFromEpochDay(epochDayOf("2026-10-01") + rng.int(200));
  const deadlines: DeadlineLike[] = [randomDeadline(rng, 0, deadlineDate, rng.bernoulli(0.5) ? "nomination" : "application")];
  if (rng.bernoulli(0.3)) deadlines.push(randomDeadline(rng, 1, isoFromEpochDay(epochDayOf(deadlineDate) - 20 - rng.int(30)), "priority_round"));
  if (rng.bernoulli(0.3)) {
    deadlines.push({ ...randomDeadline(rng, 2, isoFromEpochDay(epochDayOf(deadlineDate) - rng.int(90)), "campus_internal"), scope: "campus", institutionId: CAMPUS_ID, tzMode: "fixed", timeZone: "America/New_York" });
  }
  const requirements = randomRequirements(rng, 0);
  const others: TrackedWorkload[] = Array.from({ length: rng.int(4) }, (_, i) => ({
    id: fixtureId(600 + i),
    requirements: randomRequirements(rng, 100 + 10 * i),
    deadlineDate: rng.bernoulli(0.5) ? isoFromEpochDay(epochDayOf("2026-10-01") + rng.int(200)) : null,
    deadlines: [randomDeadline(rng, 10 + i, isoFromEpochDay(epochDayOf("2026-10-01") + rng.int(200)))],
  }));
  return {
    program: { id: PROGRAM_ID, slug: "sample-program", nonCompetitive: rng.bernoulli(0.1), newProgram: rng.bernoulli(0.1) },
    cycle: { id: CYCLE_ID, cycleKey: "ay-2026-27" },
    deadlines,
    requirements,
    requirementsChecked: rng.bernoulli(0.85),
    eligibility: pick(rng, [conditionalEligibility(), eligibleResult(), notEligibleResult(), null]),
    nomination: rng.bernoulli(0.4) ? GOLDWATER_NOMINATION : null,
    profile: rng.bernoulli(0.9)
      ? {
          timeZone: rng.bernoulli(0.8) ? pick(rng, ZONES) : null,
          institutionId: rng.bernoulli(0.5) ? CAMPUS_ID : null,
          weeklyPrepHours: rng.bernoulli(0.5) ? rng.int(15) : null,
          classYear: "first_year",
        }
      : null,
    ownCampusDeadline: rng.bernoulli(0.2) ? isoFromEpochDay(epochDayOf("2026-10-01") + rng.int(150)) : null,
    progress: requirements.filter(() => rng.bernoulli(0.3)).map((r) => ({ subjectKey: `req:${r.id}`, state: pick(rng, ["met", "in_progress", "not_applicable"] as const) })),
    stageOdds: pick(rng, [GOLDWATER_STAGE_ODDS, TRUMAN_STAGE_ODDS, []]),
    reportsBanded: rng.bernoulli(0.3) ? "10-19" : null,
    otherTracked: others,
    now,
    browserTimeZone: pick(rng, [...ZONES, null, "Not/AZone"]),
  };
}

function shuffled<T>(rng: Rng, items: readonly T[] | undefined): T[] {
  const out = [...(items ?? [])];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const CASES = 250;

describe("assessReadiness properties (seeded, 250 random cases each)", () => {
  it("valid contract, finite numbers, no score fields, no sensitive keys", () => {
    const forbidden = new Set<string>(FORBIDDEN_STUDENT_SCORE_FIELDS);
    for (let seed = 1; seed <= CASES; seed++) {
      const report = assessReadiness(randomInput(seed));
      expect(ReadinessReportSchema.safeParse(report).success, `seed ${seed}`).toBe(true);
      walk(
        report,
        (k) => expect(forbidden.has(k), `seed ${seed}: ${k}`).toBe(false),
        (n) => expect(Number.isFinite(n), `seed ${seed}`).toBe(true),
      );
      expect(findSensitiveKeys(report), `seed ${seed}`).toEqual([]);
    }
  });

  it("dates never fall after the deadline they serve, nor actions before today", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const d = assessReadinessDetailed(randomInput(seed));
      const effective = d.effectiveDeadline;
      if (!effective || effective.closed) continue;
      const bound = effective.date >= d.today ? effective.date : d.today;
      for (const item of d.report.requirements.items) {
        if (item.startBy) expect(item.startBy <= effective.date, `seed ${seed} ${item.key}`).toBe(true);
      }
      for (const a of d.report.nextActions) {
        if (a.dueOn === null) continue;
        expect(a.dueOn >= d.today, `seed ${seed} ${a.id}`).toBe(true);
        expect(a.dueOn <= bound, `seed ${seed} ${a.id}`).toBe(true);
      }
      for (const [key, suggested] of Object.entries(d.plan.suggestedStart)) {
        const item = d.report.requirements.items.find((i) => i.key === key)!;
        if (suggested && item.startBy) expect(suggested <= (item.startBy >= d.today ? item.startBy : d.today), `seed ${seed}`).toBe(true);
      }
    }
  });

  it("actions are ordered by date (undated last) and capped", () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const r = assessReadiness(randomInput(seed));
      expect(r.nextActions.length).toBeLessThanOrEqual(5);
      const dates = r.nextActions.map((a) => a.dueOn ?? "9999-12-31");
      expect(dates).toEqual([...dates].sort());
      expect(new Set(r.nextActions.map((a) => a.id)).size).toBe(r.nextActions.length);
    }
  });

  it("deterministic and independent of input order", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const input = randomInput(seed);
      const rng = createRng(seed + 10_000);
      const reordered: ReadinessInput = {
        ...input,
        deadlines: shuffled(rng, input.deadlines),
        requirements: shuffled(rng, input.requirements),
        progress: shuffled(rng, input.progress),
        stageOdds: shuffled(rng, input.stageOdds),
        otherTracked: shuffled(rng, input.otherTracked),
      };
      const a = JSON.stringify(assessReadiness(input));
      expect(JSON.stringify(assessReadiness(input))).toBe(a);
      const b = assessReadiness(reordered);
      // Checklist order follows requirement ids, so the whole report is identical.
      expect(JSON.stringify(b), `seed ${seed}`).toBe(a);
    }
  });

  it("sensitive answers smuggled onto the profile change nothing (allowlist read)", () => {
    for (let seed = 1; seed <= 120; seed++) {
      const input = randomInput(seed);
      if (!input.profile) continue;
      const smuggled = { ...input.profile, citizenship: "us_citizen", pell: "yes", firstGeneration: "yes", identity: { race: ["prefer_not"] } };
      expect(JSON.stringify(assessReadiness({ ...input, profile: smuggled }))).toBe(JSON.stringify(assessReadiness(input)));
    }
  });

  it("more weekly hours or less work never moves a start-by date earlier (monotone)", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const input = randomInput(seed);
      const hours = 1 + (seed % 10);
      const withHours = (h: number): ReadinessInput => ({ ...input, profile: { ...(input.profile ?? {}), weeklyPrepHours: h } });
      const base = assessReadiness(withHours(hours));
      const more = assessReadiness(withHours(hours * 2));
      for (const item of base.requirements.items) {
        const other = more.requirements.items.find((i) => i.key === item.key)!;
        if (item.startBy && other.startBy) expect(other.startBy >= item.startBy, `seed ${seed}`).toBe(true);
      }
      const first = input.requirements[0]!;
      const lighter = assessReadiness({ ...withHours(hours), progress: [...(input.progress ?? []), { subjectKey: `req:${first.id}`, state: "met" }] });
      for (const item of base.requirements.items) {
        if (item.key === first.id) continue;
        const other = lighter.requirements.items.find((i) => i.key === item.key)!;
        if (item.startBy && other.startBy) expect(other.startBy >= item.startBy, `seed ${seed}`).toBe(true);
      }
    }
  });
});

describe("roadmap item keys", () => {
  it("fit the Roadmap's item-key pattern even for long or odd subjects", () => {
    expect(applyItemKey(PROGRAM_ID, "ay-2026-27")).toBe(`apply:${PROGRAM_ID}:ay-2026-27`);
    const long = prepItemKey(PROGRAM_ID, "ay-2026-27", "kind:resume with spaces/and/slashes".repeat(5));
    expect(ItemKeySchema.safeParse(long).success).toBe(true);
    expect(ItemKeySchema.safeParse(applyItemKey(PROGRAM_ID, "x".repeat(200))).success).toBe(true);
  });
});
