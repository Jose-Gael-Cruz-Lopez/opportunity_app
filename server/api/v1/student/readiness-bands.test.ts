import { describe, expect, it } from "vitest";
import { EMPTY_STUDENT_PROFILE, FORBIDDEN_STUDENT_SCORE_FIELDS, ReadinessReportSchema, type StageOdds, type StudentProfile } from "@shared/contracts";
import { BandModelSchema } from "@shared/readiness";
import { BAND_READ_FAILURES, bandModelKey, splitModelByProgram } from "@shared/readiness/bands-store";
import { FIXTURE_FITTED_ON, FIXTURE_PROGRAM_ID, FIXTURE_TYPE, fixtureBandModel, type FixtureOptions } from "@shared/readiness/bands-store/testing";
import * as bandsRepo from "@server/db/repos/bands";
import * as s from "@server/db/schema";
import { uuidv7 } from "@server/db/columns";
import { seededDb } from "@server/db/testing/fixtures";
import { computeReadiness, type ReadinessRequest } from "./readiness";
import {
  computeReadinessWithBands,
  createD1ReadinessBandsSource,
  loadBandedReadiness,
  NO_BAND_FACTS,
  nominationGatedFor,
  reportsBandedLabel,
  resolveReadinessBands,
  type ProgramBandFacts,
  type ReadinessBandsSource,
} from "./readiness-bands";
import { MemoryStudentStore, SAMPLE_GPA_SOURCE, SAMPLE_SENSITIVE_SOURCE, SAMPLE_SOURCE, sampleId } from "./testing";
import type { ReadinessSource } from "./ports";

const NOW = Date.parse("2026-11-11T15:00:00Z");
const USER = "00000000-0000-4000-8000-00000000a001";
const KEY = bandModelKey(FIXTURE_TYPE, "applicants", "awards");
const OPTS = { now: NOW, browserTimeZone: null, methodologyUrl: "https://example.org/methods" };

const odds = (from: StageOdds["fromStage"], to: StageOdds["toStage"], k: number, n: number): StageOdds => ({
  fromStage: from,
  toStage: to,
  cycleYear: 2026,
  numerator: k,
  denominator: n,
  denominatorKind: "exact",
  sourceUrl: "https://example.org/sample-results",
  verifiedAt: "2026-10-01",
  verifiedBy: "Novus Curator AB",
});

/** An invented, non-nominated program with official applicants -> awards counts. */
function bandSource(programId = FIXTURE_PROGRAM_ID): ReadinessSource {
  return {
    ...SAMPLE_GPA_SOURCE,
    program: { ...SAMPLE_GPA_SOURCE.program, id: programId, slug: "sample-band-program", newProgram: false },
    stageOdds: [odds("applicants", "awards", 30, 300)],
  };
}

function rows(opts: FixtureOptions = {}, programIds = [FIXTURE_PROGRAM_ID]) {
  return splitModelByProgram(BandModelSchema.parse(fixtureBandModel({ programIds, ...opts })), { fittedOn: FIXTURE_FITTED_ON, algo: "bands-fit-v1" });
}

function facts(over: Partial<ProgramBandFacts> = {}, opts: FixtureOptions = {}): ProgramBandFacts {
  return { rows: rows(opts), opportunityTypes: [FIXTURE_TYPE], approvedModelKeys: [KEY], heldCycleIds: [], countedReports: 12, ...over };
}

function profile(gpaBand: string | null): StudentProfile {
  return { ...EMPTY_STUDENT_PROFILE, classYear: "second_year", gpaBand: gpaBand as StudentProfile["gpaBand"], timeZone: "America/Chicago" };
}

function request(source: ReadinessSource, gpaBand: string | null = "3_75_plus"): ReadinessRequest {
  return { source, profile: profile(gpaBand), trackerItem: null, progress: [], tracked: [], institution: null, participates: false, now: NOW, browserTimeZone: null, methodologyUrl: OPTS.methodologyUrl };
}

