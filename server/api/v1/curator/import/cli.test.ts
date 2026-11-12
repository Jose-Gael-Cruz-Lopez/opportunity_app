import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@server/db/schema";
import { seededDb } from "@server/db/testing/fixtures";
import { renderPlanSql } from "./apply";
import { existingCommand, existingFromWranglerJson, exitCodeOf, formatReport, parseCliArgs } from "./cli";
import { EXISTING_QUERIES, IMPORT_SYSTEM } from "./existing";
import { sha256Hex } from "./normalize";
import { parseCandidateFile } from "./parse";
import { planImport } from "./plan";
import { loadExistingFromDb, reportOf } from "./service";

// SAMPLE DATA ONLY: invented candidates on example.org hosts; none describes a real program.

const NOW = Date.parse("2026-11-11T15:00:00Z");
const ACTOR = { kind: "system" as const, ref: "local-cli:import-candidates" };

describe("parseCliArgs", () => {
  it("needs --file and --local, and parses the options", () => {
    expect(parseCliArgs([])).toEqual({ ok: false, error: "--file is required" });
    expect(parseCliArgs(["--file", "a.json"])).toMatchObject({ ok: false, error: expect.stringMatching(/--local is required/) });
    expect(parseCliArgs(["--file", "a.json", "--local"])).toEqual({
      ok: true,
      options: { file: "a.json", local: true, dryRun: false, sample: false, json: false, format: null, config: "infra/wrangler/wrangler.toml", database: "novus-main", persistTo: null },
    });
    expect(parseCliArgs(["--file=a.csv", "--local", "--dry-run", "--sample", "--json", "--format", "csv", "--persist-to", "/tmp/x"])).toMatchObject({
      ok: true,
      options: { file: "a.csv", dryRun: true, sample: true, json: true, format: "csv", persistTo: "/tmp/x" },
    });
  });

  it("refuses unknown flags, bad values and remote-looking database names", () => {
    expect(parseCliArgs(["--file", "a", "--local", "--remote"])).toMatchObject({ ok: false, error: "unknown argument: --remote" });
    expect(parseCliArgs(["--file", "--local"])).toMatchObject({ ok: false, error: "--file needs a value" });
    expect(parseCliArgs(["--file", "a", "--local", "--format", "xlsx"])).toMatchObject({ ok: false });
    expect(parseCliArgs(["--file", "a", "--local", "--database", "x; DROP"])).toMatchObject({ ok: false });
    expect(parseCliArgs(["--help"])).toEqual({ ok: false, error: "help" });
  });
});

describe("wrangler output", () => {
  it("joins the read queries and parses one result set per query", () => {
    const n = Object.keys(EXISTING_QUERIES).length;
    expect(existingCommand().split("; ")).toHaveLength(n);
    const sets = Array.from({ length: n }, () => ({ results: [] as unknown[], success: true, meta: {} }));
    sets[0]!.results = [{ id: "o1", slug: "example-org", name: "Example Org" }];
    sets[4]!.results = [{ host: "x.example.org", policy: "manual_only", policySource: "curator" }];
    const existing = existingFromWranglerJson(`some banner\n${JSON.stringify(sets)}`);
    expect(existing.organizations).toEqual([{ id: "o1", slug: "example-org", name: "Example Org" }]);
    expect(existing.hostPolicies.get("x.example.org")).toEqual({ policy: "manual_only", policySource: "curator" });
    expect(() => existingFromWranglerJson("no json")).toThrow();
    expect(() => existingFromWranglerJson("[]")).toThrow();
    sets[2]!.success = false;
    expect(() => existingFromWranglerJson(JSON.stringify(sets))).toThrow(/failed/);
  });
});

