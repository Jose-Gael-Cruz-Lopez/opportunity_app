import { beforeEach, describe, expect, it } from "vitest";
import { OutcomeReportSchema, ProgramListSchema, WorkspaceReportSchema } from "../../../shared/contracts/advisor";
import { createUser, seededDb, type TestDb } from "../testing/fixtures";
import { sampleIds, type SampleSeed } from "../seed/build";
import * as advisor from "./advisor";
import * as outcomes from "./outcomes";

const NOW = Date.parse("2026-11-11T15:00:00Z");

describe("advisor lists", () => {
  let t: TestDb & { seed: SampleSeed };
  let wsA: string;
  let wsB: string;
  beforeEach(async () => {
    t = await seededDb();
    wsA = await advisor.createWorkspace(t.db, { name: "Pilot A", approvedBy: "founder" }, NOW);
    wsB = await advisor.createWorkspace(t.db, { name: "Pilot B", approvedBy: "founder" }, NOW);
  });

  it("creates public and unlisted lists and derives the restricted flag", async () => {
    const pub = await advisor.createProgramList(
      t.db,
      { workspaceId: wsA },
      { title: "Sophomore summer picks", description: null, visibility: "public", items: [{ programSlug: "sample-reu-site-ecology", cycleKey: null, note: "Good first research" }] },
      NOW,
    );
    expect(pub.ok).toBe(true);
    const list = pub.ok ? pub.value : null;
    expect(ProgramListSchema.safeParse(list).success).toBe(true);
    expect(list?.restricted).toBe(false);
    expect(list?.slug).toMatch(/^sophomore-summer-picks-/);
    expect((await advisor.getPublicProgramList(t.db, { slug: list!.slug! }))?.id).toBe(list?.id);

    const unlisted = await advisor.createProgramList(
      t.db,
      { workspaceId: wsA },
      { title: "Access programs", description: null, visibility: "unlisted", items: [{ programSlug: "sample-phd-pathway-program", cycleKey: null, note: null }] },
      NOW,
    );
    expect(unlisted.ok && unlisted.value.restricted).toBe(true);
    expect(unlisted.ok && unlisted.value.token?.length).toBe(22);
    expect(await advisor.createProgramList(t.db, { workspaceId: wsA }, { title: "Bad", description: null, visibility: "unlisted", items: [{ programSlug: "nope", cycleKey: null, note: null }] }, NOW)).toMatchObject({ ok: false, error: "invalid" });
  });

  it("isolates tenants: workspace B cannot read or edit workspace A's list", async () => {
    const created = await advisor.createProgramList(t.db, { workspaceId: wsA }, { title: "A list", description: null, visibility: "unlisted", items: [] }, NOW);
    const id = created.ok ? created.value.id : "";
    expect(await advisor.getProgramList(t.db, { workspaceId: wsB }, id)).toBeNull();
    expect(await advisor.updateProgramList(t.db, { workspaceId: wsB }, id, { title: "Hijack" }, 1, NOW)).toMatchObject({ ok: false, error: "not_found" });
    expect(await advisor.deleteProgramList(t.db, { workspaceId: wsB }, id, NOW)).toBe(false);
    expect(await advisor.listWorkspaceLists(t.db, { workspaceId: wsB })).toEqual([]);
  });

  it("updates with optimistic versions and refuses unapproved workspaces", async () => {
    const created = await advisor.createProgramList(t.db, { workspaceId: wsA }, { title: "A", description: null, visibility: "unlisted", items: [] }, NOW);
    const id = created.ok ? created.value.id : "";
    const v1 = await advisor.updateProgramList(t.db, { workspaceId: wsA }, id, { items: [{ programSlug: "sample-sprinternship", cycleKey: null, note: null }] }, 1, NOW + 1);
    expect(v1.ok && v1.value.items.map((i) => i.programSlug)).toEqual(["sample-sprinternship"]);
    expect(await advisor.updateProgramList(t.db, { workspaceId: wsA }, id, { title: "B" }, 1, NOW + 2)).toMatchObject({ ok: false, error: "version_conflict" });
    const unapproved = await advisor.createWorkspace(t.db, { name: "Pending" }, NOW);
    expect(await advisor.createProgramList(t.db, { workspaceId: unapproved }, { title: "X", description: null, visibility: "unlisted", items: [] }, NOW)).toMatchObject({ ok: false, error: "invalid" });
  });

  it("reports banded totals only and skips restricted programs", async () => {
    await advisor.createProgramList(
      t.db,
      { workspaceId: wsA },
      {
        title: "Mixed",
        description: null,
        visibility: "unlisted",
        items: [
          { programSlug: "sample-sprinternship", cycleKey: null, note: null },
          { programSlug: "sample-women-in-computing-cohort", cycleKey: null, note: null },
        ],
      },
      NOW,
    );
    const report = await advisor.workspaceReport(t.db, { workspaceId: wsA }, "2026-11", 3);
    expect(WorkspaceReportSchema.safeParse(report).success).toBe(true);
    expect(report.rows.map((r) => r.programSlug)).toEqual(["sample-sprinternship"]);
    expect(report.listViews).toBe("fewer than 10");
    expect(advisor.bandCount(30)).toBe("25-49");
    expect(advisor.bandCount(250)).toBe("200+");
  });
});

