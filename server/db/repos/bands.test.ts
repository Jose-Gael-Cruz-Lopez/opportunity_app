import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { BandModelSchema, type BandModel } from "../../../shared/readiness/bands";
import { bandModelKey } from "../../../shared/readiness/bands-store";
import { fixtureBandModel, FIXTURE_FITTED_ON, type FixtureOptions } from "../../../shared/readiness/bands-store/testing";
import { OVER_COUNT_REASON } from "../../api/v1/outcomes/d1";
import { modelKey as jobModelKey, type StoredBandModel } from "../../jobs/kinds/bands-fit";
import { uuidv7 } from "../columns";
import * as s from "../schema";
import { createUser, seededDb, type TestDb } from "../testing/fixtures";
import type { SampleSeed } from "../seed/build";
import * as bands from "./bands";

const NOW = Date.parse("2026-11-11T15:00:00Z");
const MIDNIGHT = Date.parse("2026-11-11T00:00:00Z");

let t: TestDb & { seed: SampleSeed };
let programId: string;
let otherProgramId: string;
let cycleId: string;
let type: string;

function model(opts: FixtureOptions = {}): BandModel {
  return BandModelSchema.parse(fixtureBandModel({ programIds: [programId, otherProgramId], opportunityType: type, ...opts }));
}

function keyOf(m: BandModel): string {
  return bandModelKey(m.opportunityType, m.fromStage, m.toStage);
}

