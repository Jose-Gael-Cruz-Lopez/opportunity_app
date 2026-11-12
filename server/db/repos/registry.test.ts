import { beforeEach, describe, expect, it } from "vitest";
import { ProgramCardSchema, ProgramDetailSchema, DeadlineSchema } from "../../../shared/contracts/registry";
import { seededDb, type TestDb } from "../testing/fixtures";
import { sampleIds, type SampleSeed } from "../seed/build";
import { uuidv7 } from "../columns";
import * as registry from "./registry";

const NOW = Date.parse("2026-11-11T15:00:00Z");
const CITATION = { origin: "https://novus.example.org", license: "see-terms", termsPath: "/terms" };
const ACTOR = { kind: "curator" as const, ref: "Sample Curator" };

describe("pure read-model helpers", () => {
  it("pickCurrentCycle prefers open, then upcoming, then the latest past cycle", () => {
    const c = (status: string, cycleKey: string) => ({ status, cycleKey });
    expect(registry.pickCurrentCycle([c("closed", "summer-2026"), c("open", "summer-2027")])?.cycleKey).toBe("summer-2027");
    expect(registry.pickCurrentCycle([c("closed", "summer-2026"), c("expected", "summer-2027")])?.status).toBe("expected");
    expect(registry.pickCurrentCycle([c("closed", "summer-2025"), c("closed", "summer-2026")])?.cycleKey).toBe("summer-2026");
    expect(registry.pickCurrentCycle([])).toBeNull();
  });

  it("prepDays is null when nothing is known, never zero", () => {
    expect(registry.prepDays([])).toBeNull();
    expect(registry.prepDays([{ leadTimeDays: null, effortHours: null }])).toBeNull();
    expect(registry.prepDays([{ leadTimeDays: 10, effortHours: 3 }, { leadTimeDays: 20, effortHours: null }])).toBe(20);
  });

  it("flags paid programs, fees and Pell displacement", () => {
    const flags = registry.programFlags({
      compensation: { kind: "stipend", amountCents: 100, period: "total" },
      applicationFeeCents: 2500,
      participantCostCents: null,
      pellDisplacement: "possible",
      sensitiveAudience: false,
      identityAudience: ["gender_identity"],
      nominationRequired: true,
    });
    expect(flags).toEqual({ paid: true, participantCost: false, applicationFee: true, pellDisplacement: true, sensitiveAudience: false, identityAudience: true, nominationRequired: true });
  });

  it("stage odds use consecutive official counts only", () => {
    const ev = { basis: "snapshot" as const, url: "https://example.org/c", quote: "q", retrievedOn: "2026-01-01" };
    const odds = registry.stageOddsFromCounts(
      [
        { programCycleId: "x", stage: "awards", count: 50, kind: "exact", provenance: "official_publication", asOf: "2026-04-01", evidence: ev },
        { programCycleId: "x", stage: "applicants", count: 1000, kind: "approx", provenance: "official_publication", asOf: "2026-02-01", evidence: ev },
        { programCycleId: "x", stage: "finalists", count: 200, kind: "exact", provenance: "owner_reported", asOf: "2026-03-01", evidence: ev },
      ],
      "summer-2026",
      "Sample Curator",
    );
    expect(odds).toHaveLength(1);
    expect(odds[0]).toMatchObject({ fromStage: "applicants", toStage: "awards", numerator: 50, denominator: 1000, denominatorKind: "approx", cycleYear: 2026 });
  });
});