describe("outcome aggregates", () => {
  it("suppresses small cells, with secondary suppression when one cell could be recovered", () => {
    expect(outcomes.suppressCells(new Map([["accepted", 3]]))).toEqual({ total: null, cells: [{ key: "accepted", n: null }] });
    const r = outcomes.suppressCells(
      new Map([
        ["accepted", 2],
        ["rejected", 20],
        ["withdrew", 9],
      ]),
    );
    expect(r.total).toBe(31);
    expect(r.cells).toEqual([
      { key: "accepted", n: null },
      { key: "rejected", n: 20 },
      { key: "withdrew", n: null },
    ]);
    const two = outcomes.suppressCells(
      new Map([
        ["a", 2],
        ["b", 3],
        ["c", 30],
      ]),
    );
    expect(two.cells.map((c) => c.n)).toEqual([null, null, 30]);
  });

  it("reads nothing below five reports and refuses outcomes on sensitive-audience programs", async () => {
    const t = await seededDb();
    const cycle = sampleIds.cycle("sample-reu-site-ecology");
    const users = await Promise.all(Array.from({ length: 7 }, () => createUser(t.db)));
    const first = await outcomes.createOutcome(
      t.db,
      users[0]!,
      { programCycleId: cycle, stages: [{ stage: "submitted", on: "2027-02-01" }], decision: "accepted", decidedOn: "2027-03-15", priorFeeder: null },
      { classYear: "second_year", gpaBand: "prefer_not", majorFamily: "life_sciences", institutionLevel: "four_year" } as never,
      NOW,
    );
    expect(first.ok).toBe(true);
    const report = first.ok ? first.value : null;
    expect(OutcomeReportSchema.safeParse(report).success).toBe(true);
    expect(report?.snapshot).toEqual({ classYear: "second_year", gpaBand: null, majorFamily: "life_sciences", institutionType: "four_year", priorFeeder: null });
    expect(await outcomes.createOutcome(t.db, users[0]!, { programCycleId: cycle, stages: [], decision: null, decidedOn: null, priorFeeder: null }, null, NOW)).toMatchObject({ ok: false, error: "conflict" });

    expect((await outcomes.outcomeAggregate(t.db, cycle)).reports).toBeNull();
    for (const u of users.slice(1)) {
      await outcomes.createOutcome(t.db, u, { programCycleId: cycle, stages: [{ stage: "submitted", on: null }], decision: "rejected", decidedOn: null, priorFeeder: null }, null, NOW);
    }
    const agg = await outcomes.outcomeAggregate(t.db, cycle);
    expect(agg.reports).toBe(7);
    // One acceptance among seven: the small cell and its complement are both hidden.
    expect(agg.decisions.every((c) => c.n === null)).toBe(true);
    expect(agg.stages).toEqual([{ key: "submitted", n: 7 }]);

    const sensitive = await outcomes.createOutcome(
      t.db,
      users[1]!,
      { programCycleId: sampleIds.cycle("sample-phd-pathway-program"), stages: [], decision: null, decidedOn: null, priorFeeder: null },
      null,
      NOW,
    );
    expect(sensitive).toMatchObject({ ok: false, error: "consent_required" });
  });

  it("owners edit and delete their own report only", async () => {
    const t = await seededDb();
    const [a, b] = [await createUser(t.db), await createUser(t.db)];
    const r = await outcomes.createOutcome(t.db, a, { programCycleId: sampleIds.cycle("sample-sprinternship"), stages: [], decision: null, decidedOn: null, priorFeeder: "no" }, null, NOW);
    const publicId = r.ok ? r.value.publicId : "";
    expect(await outcomes.getOwnOutcome(t.db, b, publicId)).toBeNull();
    const updated = await outcomes.updateOwnOutcome(t.db, a, publicId, { decision: "accepted", stages: [{ stage: "interviewed", on: null }] }, NOW + 1);
    expect(updated.ok && updated.value).toMatchObject({ decision: "accepted", stages: [{ stage: "interviewed", on: null }] });
    expect(await outcomes.deleteOwnOutcome(t.db, b, publicId)).toBe(false);
    expect(await outcomes.deleteOwnOutcome(t.db, a, publicId)).toBe(true);
    expect(await outcomes.listOwnOutcomes(t.db, a)).toEqual([]);
  });
});
