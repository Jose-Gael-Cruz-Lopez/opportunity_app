import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { generateSyntheticWorld, SYNTHETIC_SPECS, type SyntheticWorld } from "@shared/readiness/synthetic";
import { allBandGatesPass, type OutcomeFacts } from "@shared/readiness/outcomes";
import { uuidv7 } from "@server/db/columns";
import * as s from "@server/db/schema";
import { sampleIds } from "@server/db/seed/build";
import { createUser, seededDb, type TestDb } from "@server/db/testing/fixtures";
import { createD1OutcomesStore, OVER_COUNT_REASON } from "@server/api/v1/outcomes/d1";
import { bandModelFingerprint, holdCycle, storeProgramBandModels } from "@server/db/repos/bands";
import { Budget } from "../budget";
import { silentLogger, type JobContext, type WorkerBindings } from "../types";
import {
  applyApproval,
  BANDS_MODEL_PREFIX,
  bandsFit,
  cycleYearOf,
  fitBandGroup,
  loadBandFitData,
  modelKey,
  representativenessGate,
  retireUnfittedModels,
  shouldRunThisSlot,
  storeBandModel,
  type BandModelBucket,
  type BandReportRow,
  type OfficialStageRate,
} from "./bands-fit";
import { bandedCount, outcomesQuality, processCycle, rotateFrom } from "./outcomes-quality";

// ---------------------------------------------------------------------------------------------
// bands.fit (pure part) on SYNTHETIC worlds: no value here describes a real program.
// ---------------------------------------------------------------------------------------------

const TIER_FOR_WEIGHT: Record<number, string> = { 0.6: "institution_email", 0.8: "letter_checked", 1: "email_authenticated" };
const NOMINATED: OutcomeFacts["stages"] = [
  { stage: "submitted", on: null },
  { stage: "campus_nominated", on: null },
];
const LEVELS = ["two_year", "four_year"] as const;

function rowsFrom(world: SyntheticWorld, type = "national_scholarship"): { reports: BandReportRow[]; rates: OfficialStageRate[] } {
  const reports = world.applicants
    .filter((a) => a.reported)
    .map((a, i) => ({
      programId: a.programId,
      opportunityType: type,
      cycleYear: 2024 + a.cycle,
      tier: TIER_FOR_WEIGHT[a.weight] ?? "institution_email",
      facts: { stages: NOMINATED, decision: a.passed ? ("accepted" as const) : ("rejected" as const), decidedOn: null },
      windowClosed: true,
      levels: a.levels,
      institutionLevel: LEVELS[i % 2]!,
    }));
  const rates = world.officialCounts.map((c) => ({ programId: c.programId, cycleYear: 2024 + c.cycle, from: "nominees" as const, to: "awards" as const, k: c.k, n: c.n }));
  return { reports, rates };
}

const SIGNAL = { gpaStep: 0.7, secondYear: 0.3, priorProgram: 0.5 };
const REPORTING = { rate: 0.3, admitRatio: 2 };

function group(world: SyntheticWorld, opts: { approved?: boolean; recipientMix?: Record<string, number> | null } = {}) {
  const { reports, rates } = rowsFrom(world);
  return fitBandGroup({
    opportunityType: "national_scholarship",
    from: "nominees",
    to: "awards",
    reports,
    rates,
    recipientMix: opts.recipientMix === undefined ? { two_year: 0.5, four_year: 0.5, other: 0 } : opts.recipientMix,
    approved: opts.approved ?? false,
    modelVersion: "bands-fit-v1.test",
    methodologyUrl: null,
    specs: SYNTHETIC_SPECS,
    resamples: 200,
    seed: 7,
  });
}

