import { describe, expect, it } from "vitest";
import { aggregateBandCells, fitBandModel, toBandModel, type BandModel } from "./bands";
import { assessCompetitiveness, BAND_LABELS, displayedNEff, type CompetitivenessInput } from "./competitiveness";
import { SYNTHETIC_SPECS, syntheticProgramId, syntheticReportSample } from "./synthetic";
import { GOLDWATER_STAGE_ODDS, TRUMAN_STAGE_ODDS } from "./test-fixtures";
import { CompetitivenessSchema, FORBIDDEN_STUDENT_SCORE_FIELDS, type Competitiveness } from "../contracts/readiness";

const base: CompetitivenessInput = { stageOdds: TRUMAN_STAGE_ODDS, nominationGated: true, sensitiveAudience: false };

/** Every number in a competitiveness object is a program-level integer (counts, years, n_eff). */
function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number") out.push(value);
  else if (value && typeof value === "object") for (const v of Object.values(value)) numbersIn(v, out);
  return out;
}

function expectValid(c: Competitiveness): void {
  expect(CompetitivenessSchema.safeParse(c).success).toBe(true);
  expect(c.basis.summary.length).toBeLessThanOrEqual(400);
  for (const n of numbersIn(c)) expect(Number.isInteger(n)).toBe(true);
  const keys = JSON.stringify(c);
  for (const f of FORBIDDEN_STUDENT_SCORE_FIELDS) expect(keys.includes(`"${f}"`)).toBe(false);
  // Never a percentage or a Reach/Target/Safety label.
  expect(c.basis.summary).not.toMatch(/%|percent|reach|target|safety|likely/i);
}

function syntheticModel(gates: Partial<BandModel["gates"]> = {}, effects = { gpaStep: 0.8, secondYear: 0, priorProgram: 0 }): BandModel {
  const sample = syntheticReportSample({ seed: 11, programs: 5, total: 3000, baseRates: [0.07, 0.1, 0.12, 0.08, 0.09], effects, reporting: { rate: 0.3, admitRatio: 2 } });
  const fit = fitBandModel({ cells: aggregateBandCells(sample.reports, SYNTHETIC_SPECS), specs: SYNTHETIC_SPECS, officialRates: sample.officialRates });
  return toBandModel(fit, {
    modelVersion: "bands-synthetic-1",
    opportunityType: "fellowship",
    fromStage: "nominees",
    toStage: "awards",
    cycles: [2025, 2026],
    gates: { heldOut: "pass", representativeness: true, fairness: true, usefulness: true, approved: true, ...gates },
    methodologyUrl: null,
  });
}

describe("official counts first (Phase 2)", () => {
  it("a nominee sees the official k of n for their stage as a natural frequency", () => {
    const c = assessCompetitiveness({ ...base, studentStage: "nominees" });
    expectValid(c);
    expect(c.status).toBe("official_odds_only");
    expect(c.basis.summary).toMatch(/^In 2026, 55 of 781 nominees won: about 7 in 100\./);
    expect(c.basis.summary).toContain("Personal bands need about 30 verified reports");
    expect(c.basis.cycles).toEqual([2026]);
  });

  it("a campus applicant sees the national stage 'if nominated' and the campus stage as set by the campus", () => {
    const c = assessCompetitiveness({ ...base, stageOdds: GOLDWATER_STAGE_ODDS });
    expectValid(c);
    expect(c.basis.currentStage).toBe("campus_applicants");
    expect(c.basis.summary).toContain("If you are nominated: In 2026, 454 of 1,485 nominees won: about 3 in 10.");
    expect(c.basis.summary).toContain("Your campus decides its own nominations; Novus does not estimate those odds.");
    // P(nominated) × P(award | nominated) telescopes to awards ÷ pool: a program-level upper bound.
    expect(c.basis.summary).toContain("Across the whole program, at most 1 in 10 campus applicants won.");
  });

  it("no counts: insufficient data with the right reason", () => {
    const none = assessCompetitiveness({ ...base, stageOdds: [] });
    expectValid(none);
    expect([none.status, none.reason]).toEqual(["insufficient_data", "no_official_counts"]);
    expect(assessCompetitiveness({ ...base, stageOdds: [], newProgram: true }).reason).toBe("new_program");
    expect(assessCompetitiveness({ ...base, stageOdds: [], sensitiveAudience: true }).reason).toBe("sensitive_program");
  });

  it("programs that do not select have no competitiveness at all", () => {
    const c = assessCompetitiveness({ ...base, nonCompetitive: true });
    expectValid(c);
    expect([c.status, c.basis.kind, c.basis.stageOdds.length]).toEqual(["not_applicable", "none", 0]);
  });

  it("sensitive-audience programs show official counts only: no report count, no band", () => {
    const c = assessCompetitiveness({ ...base, sensitiveAudience: true, reportsBanded: "10-19", band: { model: syntheticModel(), programId: syntheticProgramId(0), levels: { gpa_band: "3_75_plus", class_standing: "first_year", prior_program: "no" } } });
    expectValid(c);
    expect([c.status, c.basis.reportsBanded, c.band]).toEqual(["official_odds_only", null, null]);
  });

  it("passes the released report band through unchanged", () => {
    expect(assessCompetitiveness({ ...base, reportsBanded: "10-19" }).basis.reportsBanded).toBe("10-19");
  });
});

