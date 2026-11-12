import { describe, expect, it } from "vitest";
import { OPPORTUNITY_TYPES } from "../../../shared/taxonomy";
import { EligibilityRuleSetSchema, isSensitiveField, SENSITIVE_DIMENSIONS } from "../../../shared/contracts/eligibility";
import { buildSampleSeed, sampleCycleKey, sampleStatus, termLabel } from "./build";
import { SAMPLE_PROGRAMS } from "./sample-data";
import { renderSeedSql } from "./statements";
import { freshDb } from "../testing/fixtures";

describe("sample seed data", () => {
  it("has about 25 programs covering every in-scope opportunity type", async () => {
    const seed = await buildSampleSeed();
    expect(seed.programs.length).toBeGreaterThanOrEqual(25);
    const covered = new Set(seed.programTypes.map((t) => t.typeSlug));
    const inScope = OPPORTUNITY_TYPES.filter((t) => t.inScope).map((t) => t.slug);
    expect(inScope.filter((slug) => !covered.has(slug))).toEqual([]);
  });

  it("labels every record as sample and points only at example.org", async () => {
    const seed = await buildSampleSeed();
    for (const p of seed.programs) {
      expect(p.isSample).toBe(true);
      expect(p.name).toMatch(/Sample/);
      expect(p.officialUrl).toMatch(/^https:\/\/example\.org\//);
    }
    for (const o of seed.organizations) {
      expect(o.isSample).toBe(true);
      expect(o.name).toMatch(/\(sample\)/);
    }
    for (const c of seed.programCycles) expect(c.applicationUrl).toMatch(/^https:\/\/example\.org\//);
    for (const rs of seed.ruleSetObjects) {
      expect(rs.createdVia).toBe("sample");
      for (const ev of Object.values(rs.evidence)) {
        expect(ev.url).toMatch(/^https:\/\/example\.org\//);
        expect(ev.quote ?? "").toMatch(/^Sample text, not a real program/);
      }
    }
  });

  it("builds valid JsonLogic rule sets with sensitive rules marked sensitive", async () => {
    const seed = await buildSampleSeed();
    for (const rs of seed.ruleSetObjects) {
      expect(EligibilityRuleSetSchema.safeParse(rs).success).toBe(true);
      for (const rule of rs.rules) {
        const sensitive = rule.fields.some(isSensitiveField) || (SENSITIVE_DIMENSIONS as readonly string[]).includes(rule.dimension);
        expect(rule.sensitive).toBe(sensitive);
      }
    }
    // Exercise both sides: some rule sets have device-only rules, some have none.
    expect(seed.ruleSetObjects.some((r) => r.rules.some((x) => x.sensitive))).toBe(true);
    expect(seed.ruleSetObjects.some((r) => r.rules.every((x) => !x.sensitive))).toBe(true);
  });

  it("covers the deadline shapes and cycle states the UI must show", async () => {
    const seed = await buildSampleSeed();
    const precisions = new Set(seed.deadlines.map((d) => d.precision));
    for (const p of ["exact", "date_only", "month_only", "rolling", "window"]) expect(precisions.has(p)).toBe(true);
    expect(seed.deadlines.some((d) => d.tzMode === "applicant_local")).toBe(true);
    expect(seed.deadlines.some((d) => d.scope === "campus")).toBe(true);
    const statuses = new Set(seed.programCycles.map((c) => c.status));
    for (const st of ["open", "expected", "closed"]) expect(statuses.has(st)).toBe(true);
    expect(seed.programs.some((p) => p.sensitiveAudience)).toBe(true);
    expect(seed.programs.some((p) => (p.identityAudience ?? []).length > 0)).toBe(true);
  });

  it("dates move with --today", async () => {
    const a = await buildSampleSeed("2026-11-11");
    const b = await buildSampleSeed("2027-03-01");
    const first = (s: typeof a) => s.deadlines.find((d) => d.precision === "exact")?.localDate;
    expect(first(a)).not.toEqual(first(b));
    expect(sampleCycleKey("summer", "2026-11-11")).toBe("summer-2027");
    expect(sampleCycleKey("summer", "2027-03-01")).toBe("summer-2027");
    expect(sampleCycleKey("ay", "2026-11-11")).toBe("ay-2027-28");
    expect(sampleCycleKey("fall", "2026-11-11")).toBe("fall-2027");
    expect(termLabel("ay-2027-28")).toBe("2027-28");
    expect(termLabel("summer-2027")).toBe("Summer 2027");
  });

  it("derives status from the sample dates", () => {
    const closed = SAMPLE_PROGRAMS.find((p) => p.slug === "sample-graduate-research-fellowship");
    const expected = SAMPLE_PROGRAMS.find((p) => p.slug === "sample-open-source-mentorship");
    expect(closed && sampleStatus(closed)).toBe("closed");
    expect(expected && sampleStatus(expected)).toBe("expected");
  });

  it("generated SQL applies cleanly, is idempotent and can be reset", async () => {
    const { raw } = await freshDb();
    const seed = await buildSampleSeed();
    const sql = renderSeedSql(seed);
    raw.exec(sql);
    raw.exec(sql);
    const count = (table: string) => raw.query<{ n: number }>(`SELECT count(*) n FROM ${table}`)[0]?.n;
    expect(count("programs")).toBe(seed.programs.length);
    expect(count("deadlines")).toBe(seed.deadlines.length);
    expect(raw.query("PRAGMA foreign_key_check")).toEqual([]);
    raw.exec(renderSeedSql(seed, { reset: true }));
    expect(count("programs")).toBe(seed.programs.length);
    expect(count("eligibility_rule_sets")).toBe(seed.eligibilityRuleSets.length);
  });

  it("ids are stable across builds", async () => {
    const a = await buildSampleSeed();
    const b = await buildSampleSeed();
    expect(a.programs.map((p) => p.id)).toEqual(b.programs.map((p) => p.id));
    expect(a.ruleSetObjects.map((r) => r.hash)).toEqual(b.ruleSetObjects.map((r) => r.hash));
  });
});