describe("rendered SQL against the real schema", () => {
  const file = JSON.stringify([
    {
      name: "Sample O'Brien Scholars Program",
      organization: "Example Foundation for O'Brien Scholars",
      official_url: "https://obrien.example.org/scholars?utm_source=x",
      types: ["private_scholarship"],
      notes: "Says: \"apply early\"; uses 'quotes'.",
      deadline: "2027-03-01",
    },
    {
      name: "Sample REU Site in Field Ecology",
      organization: "Example Science Foundation (sample)",
      official_url: "https://example.org/sample/sample-reu-site-ecology",
      types: ["research_program"],
    },
    { name: "Sample Guide PDF Program", organization: "Example Science Foundation (sample)", official_url: "https://files.example.org/guide.pdf", types: ["grant"] },
  ]);

  it("applies with wrangler-style SQL, writes drafts only, and a re-run plans nothing new", async () => {
    const t = await seededDb();
    const parsed = parseCandidateFile(file, { hint: "c.json" });
    if (!parsed.ok) throw new Error(parsed.error);
    const before = await loadExistingFromDb(t.db);
    const plan = await planImport(parsed.rows, before, { now: NOW, fileSha256: await sha256Hex(file), format: parsed.format, actor: ACTOR });
    expect(plan.outcomes.map((o) => o.status)).toEqual(["created", "duplicate", "created"]);

    const sql = renderPlanSql(plan);
    expect(sql).toMatch(/^-- Novus candidate import/);
    expect(sql).not.toMatch(/\?/); // every parameter inlined
    t.raw.exec(sql);

    const obrien = await t.db.query.programs.findFirst({ where: eq(s.programs.id, plan.units[0]!.program.id!) });
    expect(obrien).toMatchObject({ name: "Sample O'Brien Scholars Program", isPublished: false, officialUrl: "https://obrien.example.org/scholars" });
    const org = await t.db.query.organizations.findFirst({ where: eq(s.organizations.id, obrien!.organizationId) });
    expect(org?.name).toBe("Example Foundation for O'Brien Scholars");
    const tasks = await t.db.select().from(s.reviewTasks).where(eq(s.reviewTasks.subjectId, obrien!.id));
    expect(tasks[0]!.payload).toMatchObject({ proposal: { notes: "Says: \"apply early\"; uses 'quotes'." } });
    const audit = await t.db.select().from(s.registryAudit).where(eq(s.registryAudit.entityId, obrien!.id));
    expect(audit[0]).toMatchObject({ actorKind: "system", actorRef: "local-cli:import-candidates" });
    // The PDF row joins the existing sample Organization.
    const sampleOrg = before.organizations.find((o) => o.name === "Example Science Foundation (sample)")!;
    expect(plan.units[1]!.program.organizationId).toBe(sampleOrg.id);
    expect(plan.units[1]!.source?.kind).toBe("official_pdf");
    expect(plan.organizations).toHaveLength(1);

    const after = await loadExistingFromDb(t.db);
    expect([...after.importedRefs.keys()]).toHaveLength(2);
    const again = await planImport(parsed.rows, after, { now: NOW, fileSha256: "x", format: "json", actor: ACTOR });
    expect(again.outcomes.map((o) => o.status)).toEqual(["already_imported", "duplicate", "already_imported"]);
    expect(renderPlanSql(again).split("\n").filter((l) => l && !l.startsWith("--"))).toEqual([]);

    const refs = t.raw.query<{ n: number }>("SELECT count(*) AS n FROM external_refs WHERE system = ?", IMPORT_SYSTEM);
    expect(refs[0]!.n).toBe(2);
  });

  it("formats the report and sets the exit code", async () => {
    const parsed = parseCandidateFile(JSON.stringify([{ name: "Sample Bad" }, { name: "Sample Good", organization: "Example Org", url: "https://good.example.org", type: "grant" }]));
    if (!parsed.ok) throw new Error(parsed.error);
    const t = await seededDb();
    const plan = await planImport(parsed.rows, await loadExistingFromDb(t.db), { now: NOW, fileSha256: "x", format: "json", actor: ACTOR });
    const report = reportOf(plan, true);
    const text = formatReport(report);
    expect(text).toMatch(/^row 1: invalid$/m);
    expect(text).toMatch(/organization: Required/);
    expect(text).toMatch(/row 2: created draft sample-good/);
    expect(text).toMatch(/DRY RUN, nothing written\. 2 rows: 1 created as drafts/);
    expect(exitCodeOf(report)).toBe(1);
    expect(exitCodeOf(reportOf({ ...plan, outcomes: plan.outcomes.filter((o) => o.status === "created") }, true))).toBe(0);
  });
});