async function approve(key: string, state: "approved" | "applied" | "open" | "rejected" = "approved", fingerprint?: string | null): Promise<void> {
  const modelFingerprint = fingerprint === undefined ? await bands.bandModelFingerprint(model()) : fingerprint;
  await t.db.insert(s.reviewTasks).values({
    id: uuidv7(NOW),
    kind: "band_model_approval",
    subjectType: "program",
    subjectId: programId,
    dedupeKey: `band_model_approval:program:${key}:${state}`,
    state,
    payload: modelFingerprint === null ? { modelKey: key } : { modelKey: key, modelFingerprint },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

beforeEach(async () => {
  t = await seededDb("2026-11-11");
  const open = t.seed.programs.filter((p) => !p.sensitiveAudience && (p.identityAudience ?? []).length === 0);
  programId = open[0]!.id as string;
  otherProgramId = open[1]!.id as string;
  cycleId = t.seed.programCycles.find((c) => c.programId === programId)!.id as string;
  type = t.seed.programTypes.find((pt) => pt.programId === programId)!.typeSlug as string;
});

describe("band_models: bands.fit output stored per program", () => {
  it("uses the job's model key and accepts the job's stored entry shape", async () => {
    const m = model();
    expect(keyOf(m)).toBe(jobModelKey(m.opportunityType, m.fromStage, m.toStage));
    const entry: StoredBandModel = { key: keyOf(m), fittedOn: FIXTURE_FITTED_ON, algo: "bands-fit-v1", live: true, model: m };
    expect(await bands.storeProgramBandModels(t.db, entry, NOW)).toEqual({ stored: 2 });
  });

  it("writes one row per known program with gate columns, and reads the sliced model back", async () => {
    const m = model({ gates: { fairness: false } });
    const unknown = "00000000-0000-4000-8000-0000000000ee";
    const withUnknown = { ...m, programs: [...m.programs, { ...m.programs[0]!, programId: unknown }] };
    expect(await bands.storeProgramBandModels(t.db, { key: keyOf(m), fittedOn: FIXTURE_FITTED_ON, algo: "bands-fit-v1", model: withUnknown }, NOW)).toEqual({ stored: 2 });
    const rows = await bands.currentProgramBands(t.db, programId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.modelKey).toBe(keyOf(m));
    expect(row!.gates).toEqual({ pooled: true, heldOut: "pass", representativeness: true, fairness: false, usefulness: true, approved: true });
    expect(row!.model!.programs.map((p) => p.programId)).toEqual([programId]);
    expect(row!.model!.beta).toEqual([1.5, 0, 0]);
    expect(await bands.currentProgramBands(t.db, unknown)).toEqual([]);
  });

  it("a refit supersedes the key's live rows; a program the refit drops loses its row", async () => {
    const m = model();
    await bands.storeProgramBandModels(t.db, { key: keyOf(m), fittedOn: "2026-10-01", algo: "bands-fit-v1", model: m }, NOW - 1000);
    const refit = model({ programIds: [programId], modelVersion: "bands-fit-v1.2026-11" });
    await bands.storeProgramBandModels(t.db, { key: keyOf(m), fittedOn: "2026-11-01", algo: "bands-fit-v1", model: refit }, NOW);
    expect((await bands.currentProgramBands(t.db, programId)).map((r) => r.fittedOn)).toEqual(["2026-11-01"]);
    expect(await bands.currentProgramBands(t.db, otherProgramId)).toEqual([]);
    const history = await t.db.select().from(s.bandModels).where(eq(s.bandModels.programId, programId));
    expect(history).toHaveLength(2);
    expect(await bands.retireBandModel(t.db, keyOf(m), NOW + 1)).toBe(1);
    expect(await bands.currentProgramBands(t.db, programId)).toEqual([]);
  });

  it("refuses a key that does not match the model, and a malformed fit day", async () => {
    const m = model();
    await expect(bands.storeProgramBandModels(t.db, { key: "other.applicants-awards", fittedOn: FIXTURE_FITTED_ON, algo: "a", model: m }, NOW)).rejects.toThrow(/key/);
    await expect(bands.storeProgramBandModels(t.db, { key: keyOf(m), fittedOn: "Nov 1", algo: "a", model: m }, NOW)).rejects.toThrow(/fittedOn/);
  });

  it("a stored JSON that no longer parses reads back as model null (never used)", async () => {
    const m = model();
    await bands.storeProgramBandModels(t.db, { key: keyOf(m), fittedOn: FIXTURE_FITTED_ON, algo: "a", model: m }, NOW);
    t.raw.exec(`UPDATE band_models SET model = '{"beta":[1]}' WHERE program_id = '${programId}'`);
    const [row] = await bands.currentProgramBands(t.db, programId);
    expect(row!.model).toBeNull();
  });

  it("the database refuses a second live row per key and program, and a non-object model", async () => {
    const m = model();
    await bands.storeProgramBandModels(t.db, { key: keyOf(m), fittedOn: FIXTURE_FITTED_ON, algo: "a", model: m }, NOW);
    const [row] = await t.db.select().from(s.bandModels).where(eq(s.bandModels.programId, programId));
    await expect(t.db.insert(s.bandModels).values({ ...row!, id: uuidv7(NOW) })).rejects.toThrow();
    await expect(t.db.insert(s.bandModels).values({ ...row!, id: uuidv7(NOW), supersededAt: NOW, model: [] as unknown as Record<string, unknown> })).rejects.toThrow();
  });

  it("approvals are read now: approved or applied count, open or rejected do not", async () => {
    await approve("a.applicants-awards", "approved");
    await approve("b.applicants-awards", "applied");
    await approve("c.applicants-awards", "open");
    await approve("d.applicants-awards", "rejected");
    const m = model();
    const rows = ["a.applicants-awards", "b.applicants-awards", "c.applicants-awards", "d.applicants-awards", "e.x-y"].map((modelKey) => ({ modelKey, model: m }));
    expect(await bands.approvedBandModelKeys(t.db, rows)).toEqual(["a.applicants-awards", "b.applicants-awards"]);
    expect(await bands.approvedBandModelKeys(t.db, [])).toEqual([]);
  });

  it("an approval names one model card: a refit with other coefficients, or no fingerprint, is not approved", async () => {
    const m = model();
    const key = keyOf(m);
    await approve(key);
    expect(await bands.approvedBandModelKeys(t.db, [{ modelKey: key, model: m }])).toEqual([key]);
    // Next month's refit on unchanged data: same card, still approved.
    const nextMonth: BandModel = { ...m, modelVersion: "bands-fit-v1.2026-12" };
    expect(await bands.approvedBandModelKeys(t.db, [{ modelKey: key, model: nextMonth }])).toEqual([key]);
    // New coefficients: needs a new review.
    const refit = { ...m, beta: m.beta.map((b) => b * 1.1 + 0.01) };
    expect(await bands.approvedBandModelKeys(t.db, [{ modelKey: key, model: refit }])).toEqual([]);
    expect(await bands.approvedBandModelKeys(t.db, [{ modelKey: key, model: null }])).toEqual([]);
    // A key-only approval (the old payload) approves nothing.
    await approve("k.applicants-awards", "approved", null);
    expect(await bands.approvedBandModelKeys(t.db, [{ modelKey: "k.applicants-awards", model: m }])).toEqual([]);
  });
});

describe("outcome_cycle_holds", () => {
  it("opens one live hold per cycle and reason, releases it, and keeps history", async () => {
    const a = await bands.holdCycle(t.db, { programCycleId: cycleId, reason: "over_count" }, NOW);
    const b = await bands.holdCycle(t.db, { programCycleId: cycleId, reason: "over_count" }, NOW + 1);
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(await bands.cycleHeld(t.db, cycleId)).toBe(true);
    expect(await bands.heldCycleIdsForProgram(t.db, programId)).toEqual([cycleId]);
    expect(await bands.releaseCycleHolds(t.db, cycleId, NOW + 2)).toBe(1);
    expect(await bands.cycleHeld(t.db, cycleId)).toBe(false);
    expect(await bands.releaseCycleHolds(t.db, cycleId, NOW + 3)).toBe(0);
    // A new hold after release is a new row.
    expect((await bands.holdCycle(t.db, { programCycleId: cycleId, reason: "over_count" }, NOW + 4)).created).toBe(true);
    expect(await t.db.select().from(s.outcomeCycleHolds)).toHaveLength(2);
  });

  it("releases only the named reason, never before the freeze, and the database refuses a second live hold", async () => {
    await bands.holdCycle(t.db, { programCycleId: cycleId, reason: "over_count" }, NOW);
    await bands.holdCycle(t.db, { programCycleId: cycleId, reason: "curator" }, NOW);
    expect(await bands.releaseCycleHolds(t.db, cycleId, NOW - 5000, "curator")).toBe(1);
    const rows = await t.db.select().from(s.outcomeCycleHolds).where(eq(s.outcomeCycleHolds.reason, "curator"));
    expect(rows[0]!.releasedAt).toBe(NOW);
    expect((await bands.liveCycleHolds(t.db, [cycleId])).map((h) => h.reason)).toEqual(["over_count"]);
    await expect(t.db.insert(s.outcomeCycleHolds).values({ id: uuidv7(NOW), programCycleId: cycleId, reason: "over_count", frozenAt: NOW, createdAt: NOW })).rejects.toThrow();
  });

  it("a live over-count outcome_anomaly task still holds the cycle (interim rule); a resolved one does not", async () => {
    expect(bands.LEGACY_OVER_COUNT_REASON).toBe(OVER_COUNT_REASON);
    const task = (state: string, reasons: string[]) => ({
      id: uuidv7(NOW),
      kind: "outcome_anomaly",
      subjectType: "program_cycle",
      subjectId: cycleId,
      dedupeKey: `outcome_anomaly:program_cycle:${cycleId}:${state}`,
      reasonCodes: reasons,
      state,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await t.db.insert(s.reviewTasks).values(task("applied", [OVER_COUNT_REASON]));
    await t.db.insert(s.reviewTasks).values(task("open", ["outcome_flagged"]));
    expect(await bands.cycleHeld(t.db, cycleId)).toBe(false);
    await t.db.insert(s.reviewTasks).values(task("claimed", [OVER_COUNT_REASON]));
    expect(await bands.cycleHeld(t.db, cycleId)).toBe(true);
  });
});

describe("read-time facts", () => {
  async function report(tier: string, opts: { quality?: string; createdAt?: number; deleted?: boolean; cycle?: string } = {}): Promise<void> {
    const userId = await createUser(t.db);
    await t.db.insert(s.outcomes).values({
      userId,
      programCycleId: opts.cycle ?? cycleId,
      tier,
      qualityState: opts.quality ?? "ok",
      createdAt: opts.createdAt ?? MIDNIGHT - 1000,
      updatedAt: opts.createdAt ?? MIDNIGHT - 1000,
      deletedAt: opts.deleted ? NOW : null,
    });
  }

  it("counts counted, unflagged, live reports filed before today's UTC midnight, held cycles left out", async () => {
    await report("institution_email");
    await report("official_list");
    await report("self_reported");
    await report("institution_email", { quality: "flagged" });
    await report("institution_email", { deleted: true });
    await report("institution_email", { createdAt: MIDNIGHT + 1000 });
    expect(bands.utcMidnight(NOW)).toBe(MIDNIGHT);
    expect(await bands.countedProgramReports(t.db, programId, MIDNIGHT)).toBe(2);
    expect(await bands.countedProgramReports(t.db, programId, MIDNIGHT, [cycleId])).toBe(0);
    expect(await bands.countedProgramReports(t.db, otherProgramId, MIDNIGHT)).toBe(0);
  });

  it("gathers rows, types, live approvals, holds and the count for one program", async () => {
    const m = model();
    await bands.storeProgramBandModels(t.db, { key: keyOf(m), fittedOn: FIXTURE_FITTED_ON, algo: "bands-fit-v1", model: m }, NOW);
    await approve(keyOf(m));
    await report("letter_checked");
    const facts = await bands.readProgramBandFacts(t.db, programId, NOW);
    expect(facts.rows.map((r) => r.modelKey)).toEqual([keyOf(m)]);
    expect(facts.opportunityTypes).toContain(type);
    expect(facts.approvedModelKeys).toEqual([keyOf(m)]);
    expect(facts.heldCycleIds).toEqual([]);
    expect(facts.countedReports).toBe(1);

    await bands.holdCycle(t.db, { programCycleId: cycleId, reason: "over_count" }, NOW);
    const held = await bands.readProgramBandFacts(t.db, programId, NOW);
    expect(held.heldCycleIds).toEqual([cycleId]);
    expect(held.countedReports).toBe(0);
  });
});