describe("personal bands (Phase 4) only behind every gate", () => {
  const levels = (gpa: string) => ({ gpa_band: gpa, class_standing: "second_year", prior_program: "no" });
  const programId = syntheticProgramId(0);

  it("an approved model gives a band word, the official anchor and banded n_eff", () => {
    const model = syntheticModel();
    const c = assessCompetitiveness({ ...base, stageOdds: TRUMAN_STAGE_ODDS, studentStage: "nominees", band: { model, programId, levels: levels("3_75_plus") } });
    expectValid(c);
    expect(c.status).toBe("available");
    expect(c.band).toBe("above_typical");
    expect(c.basis.summary.startsWith("Above typical for nominees.")).toBe(true);
    expect(c.basis.summary).toContain("Typical here means about 7 in 100 nominees win; most applicants at this stage are not selected.");
    expect(c.basis.summary).toContain("it is not a prediction");
    expect(c.basis.factors.map((f) => [f.code, f.direction])).toContainEqual(["BAND_FACTOR_GPA_BAND", "helps"]);
    expect(c.basis.nEff! % 5).toBe(0);
    expect(c.basis.modelVersion).toBe("bands-synthetic-1");
  });

  it("below typical suggests applying to several programs", () => {
    const c = assessCompetitiveness({ ...base, studentStage: "nominees", band: { model: syntheticModel(), programId, levels: levels("3_0_to_3_24") } });
    expect(c.band).toBe("below_typical");
    expect(c.basis.summary).toContain("Many students apply to several programs.");
  });

  it("a failed skill or usefulness gate reads 'same for everyone'; failed calibration shows official odds only", () => {
    const skill = assessCompetitiveness({ ...base, studentStage: "nominees", band: { model: syntheticModel({ heldOut: "fail_skill" }), programId, levels: levels("3_75_plus") } });
    expect([skill.status, skill.band]).toEqual(["available", "same_for_everyone"]);
    expect(BAND_LABELS.same_for_everyone).toBe("Same for everyone at this stage");
    const useless = assessCompetitiveness({ ...base, studentStage: "nominees", band: { model: syntheticModel({ usefulness: false }), programId, levels: levels("3_75_plus") } });
    expect(useless.band).toBe("same_for_everyone");
    for (const gates of [{ heldOut: "fail_calibration" as const }, { fairness: false }, { representativeness: false }, { approved: false }, { heldOut: "not_evaluated" as const }]) {
      const c = assessCompetitiveness({ ...base, studentStage: "nominees", band: { model: syntheticModel(gates), programId, levels: levels("3_75_plus") } });
      expect(c.status).toBe("official_odds_only");
    }
  });

  it("an unknown program or too few reports: official odds plus 'not enough verified reports yet'", () => {
    const c = assessCompetitiveness({ ...base, studentStage: "nominees", band: { model: syntheticModel(), programId: "not-in-the-model", levels: levels("3_75_plus") } });
    expect(c.status).toBe("official_odds_only");
    expect(c.reason).toBe("too_few_reports");
    expect(c.basis.summary).toContain("Not enough verified reports yet");
  });

  it("a missing profile level asks for it instead of guessing", () => {
    const c = assessCompetitiveness({ ...base, studentStage: "nominees", band: { model: syntheticModel(), programId, levels: { class_standing: "second_year", prior_program: "no" } } });
    expect([c.status, c.reason]).toEqual(["official_odds_only", "profile_incomplete"]);
  });

  it("n_eff is shown rounded down to a multiple of five", () => {
    expect(displayedNEff(31.9)).toBe(30);
    expect(displayedNEff(250)).toBe(250);
    expect(displayedNEff(Number.NaN)).toBe(0);
  });
});