function fixedSource(f: ProgramBandFacts): ReadinessBandsSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async programBandFacts(programId) {
      calls.push(programId);
      return f;
    },
  };
}

function memoryStore(source: ReadinessSource, gpaBand: string | null = "3_75_plus"): MemoryStudentStore {
  const store = new MemoryStudentStore({ sources: [source, SAMPLE_SENSITIVE_SOURCE] });
  store.profiles.set(USER, profile(gpaBand));
  return store;
}

function expectNoScore(report: unknown): void {
  const json = JSON.stringify(report);
  for (const f of FORBIDDEN_STUDENT_SCORE_FIELDS) expect(json.includes(`"${f}"`)).toBe(false);
  // Failure codes stay on the server.
  for (const f of BAND_READ_FAILURES) expect(json.includes(f)).toBe(false);
}

describe("reportsBanded through shared/disclosure", () => {
  it("says nothing for zero, 'fewer than 5' below the public minimum, then the released band", () => {
    expect(reportsBandedLabel(0)).toBeNull();
    expect(reportsBandedLabel(-1)).toBeNull();
    expect(reportsBandedLabel(1.5)).toBeNull();
    expect(reportsBandedLabel(3)).toBe("fewer than 5 verified reports");
    expect(reportsBandedLabel(12)).toMatch(/^\S+ verified reports$/);
    expect(reportsBandedLabel(12)).not.toContain("12");
  });
});

