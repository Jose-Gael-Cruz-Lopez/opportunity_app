import { describe, expect, it } from "vitest";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { is } from "drizzle-orm";
import { SQLiteTable as SQLiteTableClass } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";
import * as eventsSchema from "./events-schema";
import { isSensitiveKey } from "../../shared/contracts/sensitive";
import { FORBIDDEN_STUDENT_SCORE_FIELDS } from "../../shared/contracts/readiness";
import { freshDb, freshEventsDb } from "./testing/fixtures";

function tables(mod: Record<string, unknown>): SQLiteTable[] {
  return Object.values(mod).filter((v): v is SQLiteTable => is(v, SQLiteTableClass));
}

const MAIN = tables(schema);
const EVENTS = tables(eventsSchema);

/**
 * Tables that hold a person's data. Their column names must not look like a status or identity
 * answer (rule 3). Registry tables may carry allowlisted program flags such as
 * `sensitive_audience`, which describe programs, not people.
 */
const STUDENT_OWNED = [
  "users",
  "sessions",
  "accounts",
  "verifications",
  "student_profiles",
  "tracker_items",
  "requirement_progress",
  "roadmaps",
  "roadmap_items",
  "onboarding_records",
  "reminders",
  "consents",
  "contacts",
  "subscriptions",
  "alerts",
  "notifications",
  "notification_prefs",
  "calendar_feeds",
  "email_action_tokens",
  "outcomes",
  "outcome_stages",
  "reports",
  "user_roles",
  "access_audit",
];

const EVENT_TABLES = ["analytics_events", "program_daily_counts", "attribution_code_daily", "llm_calls", "llm_budgets", "llm_reservations", "email_send_ledger"];

function columnNames(t: SQLiteTable): string[] {
  return getTableConfig(t).columns.map((c) => c.name);
}

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split("_");
}

describe("privacy by construction", () => {
  it("lists only tables that exist", () => {
    const names = new Set([...MAIN, ...EVENTS].map((t) => getTableConfig(t).name));
    for (const n of [...STUDENT_OWNED, ...EVENT_TABLES]) expect(names.has(n), n).toBe(true);
  });

  it("no student-owned or events column can hold a SensitiveAnswer", () => {
    const offenders: string[] = [];
    for (const t of [...MAIN, ...EVENTS]) {
      const { name } = getTableConfig(t);
      if (!STUDENT_OWNED.includes(name) && !EVENT_TABLES.includes(name)) continue;
      for (const c of columnNames(t)) if (isSensitiveKey(c)) offenders.push(`${name}.${c}`);
    }
    expect(offenders).toEqual([]);
  });

  it("no column anywhere names a status or identity answer outside the registry allowlist", () => {
    const allowed = new Set(["programs.sensitive_audience", "programs.identity_audience", "program_cycles.pell_displacement", "attribution_codes.identity_owned", "institutions.is_tribal"]);
    const offenders: string[] = [];
    for (const t of [...MAIN, ...EVENTS]) {
      const { name } = getTableConfig(t);
      for (const c of columnNames(t)) if (isSensitiveKey(c) && !allowed.has(`${name}.${c}`)) offenders.push(`${name}.${c}`);
    }
    expect(offenders).toEqual([]);
  });

  it("no column stores a score, percentage, probability or grade (readiness has no composite number)", () => {
    const forbidden = new Set(FORBIDDEN_STUDENT_SCORE_FIELDS.flatMap((f) => words(f)).filter((w) => !["of", "match", "ready", "fit", "overall", "admit", "composite", "percent", "readiness"].includes(w)));
    const exact = new Set(FORBIDDEN_STUDENT_SCORE_FIELDS.map((f) => words(f).join("_")));
    const offenders: string[] = [];
    for (const t of [...MAIN, ...EVENTS]) {
      const { name } = getTableConfig(t);
      for (const c of columnNames(t)) {
        if (exact.has(c) || words(c).some((w) => forbidden.has(w))) offenders.push(`${name}.${c}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("no foreign key declares a cascading action", () => {
    for (const t of [...MAIN, ...EVENTS]) {
      for (const fk of getTableConfig(t).foreignKeys) {
        expect([undefined, "no action"]).toContain(fk.onDelete);
        expect([undefined, "no action"]).toContain(fk.onUpdate);
      }
    }
  });
});

describe("conventions", () => {
  it("uses snake_case table and column names", () => {
    for (const t of [...MAIN, ...EVENTS]) {
      const { name, columns } = getTableConfig(t);
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const c of columns) expect(c.name, `${name}.${c.name}`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("gives every mutable entity table created and updated timestamps", () => {
    const entities = ["organizations", "programs", "program_cycles", "deadlines", "requirements", "eligibility_rule_sets", "sources", "student_profiles", "tracker_items", "outcomes", "program_lists", "advisor_workspaces", "review_tasks", "jobs", "notifications", "institutions"];
    for (const t of MAIN) {
      const { name } = getTableConfig(t);
      if (!entities.includes(name)) continue;
      const cols = columnNames(t);
      expect(cols, name).toContain("created_at");
      expect(cols, name).toContain("updated_at");
    }
  });

  it("soft-deletes the account-class tables the plan names", () => {
    for (const name of ["users", "student_profiles", "tracker_items", "requirement_progress", "roadmap_items", "outcomes", "program_lists"]) {
      const t = MAIN.find((x) => getTableConfig(x).name === name) as SQLiteTable;
      expect(columnNames(t), name).toContain("deleted_at");
    }
  });
});

describe("migrations match the schema", () => {
  it("novus-main: every table and column in schema.ts exists after applying migrations", async () => {
    const { raw } = await freshDb();
    for (const t of MAIN) {
      const { name } = getTableConfig(t);
      const cols = raw.query<{ name: string }>(`PRAGMA table_info(${name})`).map((r) => r.name);
      expect(cols.sort(), name).toEqual(columnNames(t).sort());
    }
    expect(raw.query("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("novus-events: every table and column exists after applying migrations", async () => {
    const { raw } = await freshEventsDb();
    for (const t of EVENTS) {
      const { name } = getTableConfig(t);
      const cols = raw.query<{ name: string }>(`PRAGMA table_info(${name})`).map((r) => r.name);
      expect(cols.sort(), name).toEqual(columnNames(t).sort());
    }
  });

  it("lookup tables are populated from shared/taxonomy", async () => {
    const { raw } = await freshDb();
    expect(raw.query<{ n: number }>("SELECT count(*) n FROM opportunity_types")[0]?.n).toBe(33);
    expect(raw.query<{ n: number }>("SELECT count(*) n FROM deadline_kinds")[0]?.n).toBe(9);
    expect(raw.query<{ n: number }>("SELECT count(*) n FROM cycle_statuses")[0]?.n).toBe(6);
    expect(raw.query<{ n: number }>("SELECT count(*) n FROM review_task_kinds")[0]?.n).toBe(21);
  });
});
