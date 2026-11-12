import { describe, expect, it } from "vitest";
import { assessReadiness } from "../assess";
import { BandModelSchema, type BandModel } from "../bands";
import { allBandGatesPass } from "../outcomes";
import type { StageOdds } from "../../contracts/registry";
import {
  BAND_READ_FAILURES,
  bandModelKey,
  daysBetween,
  decideProgramBand,
  everyGatePasses,
  HELD_OUT_OUTCOMES,
  sliceModelForProgram,
  splitModelByProgram,
  type BandReadContext,
  type ProgramBandRow,
  type StoredGateFlags,
} from "./index";
import { FIXTURE_FITTED_ON, FIXTURE_OTHER_PROGRAM_ID, FIXTURE_PROGRAM_ID, FIXTURE_TYPE, fixtureBandModel, type FixtureOptions } from "./testing";

const KEY = bandModelKey(FIXTURE_TYPE, "applicants", "awards");

function model(opts: FixtureOptions = {}): BandModel {
  return BandModelSchema.parse(fixtureBandModel(opts));
}

function rowsFor(opts: FixtureOptions = {}, fittedOn = FIXTURE_FITTED_ON): ProgramBandRow<BandModel | null>[] {
  return splitModelByProgram(model(opts), { fittedOn, algo: "bands-fit-v1" });
}

function ownRow(opts: FixtureOptions = {}, fittedOn = FIXTURE_FITTED_ON): ProgramBandRow<BandModel | null> {
  return rowsFor(opts, fittedOn).find((r) => r.programId === FIXTURE_PROGRAM_ID)!;
}

const GATES_ON: BandReadContext = {
  programId: FIXTURE_PROGRAM_ID,
  opportunityTypes: [FIXTURE_TYPE],
  sensitiveAudience: false,
  transition: { fromStage: "applicants", toStage: "awards" },
  today: "2026-11-11",
  approvedModelKeys: [KEY],
  heldCycleIds: [],
};

describe("per-program storage shape", () => {
  it("splits one fitted model into one row per program, each holding only its own entry", () => {
    const rows = rowsFor();
    expect(rows.map((r) => r.programId)).toEqual([FIXTURE_PROGRAM_ID, FIXTURE_OTHER_PROGRAM_ID].sort());
    for (const row of rows) {
      expect(row.modelKey).toBe(`${FIXTURE_TYPE}.applicants-awards`);
      expect(row.model!.programs.map((p) => p.programId)).toEqual([row.programId]);
      // The sliced model is still a valid BandModel (coefficients, covariances, pooled cells kept).
      expect(BandModelSchema.safeParse(row.model).success).toBe(true);
      expect(row.model!.beta).toEqual([1.5, 0, 0]);
      expect([row.nEff, row.passReports, row.failReports, row.programEligible]).toEqual([61.4, 20, 44, true]);
    }
  });

  it("slicing never invents a program and never mutates the input", () => {
    const m = model();
    const before = JSON.stringify(m);
    expect(sliceModelForProgram(m, "00000000-0000-4000-8000-0000000000ff")).toBeNull();
    sliceModelForProgram(m, FIXTURE_PROGRAM_ID);
    expect(JSON.stringify(m)).toBe(before);
  });

  it("everyGatePasses is exactly allBandGatesPass (the outcome summary's rule)", () => {
    const bools = [true, false];
    let checked = 0;
    for (const pooled of bools)
      for (const representativeness of bools)
        for (const fairness of bools)
          for (const usefulness of bools)
            for (const approved of bools)
              for (const heldOut of HELD_OUT_OUTCOMES) {
                const g: StoredGateFlags = { pooled, representativeness, fairness, usefulness, approved, heldOut };
                expect(everyGatePasses(g)).toBe(allBandGatesPass(g));
                checked++;
              }
    expect(checked).toBe(128);
    expect(everyGatePasses(null)).toBe(false);
  });
});