describe("registry reads on the sample seed", () => {
  let t: TestDb & { seed: SampleSeed };
  beforeEach(async () => {
    t = await seededDb();
  });

  it("builds a valid card for every published program", async () => {
    const cards = await registry.listProgramCards(t.db, NOW);
    expect(cards).toHaveLength(t.seed.programs.length);
    for (const card of cards) {
      const parsed = ProgramCardSchema.safeParse(card);
      expect(parsed.success, `${card.slug}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues[0])}`).toBe(true);
      expect(card.isSample).toBe(true);
    }
    const analytics = cards.find((c) => c.slug === "sample-summer-analytics-internship");
    expect(analytics?.verification.state).toBe("verified");
    expect(analytics?.verification.verifiedBy).toBe("Sample Curator");
    expect(analytics?.deadlines[0]?.dueAt).toBe("2026-12-27T04:59:00.000Z");
    const scholarship = cards.find((c) => c.slug === "sample-national-stem-scholarship");
    expect(scholarship?.flags.nominationRequired).toBe(true);
    // Campus rows stay out of the national card.
    expect(scholarship?.deadlines.every((d) => d.scope === "national")).toBe(true);
  });

  it("serves a valid program detail with a citation", async () => {
    const detail = await registry.getProgramDetail(t.db, "sample-national-stem-scholarship", NOW, CITATION);
    expect(detail).not.toBeNull();
    const parsed = ProgramDetailSchema.safeParse(detail);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues.slice(0, 3))).toBe(true);
    expect(detail?.deadlines.some((d) => d.scope === "campus")).toBe(true);
    expect(detail?.requirements.length).toBeGreaterThan(0);
    expect(detail?.citation.novusUrl).toBe("https://novus.example.org/programs/sample-national-stem-scholarship");
    expect(await registry.getProgramDetail(t.db, "no-such-program", NOW, CITATION)).toBeNull();
  });

  it("binds any number of ids as one JSON parameter (101 ids)", async () => {
    const ids = [...t.seed.programCycles.map((c) => c.id as string), ...Array.from({ length: 101 - t.seed.programCycles.length }, () => uuidv7())];
    expect(ids).toHaveLength(101);
    const deadlines = await registry.listLiveDeadlines(t.db, ids);
    expect(deadlines).toHaveLength(t.seed.deadlines.length);
    for (const d of deadlines) expect(DeadlineSchema.safeParse(d).success).toBe(true);
  });

  it("lists deadlines in a window in sort order", async () => {
    const rows = await registry.listDeadlinesBetween(t.db, { fromMs: NOW, toMs: NOW + 60 * 86_400_000, limit: 100 });
    expect(rows.length).toBeGreaterThan(3);
    const sortAts = rows.map((r) => r.deadline.sortAt as number);
    expect([...sortAts].sort((a, b) => a - b)).toEqual(sortAts);
    expect(rows.every((r) => r.deadline.scope === "national")).toBe(true);
  });

  it("counts programs per opportunity type", async () => {
    const counts = await registry.opportunityTypeCounts(t.db);
    expect(counts).toHaveLength(33);
    expect(counts.find((c) => c.slug === "research_program")?.programCount).toBe(2);
  });

  it("searches institutions and resolves email domains", async () => {
    expect((await registry.searchInstitutions(t.db, "Sample State", 10)).map((i) => i.name)).toEqual(["Sample State University (sample)"]);
    expect((await registry.institutionForEmailDomain(t.db, "STUDENTS.sample-state.example.org"))?.level).toBe("four_year");
  });
});