describe("computeReadinessWithBands", () => {
  it("with no band facts the report is identical to computeReadiness", () => {
    for (const source of [SAMPLE_SOURCE, SAMPLE_GPA_SOURCE, bandSource()]) {
      const req = request(source);
      expect(computeReadinessWithBands(req, NO_BAND_FACTS).detail).toEqual(computeReadiness(req));
    }
  });

  it("uses shared/readiness's nomination rule (the stage it reports matches)", () => {
    for (const source of [SAMPLE_SOURCE, SAMPLE_GPA_SOURCE]) {
      const { detail } = computeReadinessWithBands(request(source), NO_BAND_FACTS);
      const gated = nominationGatedFor(source, detail.report.eligibility);
      expect(detail.report.competitiveness.basis.currentStage).toBe(gated ? "campus_applicants" : "applicants");
    }
    expect(nominationGatedFor(SAMPLE_SOURCE, null)).toBe(true);
    expect(nominationGatedFor(SAMPLE_GPA_SOURCE, null)).toBe(false);
  });

  it("gates on: a personal band word beside the official counts, and the released report count", () => {
    const { detail, bands } = computeReadinessWithBands(request(bandSource()), facts());
    const c = detail.report.competitiveness;
    expect(bands.modelKey).toBe(KEY);
    expect([c.status, c.band, c.basis.kind]).toEqual(["available", "above_typical", "outcome_model"]);
    expect(c.basis.reportsBanded).toBe(reportsBandedLabel(12));
    expect(c.basis.stageOdds).toHaveLength(1);
    expect(c.basis.nEff).toBe(60);
    expect(ReadinessReportSchema.safeParse(detail.report).success).toBe(true);
    expectNoScore(detail.report);
    expect(computeReadinessWithBands(request(bandSource(), "3_0_to_3_24"), facts()).detail.report.competitiveness.band).toBe("below_typical");
  });

  const OFF: [string, Partial<ProgramBandFacts>, FixtureOptions][] = [
    ["not approved now", { approvedModelKeys: [] }, {}],
    ["a held cycle", { heldCycleIds: [sampleId(299)] }, {}],
    ["the type no longer matches", { opportunityTypes: ["another_type"] }, {}],
    ["fairness failed", {}, { gates: { fairness: false } }],
    ["calibration failed", {}, { gates: { heldOut: "fail_calibration" } }],
    ["skill failed", {}, { gates: { heldOut: "fail_skill" } }],
    ["usefulness failed", {}, { gates: { usefulness: false } }],
    ["representativeness failed", {}, { gates: { representativeness: false } }],
    ["pooled sample too small", {}, { gates: { pooled: false } }],
    ["the program's own counts too small", {}, { eligible: false }],
    ["a model for another transition", {}, { fromStage: "nominees" }],
    ["no stored model", { rows: [] }, {}],
  ];

  it.each(OFF)("gates off (%s): official base rate only", (_name, over, opts) => {
    const { detail, bands } = computeReadinessWithBands(request(bandSource()), facts(over, opts));
    const c = detail.report.competitiveness;
    expect(bands.bandModel).toBeNull();
    expect(bands.failures.length).toBeGreaterThan(0);
    expect([c.status, c.band, c.basis.kind, c.basis.modelVersion]).toEqual(["official_odds_only", null, "official_counts", null]);
    expect(c.basis.reportsBanded).toBe(reportsBandedLabel(12));
    expect(c.basis.summary).toContain("1 in 10");
    expectNoScore(detail.report);
  });

  it("a stale model is not used (freshness is counted from the server's UTC day)", () => {
    const later = { ...request(bandSource()), now: Date.parse("2027-01-05T12:00:00Z") };
    const { detail, bands } = computeReadinessWithBands(later, facts());
    expect(bands.failures).toEqual(["stale_model"]);
    expect(detail.report.competitiveness.band).toBeNull();
  });

  it("a campus applicant gets the national model 'if nominated', never a campus-stage model", () => {
    const gated: ReadinessSource = {
      ...SAMPLE_SOURCE,
      program: { ...SAMPLE_SOURCE.program, id: FIXTURE_PROGRAM_ID },
      stageOdds: [odds("campus_applicants", "nominees", 60, 400), odds("nominees", "awards", 20, 200)],
    };
    const campusKey = bandModelKey(FIXTURE_TYPE, "campus_applicants", "nominees");
    const campusOnly = { ...facts(), rows: rows({ fromStage: "campus_applicants", toStage: "nominees" }), approvedModelKeys: [campusKey] };
    const none = computeReadinessWithBands(request(gated), campusOnly);
    expect(none.bands.failures).toEqual(["no_model"]);
    expect(none.detail.report.competitiveness.band).toBeNull();

    const nationalKey = bandModelKey(FIXTURE_TYPE, "nominees", "awards");
    const national = { ...facts(), rows: rows({ fromStage: "nominees", toStage: "awards" }), approvedModelKeys: [nationalKey] };
    const { detail, bands } = computeReadinessWithBands(request(gated), national);
    expect(bands.modelKey).toBe(nationalKey);
    expect(detail.report.competitiveness.band).toBe("above_typical");
    expect(detail.report.competitiveness.basis.summary).toContain("if you are nominated");
  });

  it("a status-defined program gets neither a band nor a report count", () => {
    const r = resolveReadinessBands(facts(), { source: { ...bandSource(), program: { ...bandSource().program, sensitiveAudience: true } }, nominationGated: false, nowMs: NOW });
    expect(r).toEqual({ bandModel: null, reportsBanded: null, modelKey: null, failures: ["sensitive_program"] });
  });
});