describe("fitBandGroup", () => {
  it("keeps bands off with too few reports: pooled and held-out gates fail", () => {
    const world = generateSyntheticWorld({ seed: 11, programs: 3, cycles: 2, applicantsPerCycle: 40, baseRates: [0.2, 0.3], effects: SIGNAL, reporting: REPORTING });
    const result = group(world, { approved: true });
    expect(result.live).toBe(false);
    expect(result.gates.pooled).toBe(false);
    expect(result.key).toBe(modelKey("national_scholarship", "nominees", "awards"));
  });

  it("fits on earlier cycles, scores the latest one, and never turns bands on without approval", () => {
    const world = generateSyntheticWorld({ seed: 5, programs: 6, cycles: 2, applicantsPerCycle: 900, baseRates: [0.15, 0.25, 0.35], effects: SIGNAL, reporting: REPORTING });
    const unapproved = group(world);
    expect(unapproved.status).toBe("fitted");
    expect(unapproved.heldOutYear).toBe(2026);
    expect(unapproved.model?.cycles).toEqual([2025]);
    expect(unapproved.heldOut?.clusters).toBe(6);
    expect(unapproved.gates.approved).toBe(false);
    expect(unapproved.live).toBe(false);
    // Fairness groups are institution levels only: never a status or identity answer.
    expect(unapproved.fairnessGroups.length).toBeGreaterThan(0);
    for (const g of unapproved.fairnessGroups) expect(g.group).toMatch(/^institution_level:(two_year|four_year|other)$/);

    const approved = group(world, { approved: true });
    expect(approved.live).toBe(allBandGatesPass(approved.gates));
    if (approved.live) {
      expect(approved.gates).toMatchObject({ pooled: true, heldOut: "pass", representativeness: true, fairness: true, usefulness: true, approved: true });
    }
    // Without the official recipients' mix the representativeness gate fails closed.
    const noMix = group(world, { approved: true, recipientMix: null });
    expect(noMix.gates.representativeness).toBe(false);
    expect(noMix.live).toBe(false);
  }, 60_000);

  it("ignores self-reported reports and reports that never reached the stage", () => {
    const world = generateSyntheticWorld({ seed: 2, programs: 2, cycles: 1, applicantsPerCycle: 200, baseRates: [0.3], effects: SIGNAL, reporting: REPORTING });
    const { reports, rates } = rowsFrom(world);
    const selfReported = reports.map((r) => ({ ...r, tier: "self_reported" }));
    const notNominated = reports.map((r) => ({ ...r, facts: { ...r.facts, stages: [{ stage: "submitted" as const, on: null }] } }));
    for (const rows of [selfReported, notNominated]) {
      const result = fitBandGroup({ opportunityType: "national_scholarship", from: "nominees", to: "awards", reports: rows, rates, recipientMix: null, approved: true, modelVersion: "v", methodologyUrl: null, specs: SYNTHETIC_SPECS });
      expect(result.status).toBe("insufficient_data");
      expect(result.live).toBe(false);
      expect(result.counts.trainReports).toBe(0);
    }
  });

  it("checks representativeness against the recipients' institution-level mix", () => {
    const admits = [...Array(12).fill("four_year"), ...Array(8).fill("two_year")];
    expect(representativenessGate(admits, { four_year: 0.6, two_year: 0.4, other: 0 })).toBe(true);
    expect(representativenessGate(admits, { four_year: 0.8, two_year: 0.2, other: 0 })).toBe(false);
    expect(representativenessGate(admits.slice(0, 19), { four_year: 0.6, two_year: 0.4, other: 0 })).toBe(false);
    expect(representativenessGate(admits, null)).toBe(false);
  });
});