describe("gates checked at read time", () => {
  it("every gate passing gives the stored model, with approval taken from the read", () => {
    const decision = decideProgramBand(rowsFor(), GATES_ON);
    expect(decision.live).toBe(true);
    if (!decision.live) return;
    expect(decision.modelKey).toBe(KEY);
    expect(decision.model.programs.map((p) => p.programId)).toEqual([FIXTURE_PROGRAM_ID]);
    expect(decision.model.gates.approved).toBe(true);
  });

  it("approval is read now: approved after the fit turns bands on, revoked turns them off", () => {
    const fittedUnapproved = rowsFor({ gates: { approved: false } });
    expect(decideProgramBand(fittedUnapproved, GATES_ON).live).toBe(true);
    expect(decideProgramBand(rowsFor(), { ...GATES_ON, approvedModelKeys: [] })).toEqual({ live: false, failures: ["not_approved"] });
    expect(decideProgramBand(rowsFor(), { ...GATES_ON, approvedModelKeys: ["other_type.applicants-awards"] })).toEqual({ live: false, failures: ["not_approved"] });
  });

  const OFF: [string, FixtureOptions, Partial<BandReadContext>, string][] = [
    ["pooled sample size", { gates: { pooled: false } }, {}, "pooled_sample_size"],
    ["held-out skill", { gates: { heldOut: "fail_skill" } }, {}, "held_out_fail_skill"],
    ["held-out calibration", { gates: { heldOut: "fail_calibration" } }, {}, "held_out_fail_calibration"],
    ["held-out not evaluated", { gates: { heldOut: "not_evaluated" } }, {}, "held_out_not_evaluated"],
    ["representativeness", { gates: { representativeness: false } }, {}, "representativeness"],
    ["fairness", { gates: { fairness: false } }, {}, "fairness"],
    ["usefulness", { gates: { usefulness: false } }, {}, "usefulness"],
    ["per-program counts", { eligible: false }, {}, "program_ineligible"],
    ["a live hold", {}, { heldCycleIds: ["00000000-0000-4000-8000-00000000c001"] }, "cycle_held"],
    ["the program's type changed", {}, { opportunityTypes: ["another_type"] }, "type_mismatch"],
    ["a stale model", {}, { today: "2027-01-03" }, "stale_model"],
  ];

  it.each(OFF)("%s failing alone gives no model (official base rate)", (_name, opts, ctx, failure) => {
    const decision = decideProgramBand(rowsFor(opts), { ...GATES_ON, ...ctx });
    expect(decision).toEqual({ live: false, failures: [failure] });
  });

  it("the gate columns and the stored JSON must both pass (fail closed if they disagree)", () => {
    const row = ownRow();
    const columnsOff = { ...row, gates: { ...row.gates, fairness: false } };
    expect(decideProgramBand([columnsOff], GATES_ON)).toEqual({ live: false, failures: ["fairness"] });
    const jsonOff = { ...row, model: { ...row.model!, gates: { ...row.model!.gates, usefulness: false } } };
    expect(decideProgramBand([jsonOff], GATES_ON)).toEqual({ live: false, failures: ["usefulness"] });
  });

  it("freshness: 62 days old is used, 63 is stale, a future fit is refused", () => {
    expect(daysBetween("2026-11-01", "2027-01-02")).toBe(62);
    expect(decideProgramBand(rowsFor({}, "2026-11-01"), { ...GATES_ON, today: "2027-01-02" }).live).toBe(true);
    expect(decideProgramBand(rowsFor({}, "2026-11-01"), { ...GATES_ON, today: "2027-01-03" })).toEqual({ live: false, failures: ["stale_model"] });
    expect(decideProgramBand(rowsFor({}, "2026-11-12"), GATES_ON)).toEqual({ live: false, failures: ["fitted_in_future"] });
    expect(daysBetween("2026-13-01", "2026-11-11")).toBeNull();
    expect(daysBetween("2026-02-29", "2026-11-11")).toBeNull();
    expect(daysBetween("2028-02-29", "2028-03-01")).toBe(1);
    expect(daysBetween("not a day", "2026-11-11")).toBeNull();
    expect(decideProgramBand(rowsFor({}, "2026-02-30"), GATES_ON)).toEqual({ live: false, failures: ["malformed_model"] });
  });

  it("a row whose JSON no longer parses, or that names another program, is never used", () => {
    const row = ownRow();
    expect(decideProgramBand([{ ...row, model: null }], GATES_ON)).toEqual({ live: false, failures: ["malformed_model"] });
    const other = rowsFor().find((r) => r.programId === FIXTURE_OTHER_PROGRAM_ID)!;
    expect(decideProgramBand([{ ...other, programId: FIXTURE_PROGRAM_ID }], GATES_ON)).toEqual({ live: false, failures: ["malformed_model"] });
    expect(decideProgramBand([{ ...row, modelKey: "wrong.key" }], { ...GATES_ON, approvedModelKeys: ["wrong.key"] })).toEqual({ live: false, failures: ["malformed_model"] });
  });

  it("no stored row for the student's transition, no transition, or a status-defined program: no model", () => {
    expect(decideProgramBand(rowsFor({ fromStage: "nominees" }), GATES_ON)).toEqual({ live: false, failures: ["no_model"] });
    expect(decideProgramBand(rowsFor(), { ...GATES_ON, transition: null })).toEqual({ live: false, failures: ["no_transition"] });
    expect(decideProgramBand(rowsFor(), { ...GATES_ON, sensitiveAudience: true })).toEqual({ live: false, failures: ["sensitive_program"] });
    expect(decideProgramBand([], GATES_ON)).toEqual({ live: false, failures: ["no_model"] });
  });

  it("collects every failure in a fixed order and does not depend on row order", () => {
    const rows = rowsFor({ gates: { fairness: false, pooled: false }, eligible: false });
    const ctx = { ...GATES_ON, approvedModelKeys: [], heldCycleIds: ["x"] };
    const a = decideProgramBand(rows, ctx);
    const b = decideProgramBand([...rows].reverse(), ctx);
    expect(a).toEqual(b);
    expect(a).toEqual({ live: false, failures: ["not_approved", "cycle_held", "program_ineligible", "pooled_sample_size", "fairness"] });
    if (!a.live) for (const f of a.failures) expect(BAND_READ_FAILURES).toContain(f);
  });

  it("with two types covering one transition, the first passing key wins", () => {
    const second = splitModelByProgram(model({ opportunityType: "a_type" }), { fittedOn: FIXTURE_FITTED_ON, algo: "bands-fit-v1" });
    const ctx = { ...GATES_ON, opportunityTypes: ["a_type", FIXTURE_TYPE], approvedModelKeys: [KEY] };
    const decision = decideProgramBand([...rowsFor(), ...second], ctx);
    expect(decision.live && decision.modelKey).toBe(KEY);
  });
});