describe("guarded publishing", () => {
  let t: TestDb & { seed: SampleSeed };
  const cycleId = () => sampleIds.cycle("sample-summer-analytics-internship");
  const counts = () => ({
    audit: t.raw.query<{ n: number }>("SELECT count(*) n FROM registry_audit")[0]?.n,
    events: t.raw.query<{ n: number }>("SELECT count(*) n FROM change_events")[0]?.n,
    evidence: t.raw.query<{ n: number }>("SELECT count(*) n FROM field_evidence")[0]?.n,
  });
  beforeEach(async () => {
    t = await seededDb();
  });

  const supplemental = () => ({
    programCycleId: cycleId(),
    kind: "supplemental" as const,
    scope: "national" as const,
    institutionId: null,
    basis: "official" as const,
    precision: "exact" as const,
    tzMode: "fixed" as const,
    localDate: "2027-01-15",
    localTime: "17:00",
    windowStart: null,
    windowEnd: null,
    timeZone: "America/Chicago",
    tzSource: "stated" as const,
    verificationState: "verified" as const,
  });
  const evidence = [{ fieldPath: "local_date", basis: "manual_note", url: "https://example.org/sample/x", quote: "Sample quote", match: "manual" } as const];

  it("a stale cycle version leaves no deadline, evidence, audit or ChangeEvent row", async () => {
    const before = counts();
    const r = await registry.publishDeadline(t.db, supplemental(), evidence.map((e) => ({ ...e, entityType: "deadline", entityId: "" })), {
      guardKey: "task-stale",
      cycleVersion: 99,
      actor: ACTOR,
      now: NOW,
    });
    expect(r).toEqual({ ok: false, error: "version_conflict", detail: undefined });
    expect(counts()).toEqual(before);
  });

  it("publishes, then revises a deadline with a higher revision; retries apply once", async () => {
    const first = await registry.publishDeadline(t.db, supplemental(), evidence.map((e) => ({ ...e, entityType: "deadline", entityId: "" })), {
      guardKey: "task-1",
      cycleVersion: 1,
      actor: ACTOR,
      now: NOW,
    });
    expect(first.ok).toBe(true);
    const id = first.ok ? first.value : "";
    const retry = await registry.publishDeadline(t.db, supplemental(), [], { guardKey: "task-1", cycleVersion: 2, actor: ACTOR, now: NOW });
    expect(retry).toMatchObject({ ok: false, error: "already_applied" });
    const moved = await registry.publishDeadline(t.db, { ...supplemental(), localDate: "2027-01-20" }, [], { guardKey: "task-2", cycleVersion: 2, actor: ACTOR, now: NOW + 1 });
    expect(moved).toEqual({ ok: true, value: id });
    const row = t.raw.query<{ revision: number; due_at: number }>("SELECT revision, due_at FROM deadlines WHERE id = ?", id)[0];
    expect(row?.revision).toBe(2);
    expect(row?.due_at).toBe(Date.parse("2027-01-20T23:00:00Z"));
    expect(t.raw.query("SELECT type FROM change_events WHERE program_cycle_id = ?", cycleId())).toHaveLength(2);
    expect(t.raw.query<{ version: number }>("SELECT version FROM program_cycles WHERE id = ?", cycleId())[0]?.version).toBe(3);
  });

  it("rejects an invalid deadline before touching the database", async () => {
    const r = await registry.publishDeadline(t.db, { ...supplemental(), localTime: null }, [], { guardKey: "task-x", cycleVersion: 1, actor: ACTOR, now: NOW });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toBe("invalid");
  });

  it("withdraws a deadline (never deletes it) and bumps its revision", async () => {
    const deadlineId = sampleIds.deadline("sample-summer-analytics-internship", 0);
    const r = await registry.withdrawDeadline(t.db, deadlineId, { guardKey: "w-1", cycleVersion: 1, actor: ACTOR, now: NOW });
    expect(r.ok).toBe(true);
    expect(t.raw.query<{ revision: number; withdrawn_at: number }>("SELECT revision, withdrawn_at FROM deadlines WHERE id = ?", deadlineId)[0]).toEqual({ revision: 2, withdrawn_at: NOW });
  });

  it("follows the cycle state machine", async () => {
    const bad = await registry.transitionCycleStatus(t.db, cycleId(), "expected", { guardKey: "s-0", cycleVersion: 1, actor: ACTOR, now: NOW });
    expect(bad.ok).toBe(false);
    const good = await registry.transitionCycleStatus(t.db, cycleId(), "closed", { guardKey: "s-1", cycleVersion: 1, actor: ACTOR, now: NOW });
    expect(good).toEqual({ ok: true, value: "closed" });
    expect(t.raw.query("SELECT 1 FROM change_events WHERE type = 'cycle.status_changed'")).toHaveLength(1);
  });

  it("publishes a new rule-set version and supersedes the old one", async () => {
    const rs = await registry.getVerifiedRuleSet(t.db, cycleId());
    expect(rs?.version).toBe(1);
    const draft = await registry.insertRuleSetDraft(
      t.db,
      cycleId(),
      {
        format: "jsonlogic-v1",
        templateKey: null,
        coverage: rs?.coverage ?? {},
        rules: rs?.rules ?? [],
        anyOf: [],
        attestations: [],
        nomination: null,
        evidence: rs?.evidence ?? {},
        createdVia: "console",
        fromCycleKey: null,
      },
      NOW,
    );
    expect(draft.ok).toBe(true);
    const id = draft.ok ? draft.value.id : "";
    const published = await registry.publishRuleSet(t.db, id, sampleIds.curator(), { guardKey: "rs-1", cycleVersion: 1, actor: ACTOR, now: NOW });
    expect(published.ok).toBe(true);
    const states = t.raw.query<{ version: number; state: string }>("SELECT version, state FROM eligibility_rule_sets WHERE program_cycle_id = ? ORDER BY version", cycleId());
    expect(states).toEqual([
      { version: 1, state: "superseded" },
      { version: 2, state: "verified" },
    ]);
    expect((await registry.getVerifiedRuleSet(t.db, cycleId()))?.hash).toBe(rs?.hash);
  });

  it("allocates release numbers without gaps and only moves the pointer forward", async () => {
    const a = await registry.allocateRelease(t.db, NOW);
    const b = await registry.allocateRelease(t.db, NOW);
    expect([a, b]).toEqual([1, 2]);
    expect(await registry.markReleasePublished(t.db, b, NOW)).toBe(true);
    expect(await registry.markReleasePublished(t.db, a, NOW)).toBe(false);
    expect((await registry.latestPublishedRelease(t.db))?.number).toBe(2);
  });

  it("upserts a source with its resolved host and lists due sources", async () => {
    const id = await registry.upsertSource(
      t.db,
      { url: "https://example.org/sample/page", kind: "official_page", host: "example.org", hostPolicy: "allowed", policySource: "default", nextCheckAt: NOW - 1 },
      NOW,
    );
    t.raw.exec(`UPDATE sources SET approval = 'approved' WHERE id = '${id}'`);
    expect((await registry.listDueSources(t.db, NOW, 10)).map((s) => s.id)).toEqual([id]);
    const snap = await registry.recordSnapshot(
      t.db,
      {
        sourceId: id,
        fetchedAt: NOW,
        requestedUrl: "https://example.org/sample/page",
        finalUrl: "https://example.org/sample/page",
        httpStatus: 200,
        contentType: "text/html",
        rawSha256: "a".repeat(64),
        normalizerVersion: "1",
        rawKey: "snapshots/aa",
        hostPolicy: "allowed",
      },
      NOW,
    );
    expect(snap).toMatch(/^[0-9a-f-]{36}$/);
  });
});