describe("loadBandedReadiness (drop-in for the readiness route's loader)", () => {
  it("reads band facts for the program and returns the banded report", async () => {
    const source = bandSource();
    const bandsSource = fixedSource(facts());
    const loaded = await loadBandedReadiness(memoryStore(source), bandsSource, USER, source.cycle.id, OPTS);
    expect(bandsSource.calls).toEqual([FIXTURE_PROGRAM_ID]);
    expect(loaded!.detail.report.competitiveness.band).toBe("above_typical");
    expect(loaded!.profile.gpaBand).toBe("3_75_plus");
  });

  it("without a bands source, or with gates off, shows the official base rate", async () => {
    const source = bandSource();
    const none = await loadBandedReadiness(memoryStore(source), null, USER, source.cycle.id, OPTS);
    expect([none!.detail.report.competitiveness.status, none!.detail.report.competitiveness.basis.reportsBanded]).toEqual(["official_odds_only", null]);
    const off = await loadBandedReadiness(memoryStore(source), fixedSource(facts({ approvedModelKeys: [] })), USER, source.cycle.id, OPTS);
    expect(off!.detail.report.competitiveness.band).toBeNull();
  });

  it("a profile without the coded GPA band gets no band word", async () => {
    const source = bandSource();
    const loaded = await loadBandedReadiness(memoryStore(source, "3_5_to_3_74"), fixedSource(facts()), USER, source.cycle.id, OPTS);
    expect(loaded!.detail.report.competitiveness.band).toBeNull();
    expect(loaded!.detail.report.competitiveness.reason).toBe("profile_incomplete");
  });

  it("unknown cycles and status-defined programs are 404 and never read band facts", async () => {
    const bandsSource = fixedSource(facts());
    const store = memoryStore(bandSource());
    expect(await loadBandedReadiness(store, bandsSource, USER, SAMPLE_SENSITIVE_SOURCE.cycle.id, OPTS)).toBeNull();
    expect(await loadBandedReadiness(store, bandsSource, USER, sampleId(999), OPTS)).toBeNull();
    expect(bandsSource.calls).toEqual([]);
  });
});

describe("end to end over D1: stored rows, live approval and holds decide the band", () => {
  it("stores the fit per program, then gates it at read time", async () => {
    const t = await seededDb("2026-11-11");
    const program = t.seed.programs.find((p) => !p.sensitiveAudience && (p.identityAudience ?? []).length === 0)!;
    const programId = program.id as string;
    const cycleId = t.seed.programCycles.find((c) => c.programId === programId)!.id as string;
    const type = t.seed.programTypes.find((pt) => pt.programId === programId)!.typeSlug as string;
    const model = BandModelSchema.parse(fixtureBandModel({ programIds: [programId], opportunityType: type }));
    const key = bandModelKey(type, "applicants", "awards");
    await bandsRepo.storeProgramBandModels(t.db, { key, fittedOn: FIXTURE_FITTED_ON, algo: "bands-fit-v1", model }, NOW);

    const source: ReadinessSource = { ...bandSource(programId), cycle: { ...bandSource().cycle, id: cycleId } };
    const store = memoryStore(source);
    const d1 = createD1ReadinessBandsSource(t.db);
    const read = async () => (await loadBandedReadiness(store, d1, USER, cycleId, OPTS))!;

    // Stored and passing every fitted gate, but no founder approval yet: official base rate.
    expect((await read()).bands.failures).toEqual(["not_approved"]);
    expect((await read()).detail.report.competitiveness.band).toBeNull();

    await t.db.insert(s.reviewTasks).values({
      id: uuidv7(NOW),
      kind: "band_model_approval",
      subjectType: "program",
      subjectId: programId,
      dedupeKey: `band_model_approval:program:${key}`,
      state: "approved",
      payload: { modelKey: key, modelFingerprint: await bandsRepo.bandModelFingerprint(model) },
      createdAt: NOW,
      updatedAt: NOW,
    });
    const live = await read();
    expect(live.bands.modelKey).toBe(key);
    expect(live.detail.report.competitiveness.band).toBe("above_typical");

    // A hold on any of the program's cycles turns it off at the next read.
    await bandsRepo.holdCycle(t.db, { programCycleId: cycleId, reason: "over_count" }, NOW);
    const held = await read();
    expect(held.bands.failures).toEqual(["cycle_held"]);
    expect(held.detail.report.competitiveness.status).toBe("official_odds_only");

    await bandsRepo.releaseCycleHolds(t.db, cycleId, NOW + 1);
    expect((await read()).detail.report.competitiveness.band).toBe("above_typical");

    // A refit that fails fairness supersedes the live row: off again.
    const unfair = BandModelSchema.parse(fixtureBandModel({ programIds: [programId], opportunityType: type, gates: { fairness: false } }));
    await bandsRepo.storeProgramBandModels(t.db, { key, fittedOn: "2026-11-02", algo: "bands-fit-v1", model: unfair }, NOW + 2);
    expect((await read()).bands.failures).toEqual(["fairness"]);
  });
});