class MapBucket implements BandModelBucket {
  readonly objects = new Map<string, string>();
  async put(key: string, value: string) {
    this.objects.set(key, value);
  }
  async get(key: string) {
    const v = this.objects.get(key);
    return v === undefined ? null : { text: async () => v };
  }
  async list(opts: { prefix?: string } = {}) {
    return { objects: [...this.objects.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).map((key) => ({ key })) };
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

describe("band model storage", () => {
  it("stores privately under the model key", async () => {
    const world = generateSyntheticWorld({ seed: 5, programs: 6, cycles: 2, applicantsPerCycle: 300, baseRates: [0.2, 0.3], effects: SIGNAL, reporting: REPORTING });
    const result = group(world);
    const bucket = new MapBucket();
    await storeBandModel(bucket, { key: result.key, fittedOn: "2027-06-01", algo: "bands-fit-v1", live: result.live, model: result.model! });
    expect([...bucket.objects.keys()]).toEqual([`${BANDS_MODEL_PREFIX}national_scholarship.nominees-awards.json`]);
    expect(BANDS_MODEL_PREFIX.startsWith("private/")).toBe(true);
  }, 30_000);

  it("approves a fit only when a live approval names its key and its exact fingerprint", async () => {
    const world = generateSyntheticWorld({ seed: 5, programs: 6, cycles: 2, applicantsPerCycle: 300, baseRates: [0.2, 0.3], effects: SIGNAL, reporting: REPORTING });
    const result = group(world);
    expect(result.gates.approved).toBe(false);
    const fingerprint = await bandModelFingerprint(result.model!);
    expect(fingerprint).toMatch(/^[0-9a-f]{32}$/);
    // The same fit relabelled (another month's version, other gate flags) keeps its fingerprint.
    const relabelled = { ...result.model!, modelVersion: "bands-fit-v1.2099-01" };
    expect(await bandModelFingerprint(relabelled)).toBe(fingerprint);
    // Other coefficients are another model card.
    expect(await bandModelFingerprint({ ...result.model!, beta: result.model!.beta.map((b) => b + 0.01) })).not.toBe(fingerprint);

    expect((await applyApproval(result, [{ modelKey: result.key, modelFingerprint: "0".repeat(32) }])).gates.approved).toBe(false);
    expect((await applyApproval(result, [{ modelKey: "other.nominees-awards", modelFingerprint: fingerprint }])).gates.approved).toBe(false);
    const approved = await applyApproval(result, [{ modelKey: result.key, modelFingerprint: fingerprint }]);
    expect(approved.gates.approved).toBe(true);
    expect(approved.model!.gates.approved).toBe(true);
    expect(approved.live).toBe(allBandGatesPass(approved.gates));
  }, 30_000);

  it("parses cycle years and month-start slots", () => {
    expect(cycleYearOf("ay-2026-27")).toBe(2026);
    expect(cycleYearOf("summer-2027")).toBe(2027);
    expect(cycleYearOf("rolling")).toBeNull();
    expect(shouldRunThisSlot("2027-06-01", "daily")).toBe(true);
    expect(shouldRunThisSlot("2027-06-02", "daily")).toBe(false);
    expect(shouldRunThisSlot("2027-06-02", "manual")).toBe(true);
    expect(shouldRunThisSlot(null, "catch_up")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Handlers against a seeded in-memory D1 (sample data only).
// ---------------------------------------------------------------------------------------------

const NOW = Date.parse("2027-05-01T08:00:30Z");
const SLUG = "sample-summer-research-fellowship";
const CYCLE = sampleIds.cycle(SLUG);
let t: TestDb;

function ctx(env: Partial<WorkerBindings> = {}, slot: string | null = "2027-05-01", trigger: JobContext["trigger"] = "daily"): JobContext {
  return {
    env: { DB: t.raw.d1 as unknown as D1Database, ...env },
    db: t.db,
    edb: null,
    now: () => NOW,
    budget: new Budget({ ms: 25_000, calls: 900 }, () => NOW),
    log: silentLogger,
    trigger,
    slot,
  };
}

async function addReport(opts: { tier?: string; decision?: string | null; decidedOn?: string | null; userId?: string; stages?: string[] } = {}) {
  const userId = opts.userId ?? (await createUser(t.db));
  const id = uuidv7();
  await t.db.insert(s.outcomes).values({
    id,
    userId,
    programCycleId: CYCLE,
    tier: opts.tier ?? "institution_email",
    decision: opts.decision === undefined ? "accepted" : opts.decision,
    decidedOn: opts.decidedOn === undefined ? "2027-04-06" : opts.decidedOn,
    classYear: "second_year",
    gpaBand: "3_5_to_3_74",
    priorFeeder: "no",
    institutionType: "four_year",
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
  });
  for (const stage of opts.stages ?? ["submitted"]) await t.db.insert(s.outcomeStages).values({ outcomeId: id, stage, onDate: null, createdAt: NOW });
  return id;
}

beforeEach(async () => {
  t = await seededDb("2026-11-11");
});

describe("outcomes.quality", () => {
  it("adds validator flags, opens one anomaly task per cycle with banded counts only", async () => {
    await addReport();
    const early = await addReport({ decidedOn: "2027-01-05" });
    const res = await outcomesQuality(ctx());
    expect(res).toMatchObject({ outcome: "ok", processed: 1 });
    const [row] = await t.db.select().from(s.outcomes).where(eq(s.outcomes.id, early));
    expect(row).toMatchObject({ qualityState: "flagged", flagCodes: ["decision_before_round_close"] });
    const tasks = await t.db.select().from(s.reviewTasks).where(eq(s.reviewTasks.kind, "outcome_anomaly"));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ subjectType: "program_cycle", subjectId: CYCLE, reasonCodes: ["outcome_flagged"] });
    // Counts are disclosure labels; no report id, account or exact date in the payload.
    expect(tasks[0]!.payload).toEqual({ byFlag: { decision_before_round_close: "fewer than 5" }, checkedOn: "2027-05-01" });
    expect(JSON.stringify(tasks[0]!.payload)).not.toContain(early);

    // Idempotent: a second run adds nothing new and keeps one live task.
    await outcomesQuality(ctx());
    expect(await t.db.select().from(s.reviewTasks).where(eq(s.reviewTasks.kind, "outcome_anomaly"))).toHaveLength(1);
  });

  it("holds the cycle on the private over-count rule, and the summary then releases nothing", async () => {
    await t.db.insert(s.programCycleCounts).values({ id: uuidv7(), programCycleId: CYCLE, stage: "awards", count: 10, kind: "exact", provenance: "official_publication", asOf: "2027-04-01" });
    for (let i = 0; i < 8; i++) await addReport();
    // Without the private cut-off nothing is held.
    expect((await processCycle(t.db, CYCLE, "2027-05-01", { overCountFraction: null, seasonalCap: null }, NOW))?.result.hold).toBeNull();
    await t.db.insert(s.config).values({ key: "outcomes.anomaly.freeze_ratio", value: 0.5 });
    await outcomesQuality(ctx());
    const store = createD1OutcomesStore(t.db);
    expect(await store.cycleHeld(CYCLE)).toBe(true);
    const [task] = await t.db.select().from(s.reviewTasks).where(eq(s.reviewTasks.kind, "outcome_anomaly"));
    expect(task?.reasonCodes).toContain(OVER_COUNT_REASON);
    // The hold is also a row in outcome_cycle_holds, linked to the task; a rerun opens no second one.
    await outcomesQuality(ctx());
    const holds = await t.db.select().from(s.outcomeCycleHolds).where(eq(s.outcomeCycleHolds.programCycleId, CYCLE));
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ reason: "over_count", reviewTaskId: task!.id, releasedAt: null });
    // With the task gone from the live states, the table alone still holds the cycle.
    await t.db.update(s.reviewTasks).set({ state: "rejected" }).where(eq(s.reviewTasks.id, task!.id));
    expect(await store.cycleHeld(CYCLE)).toBe(true);
  });

  it("drafts a decision week for a Curator from 10 distinct counted accounts", async () => {
    for (let i = 0; i < 10; i++) await addReport({ decidedOn: "2027-04-07" });
    await addReport({ tier: "self_reported", decidedOn: "2027-04-07" });
    await outcomesQuality(ctx());
    const [task] = await t.db.select().from(s.reviewTasks).where(eq(s.reviewTasks.kind, "cycle_update"));
    expect(task?.reasonCodes).toEqual(["outcome_decision_week"]);
    expect(task?.payload).toEqual({ decisionWeekDraft: { weekStart: "2027-04-05", precision: "week", observation: "reported", accounts: "10-19" } });
  });

  it("rotates its starting cycle and bands small counts", () => {
    expect(rotateFrom([], "x")).toEqual([]);
    expect(rotateFrom([1, 2, 3], "2027-05-01").sort()).toEqual([1, 2, 3]);
    expect(bandedCount(3, "c")).toBe("fewer than 5");
    expect(bandedCount(7, "c")).toBe("5-9");
    expect(bandedCount(23, "c")).toBe("25");
  });
});

describe("bands.fit handler", () => {
  it("runs on the first of the month only, defers without storage and stores nothing without data", async () => {
    expect(await bandsFit(ctx({}, "2027-05-02"))).toMatchObject({ outcome: "ok", processed: 0, detail: { skipped: "not_month_start" } });
    expect(await bandsFit(ctx())).toMatchObject({ outcome: "deferred" });
    const bucket = new MapBucket();
    const res = await bandsFit(ctx({ STORE: bucket as unknown as R2Bucket }));
    expect(res).toMatchObject({ outcome: "ok", processed: 0 });
    expect(bucket.objects.size).toBe(0);
  });

  it("loads counted, unflagged reports with allowlisted levels and exact official rates", async () => {
    await t.db.insert(s.programCycleCounts).values([
      { id: uuidv7(), programCycleId: CYCLE, stage: "applicants", count: 400, kind: "exact", provenance: "official_publication", asOf: "2027-04-01" },
      { id: uuidv7(), programCycleId: CYCLE, stage: "awards", count: 40, kind: "exact", provenance: "official_publication", asOf: "2027-04-01" },
    ]);
    await addReport();
    await addReport({ tier: "self_reported" });
    const flagged = await addReport();
    await t.db.update(s.outcomes).set({ qualityState: "flagged" }).where(eq(s.outcomes.id, flagged));
    const data = await loadBandFitData(t.db, "2027-05-01");
    expect(data.reports).toHaveLength(1);
    expect(data.reports[0]).toMatchObject({ levels: { gpa_band: "3_5_to_3_74", class_standing: "second_year", prior_program: "no" }, institutionLevel: "four_year", tier: "institution_email" });
    expect(Object.keys(data.reports[0]!)).not.toContain("userId");
    expect(data.rates).toEqual([{ programId: data.reports[0]!.programId, cycleYear: 2027, from: "applicants", to: "awards", k: 40, n: 400 }]);

    const bucket = new MapBucket();
    const res = await bandsFit(ctx({ STORE: bucket as unknown as R2Bucket }));
    expect(res.outcome).toBe("ok");
    expect(res.processed).toBe(1);
    const stored = [...bucket.objects.values()].map((v) => JSON.parse(v) as { key: string; live: boolean; model: { gates: unknown; programs: { programId: string }[] } });
    expect(stored.every((e) => e.live === false)).toBe(true);
    // Each fitted model is also stored in D1 (band_models, one row per covered program), where
    // readiness reads it.
    const rows = await t.db.select().from(s.bandModels);
    expect(rows.map((r) => `${r.modelKey}:${r.programId}`).sort()).toEqual(stored.flatMap((e) => e.model.programs.map((p) => `${e.key}:${p.programId}`)).sort());
  });

  it("leaves reports from a held cycle out of the fit", async () => {
    await t.db.insert(s.programCycleCounts).values([
      { id: uuidv7(), programCycleId: CYCLE, stage: "applicants", count: 400, kind: "exact", provenance: "official_publication", asOf: "2027-04-01" },
      { id: uuidv7(), programCycleId: CYCLE, stage: "awards", count: 40, kind: "exact", provenance: "official_publication", asOf: "2027-04-01" },
    ]);
    await addReport();
    await addReport();
    expect((await loadBandFitData(t.db, "2027-05-01")).reports).toHaveLength(2);
    await holdCycle(t.db, { programCycleId: CYCLE, reason: "over_count" }, NOW);
    expect((await loadBandFitData(t.db, "2027-05-01")).reports).toHaveLength(0);
  });

  it("retires every live model key the run did not store, in band_models and in R2", async () => {
    // A model stored by an earlier run whose data is now gone (no reports, no official counts).
    const world = generateSyntheticWorld({ seed: 5, programs: 6, cycles: 2, applicantsPerCycle: 300, baseRates: [0.2, 0.3], effects: SIGNAL, reporting: REPORTING });
    const old = group(world);
    const programId = (await t.db.select({ id: s.programs.id }).from(s.programs).limit(1))[0]!.id;
    const model = { ...old.model!, programs: [{ ...old.model!.programs[0]!, programId }] };
    await storeProgramBandModels(t.db, { key: old.key, fittedOn: "2027-04-01", algo: "bands-fit-v1", model }, NOW - 30 * 86_400_000);
    const bucket = new MapBucket();
    await storeBandModel(bucket, { key: old.key, fittedOn: "2027-04-01", algo: "bands-fit-v1", live: false, model });
    const live = async () => (await t.db.select().from(s.bandModels)).filter((r) => r.supersededAt === null);
    expect(await live()).toHaveLength(1);

    const res = await bandsFit(ctx({ STORE: bucket as unknown as R2Bucket }));
    expect(res).toMatchObject({ outcome: "ok", processed: 0, detail: { retired: 1 } });
    expect(await live()).toHaveLength(0);
    expect(bucket.objects.size).toBe(0);
    // Idempotent.
    expect(await retireUnfittedModels(t.db, bucket, new Set(), NOW)).toEqual({ keys: 0, rows: 0, objects: 0 });
  }, 30_000);
});
