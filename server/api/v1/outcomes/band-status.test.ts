import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { BandModelSchema } from "@shared/readiness";
import { bandModelKey } from "@shared/readiness/bands-store";
import { FIXTURE_FITTED_ON, fixtureBandModel } from "@shared/readiness/bands-store/testing";
import { bandDisplayStatus } from "@shared/readiness/outcomes";
import { uuidv7 } from "@server/db/columns";
import * as bandsRepo from "@server/db/repos/bands";
import * as s from "@server/db/schema";
import { seededDb } from "@server/db/testing/fixtures";
import { programBandGates } from "./band-status";

// Sample seed and the synthetic fixture model only.
const NOW = Date.parse("2026-11-11T15:00:00Z");

async function world() {
  const t = await seededDb("2026-11-11");
  const program = t.seed.programs.find((p) => !p.sensitiveAudience && (p.identityAudience ?? []).length === 0)!;
  const programId = program.id as string;
  const cycleId = t.seed.programCycles.find((c) => c.programId === programId)!.id as string;
  const type = t.seed.programTypes.find((pt) => pt.programId === programId)!.typeSlug as string;
  const model = BandModelSchema.parse(fixtureBandModel({ programIds: [programId], opportunityType: type }));
  const key = bandModelKey(type, "applicants", "awards");
  const status = async (now = NOW) => bandDisplayStatus(await programBandGates(t.db, programId, now));
  const approve = async () => {
    const id = uuidv7(NOW);
    await t.db.insert(s.reviewTasks).values({
      id,
      kind: "band_model_approval",
      subjectType: "program",
      subjectId: programId,
      dedupeKey: `band_model_approval:program:${key}`,
      state: "approved",
      payload: { modelKey: key, modelFingerprint: await bandsRepo.bandModelFingerprint(model) },
      createdAt: NOW,
      updatedAt: NOW,
    });
    return id;
  };
  return { t, programId, cycleId, model, key, status, approve };
}

describe("public outcome summary band status", () => {
  it("follows the read-time gates readiness applies, not the fit-time flag", async () => {
    const w = await world();
    expect(await w.status()).toBe("official_base_rate_only");
    // The stored model carries approved: true from the fit, but no live approval exists.
    expect(w.model.gates.approved).toBe(true);
    await bandsRepo.storeProgramBandModels(w.t.db, { key: w.key, fittedOn: FIXTURE_FITTED_ON, algo: "bands-fit-v1", model: w.model }, NOW);
    expect(await w.status()).toBe("official_base_rate_only");

    const taskId = await w.approve();
    expect(await w.status()).toBe("live");

    // Too old: the 62-day limit applies to the summary too.
    expect(await w.status(Date.parse("2027-02-01T00:00:00Z"))).toBe("official_base_rate_only");

    // A hold on the program's cycle turns it off.
    await bandsRepo.holdCycle(w.t.db, { programCycleId: w.cycleId, reason: "over_count" }, NOW);
    expect(await w.status()).toBe("official_base_rate_only");
    await bandsRepo.releaseCycleHolds(w.t.db, w.cycleId, NOW + 1);
    expect(await w.status()).toBe("live");

    // A revoked approval turns it off at once.
    await w.t.db.update(s.reviewTasks).set({ state: "rejected" }).where(eq(s.reviewTasks.id, taskId));
    expect(await w.status()).toBe("official_base_rate_only");
  });

  it("stays off when the program's own eligibility fails or the key is retired", async () => {
    const w = await world();
    const ineligible = BandModelSchema.parse({ ...w.model, programs: w.model.programs.map((p) => ({ ...p, eligible: false })) });
    await bandsRepo.storeProgramBandModels(w.t.db, { key: w.key, fittedOn: FIXTURE_FITTED_ON, algo: "bands-fit-v1", model: ineligible }, NOW);
    await w.approve();
    expect(await w.status()).toBe("official_base_rate_only");

    await bandsRepo.storeProgramBandModels(w.t.db, { key: w.key, fittedOn: FIXTURE_FITTED_ON, algo: "bands-fit-v1", model: w.model }, NOW + 1);
    expect(await w.status()).toBe("live");
    await bandsRepo.retireBandModel(w.t.db, w.key, NOW + 2);
    expect(await w.status()).toBe("official_base_rate_only");
  });
});
