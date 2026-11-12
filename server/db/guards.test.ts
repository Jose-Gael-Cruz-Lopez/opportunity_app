import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { guardTriggerNames, renderGuardsSql } from "./guards";
import { renderLookupsSql } from "./seed/lookups";
import { REPO_ROOT, createUser, seededDb, type TestDb } from "./testing/fixtures";
import { sampleIds } from "./seed/build";
import type { SampleSeed } from "./seed/build";

const MIGRATIONS = `${REPO_ROOT}/server/db/migrations`;

function migrationFile(suffix: string): string {
  const name = readdirSync(MIGRATIONS).find((f) => f.endsWith(`_${suffix}.sql`));
  if (!name) throw new Error(`no ${suffix} migration`);
  return readFileSync(`${MIGRATIONS}/${name}`, "utf8");
}

describe("generated migrations are current", () => {
  it("the guards migration equals renderGuardsSql()", () => {
    expect(migrationFile("guards")).toBe(renderGuardsSql());
  });

  it("the lookups migration equals renderLookupsSql()", () => {
    expect(migrationFile("lookups")).toBe(renderLookupsSql());
  });

  it("no migration declares a cascading action", () => {
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql"))) {
      expect(readFileSync(`${MIGRATIONS}/${f}`, "utf8"), f).not.toMatch(/ON DELETE (CASCADE|SET NULL|SET DEFAULT)/i);
    }
  });
});