describe("assessReadiness with a stored model: personal band only when every gate passes", () => {
  const ODDS: StageOdds[] = [
    { fromStage: "applicants", toStage: "awards", cycleYear: 2026, numerator: 30, denominator: 300, denominatorKind: "exact", sourceUrl: "https://example.org/sample-results", verifiedAt: "2026-10-01", verifiedBy: "Novus Curator AB" },
  ];
  const assess = (bandModel: BandModel | null, gpaBand: string) =>
    assessReadiness({
      program: { id: FIXTURE_PROGRAM_ID, slug: "sample-band-program" },
      cycle: { id: "00000000-0000-4000-8000-00000000c001", cycleKey: "summer-2027" },
      deadlines: [],
      requirements: [],
      requirementsChecked: false,
      eligibility: null,
      profile: { classYear: "second_year", gpaBand, priorExperience: [] },
      stageOdds: ODDS,
      reportsBanded: "10-19 verified reports",
      bandModel,
      now: "2026-11-11T15:00:00Z",
    }).competitiveness;

  it("gates on: a band word next to the official counts", () => {
    const d = decideProgramBand(rowsFor(), GATES_ON);
    const live = d.live ? d.model : null;
    const high = assess(live, "3_75_plus");
    expect([high.status, high.band]).toEqual(["available", "above_typical"]);
    expect(high.basis.kind).toBe("outcome_model");
    expect(high.basis.reportsBanded).toBe("10-19 verified reports");
    expect(high.basis.stageOdds).toHaveLength(1);
    expect(assess(live, "3_0_to_3_24").band).toBe("below_typical");
  });

  it("gates off: the official base rate only, with the released report count", () => {
    for (const [opts, ctx] of [
      [{ gates: { fairness: false } }, {}],
      [{ gates: { heldOut: "fail_skill" as const } }, {}],
      [{}, { approvedModelKeys: [] }],
      [{}, { heldCycleIds: ["held"] }],
    ] as [FixtureOptions, Partial<BandReadContext>][]) {
      const d = decideProgramBand(rowsFor(opts), { ...GATES_ON, ...ctx });
      expect(d.live).toBe(false);
      const c = assess(d.live ? d.model : null, "3_75_plus");
      expect([c.status, c.band, c.basis.kind]).toEqual(["official_odds_only", null, "official_counts"]);
      expect(c.basis.reportsBanded).toBe("10-19 verified reports");
      expect(c.basis.modelVersion).toBeNull();
    }
  });
});