describe("guards on a seeded database", () => {
  let t: TestDb & { seed: SampleSeed };
  const fail = (sql: string, pattern: RegExp) => expect(() => t.raw.exec(sql)).toThrow(pattern);

  beforeEach(async () => {
    t = await seededDb();
  });

  it("holds every guard trigger and expression index (the golden list)", () => {
    const triggers = t.raw.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").map((r) => r.name);
    expect(triggers).toEqual([...guardTriggerNames()].sort());
    const indexes = t.raw.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index'").map((r) => r.name);
    for (const n of ["deadlines_slot_uq", "consents_live_uq", "subscriptions_uq", "user_roles_live_uq"]) expect(indexes).toContain(n);
  });

  it("registry_audit is append-only", () => {
    t.raw.exec(
      "INSERT INTO registry_audit (id, at, actor_kind, actor_ref, entity_type, entity_id, field, snapshot_ids) VALUES ('a1', 1, 'system', 'test', 'program', 'p', 'name', '[]')",
    );
    fail("UPDATE registry_audit SET field = 'x' WHERE id = 'a1'", /append-only/);
    fail("DELETE FROM registry_audit WHERE id = 'a1'", /append-only/);
  });

  it("access_audit allows only a tombstone update and keeps rows for 24 months", () => {
    const now = Date.now();
    t.raw.exec(`INSERT INTO access_audit (id, created_at, actor_kind, actor_ref, action, purpose, fields, subject_key) VALUES ('x1', ${now}, 'user', 'self', 'read', 'test', '["classYear"]', 'subj')`);
    fail("UPDATE access_audit SET purpose = 'changed' WHERE id = 'x1'", /append-only/);
    t.raw.exec("UPDATE access_audit SET subject_key = 'tombstone:abc' WHERE id = 'x1'");
    fail("DELETE FROM access_audit WHERE id = 'x1'", /24 months/);
  });

  it("verified rule sets are immutable, but may be superseded", () => {
    const id = sampleIds.ruleSet("sample-summer-analytics-internship");
    fail(`UPDATE eligibility_rule_sets SET body = '{}' WHERE id = '${id}'`, /immutable/);
    fail(`UPDATE eligibility_rule_sets SET state = 'draft' WHERE id = '${id}'`, /immutable/);
    t.raw.exec(`UPDATE eligibility_rule_sets SET state = 'superseded' WHERE id = '${id}'`);
  });

  it("refuses a second live national deadline in the same slot", () => {
    const cycle = sampleIds.cycle("sample-summer-analytics-internship");
    fail(
      `INSERT INTO deadlines (id, program_cycle_id, kind, scope, basis, precision, tz_mode, local_date, time_zone, due_at, sort_at, created_at, updated_at)
       VALUES ('dup', '${cycle}', 'application', 'national', 'official', 'date_only', 'fixed', '2027-01-01', 'America/New_York', 1, 1, 1, 1)`,
      /UNIQUE constraint failed/,
    );
  });

  it("enforces the deadline CHECKs (applicant-local rows store no zone or instant)", () => {
    const cycle = sampleIds.cycle("sample-summer-analytics-internship");
    fail(
      `INSERT INTO deadlines (id, program_cycle_id, kind, scope, basis, precision, tz_mode, local_date, local_time, time_zone, due_at, sort_at, round_label, created_at, updated_at)
       VALUES ('bad', '${cycle}', 'supplemental', 'national', 'official', 'exact', 'applicant_local', '2027-01-01', '23:59', 'America/New_York', NULL, 1, '', 1, 1)`,
      /CHECK constraint failed/,
    );
  });

  it("field evidence quotes are never rewritten; only superseded once", () => {
    t.raw.exec(
      "INSERT INTO field_evidence (id, entity_type, entity_id, field_path, basis, url, quote, match, created_at) VALUES ('ev1', 'program', 'p', 'name', 'manual_note', 'https://example.org', 'q', 'manual', 1)",
    );
    fail("UPDATE field_evidence SET quote = 'changed' WHERE id = 'ev1'", /never rewritten/);
    t.raw.exec("UPDATE field_evidence SET superseded_at = 5 WHERE id = 'ev1'");
    fail("UPDATE field_evidence SET superseded_at = 6 WHERE id = 'ev1'", /never rewritten/);
  });

  it("a health audience requires the sensitive_audience flag", () => {
    const p = sampleIds.program("sample-summer-analytics-internship");
    fail(`UPDATE programs SET identity_audience = '["health"]' WHERE id = '${p}'`, /requires sensitive_audience/);
  });

  it("refuses automated fetching on hosts whose policy forbids it", () => {
    t.raw.exec("INSERT INTO source_hosts (host, policy, policy_source, min_interval_ms, updated_at) VALUES ('forms.example.org', 'link_only', 'seed', 2000, 1)");
    fail(
      "INSERT INTO sources (id, kind, url, host, next_check_at, created_at, updated_at) VALUES ('s1', 'official_page', 'https://forms.example.org/a', 'forms.example.org', 5, 1, 1)",
      /forbids automated fetching/,
    );
    t.raw.exec("INSERT INTO sources (id, kind, url, host, created_at, updated_at) VALUES ('s1', 'official_page', 'https://forms.example.org/a', 'forms.example.org', 1, 1)");
    fail("UPDATE sources SET next_check_at = 10 WHERE id = 's1'", /forbids automated fetching/);
  });

  it("refuses program lists for unapproved workspaces", () => {
    t.raw.exec("INSERT INTO advisor_workspaces (id, name, kind, created_at, updated_at) VALUES ('w1', 'Pilot', 'concierge_pilot', 1, 1)");
    fail(
      "INSERT INTO program_lists (id, owner_kind, workspace_id, title, visibility, token, created_at, updated_at) VALUES ('l1', 'workspace', 'w1', 'T', 'unlisted', 'tok12345678901234567890', 1, 1)",
      /not approved/,
    );
  });

  it("audience guard: a tracker row on a sensitive-audience program needs a live consent", async () => {
    const user = await createUser(t.db);
    const cycle = sampleIds.cycle("sample-phd-pathway-program");
    const program = sampleIds.program("sample-phd-pathway-program");
    const insert = `INSERT INTO tracker_items (id, user_id, program_cycle_id, created_at, updated_at) VALUES ('ti1', '${user}', '${cycle}', 1, 1)`;
    fail(insert, /audience consent required/);
    t.raw.exec("INSERT INTO consent_texts (version, kind, text_sha256, published_at) VALUES ('st-1', 'sensitive_tracking', 'x', 1)");
    t.raw.exec(`INSERT INTO consents (id, user_id, kind, scope_type, scope_id, text_version, method, granted_at) VALUES ('c1', '${user}', 'sensitive_tracking', 'program', '${program}', 'st-1', 'dialog', 1)`);
    t.raw.exec(insert);
    // Outcomes stay refused whatever the consents.
    fail(`INSERT INTO outcomes (id, public_id, user_id, program_cycle_id, created_at, updated_at) VALUES ('o1', 'pub1234567890123456', '${user}', '${cycle}', 1, 1)`, /audience consent required/);
  });

  it("audience guard: identity-audience programs need identity_tracking consent", async () => {
    const user = await createUser(t.db);
    const cycle = sampleIds.cycle("sample-women-in-computing-cohort");
    const insert = `INSERT INTO tracker_items (id, user_id, program_cycle_id, created_at, updated_at) VALUES ('ti2', '${user}', '${cycle}', 1, 1)`;
    fail(insert, /audience consent required/);
    t.raw.exec("INSERT INTO consent_texts (version, kind, text_sha256, published_at) VALUES ('it-1', 'identity_tracking', 'x', 1)");
    t.raw.exec(`INSERT INTO consents (id, user_id, kind, text_version, method, granted_at) VALUES ('c2', '${user}', 'identity_tracking', 'it-1', 'dialog', 1)`);
    t.raw.exec(insert);
  });

  it("allows one live consent per subject, kind and scope", async () => {
    const user = await createUser(t.db);
    t.raw.exec("INSERT INTO consent_texts (version, kind, text_sha256, published_at) VALUES ('a-1', 'analytics', 'x', 1)");
    t.raw.exec(`INSERT INTO consents (id, user_id, kind, text_version, method, granted_at) VALUES ('k1', '${user}', 'analytics', 'a-1', 'dialog', 1)`);
    fail(`INSERT INTO consents (id, user_id, kind, text_version, method, granted_at) VALUES ('k2', '${user}', 'analytics', 'a-1', 'dialog', 2)`, /UNIQUE/);
    t.raw.exec("UPDATE consents SET revoked_at = 3 WHERE id = 'k1'");
    t.raw.exec(`INSERT INTO consents (id, user_id, kind, text_version, method, granted_at) VALUES ('k2', '${user}', 'analytics', 'a-1', 'dialog', 4)`);
  });

  it("deadlines and cycles of real (non-sample) programs cannot be deleted", () => {
    t.raw.exec("UPDATE programs SET is_sample = 0 WHERE slug = 'sample-summer-analytics-internship'");
    const cycle = sampleIds.cycle("sample-summer-analytics-internship");
    fail(`DELETE FROM deadlines WHERE program_cycle_id = '${cycle}'`, /withdraw deadlines/);
  });
});
