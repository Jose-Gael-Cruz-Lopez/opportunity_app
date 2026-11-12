import { describe, expect, it } from "vitest";
import { CsvError, parseCsv } from "./csv";
import { existingFromRows, IMPORT_SYSTEM, type ExistingRegistry } from "./existing";
import { canonicalUrl, candidateKey, cleanText, hostKey, normalizeName, slugify, uniqueSlug, urlKey } from "./normalize";
import { detectFormat, parseCandidateFile, type ParsedRow } from "./parse";
import { NEAR_DEADLINE_MS, planImport, REVIEW_SLA_MS, summarize } from "./plan";
import { camelKey, normalizeKeys, OpportunityTypeRefSchema, RESEARCHER_TYPE_WORDS } from "./schema";

// SAMPLE DATA ONLY: every program, organization and URL below is invented (example.org/.edu
// hosts) and describes no real program.

const NOW = Date.parse("2026-11-11T15:00:00Z");
const ACTOR = { kind: "curator" as const, ref: "Sample Curator Ana" };

function counter() {
  let n = 0;
  return () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`;
}

function rowsOf(text: string, hint?: string): ParsedRow[] {
  const r = parseCandidateFile(text, { hint });
  if (!r.ok) throw new Error(r.error);
  return r.rows;
}

const EMPTY: ExistingRegistry = existingFromRows({ organizations: [], programs: [], redirectSlugs: [], sources: [], hostPolicies: [], importedRefs: [] });

function registry(): ExistingRegistry {
  return existingFromRows({
    organizations: [
      { id: "org-1", slug: "example-science-foundation", name: "Example Science Foundation" },
      { id: "org-2", slug: "example-state-university", name: "Example State University" },
    ],
    programs: [
      { id: "p-1", slug: "sample-summer-research", name: "Sample Summer Research Program", organizationId: "org-1", officialUrl: "https://research.example.org/summer" },
      { id: "p-2", slug: "sample-reu-chemistry", name: "Sample REU Site in Chemistry", organizationId: "org-2", officialUrl: "https://chem.example.edu/reu" },
    ],
    redirectSlugs: [{ slug: "sample-old-name" }],
    sources: [{ url: "https://chem.example.edu/reu", programId: "p-2" }],
    hostPolicies: [{ host: "strict.example.org", policy: "never", policySource: "curator" }],
    importedRefs: [{ externalId: "sheet-7", programId: "p-1" }],
  });
}

const base = {
  name: "Sample Coastal Ecology Fellowship",
  organization: "Example Ocean Institute",
  officialUrl: "https://ocean.example.org/fellowship?utm_source=list#apply",
  types: ["undergraduate_fellowship"],
};

describe("normalize", () => {
  it("compares names without case, accents, punctuation or a leading 'the'", () => {
    expect(normalizeName("The Example Foundation, Inc.")).toBe(normalizeName("example foundation inc"));
    expect(normalizeName("Caf\u00e9 & Bakery Program")).toBe("cafe and bakery program");
    expect(normalizeName("REU Site Chemistry")).not.toBe(normalizeName("REU Site Chemistry and Biochemistry"));
  });

  it("canonicalizes URLs and refuses non-public or credentialed ones", () => {
    const c = canonicalUrl("HTTPS://WWW.Example.org:443/path/?utm_source=x&id=3#frag");
    expect(c).toEqual({ ok: true, url: "https://www.example.org/path/?id=3", host: "www.example.org" });
    expect(canonicalUrl("https://example.org/?utm_medium=a")).toEqual({ ok: true, url: "https://example.org/", host: "example.org" });
    expect(canonicalUrl("ftp://example.org/x")).toEqual({ ok: false, problem: "scheme" });
    expect(canonicalUrl("https://user:pw@example.org/")).toEqual({ ok: false, problem: "credentials" });
    expect(canonicalUrl("http://127.0.0.1/admin")).toEqual({ ok: false, problem: "private_host" });
    expect(canonicalUrl("http://localhost:8787/")).toEqual({ ok: false, problem: "private_host" });
    expect(canonicalUrl("http://intranet/")).toEqual({ ok: false, problem: "private_host" });
    expect(canonicalUrl("not a url")).toEqual({ ok: false, problem: "invalid_url" });
  });

  it("matches hosts and URLs without www, scheme or a trailing slash", () => {
    expect(hostKey("WWW.example.org")).toBe("example.org");
    expect(urlKey("http://www.example.org/a/")).toBe(urlKey("https://example.org/a"));
    expect(urlKey("https://example.org/a")).not.toBe(urlKey("https://example.org/b"));
  });

  it("removes control and bidi characters from text", () => {
    expect(cleanText("  a\u0000b\u202ec\r\nd\u200b ")).toBe("abc\nd");
  });

  it("makes slugs and avoids taken ones", () => {
    expect(slugify("Sample REU Site: Chemistry & Biology!")).toBe("sample-reu-site-chemistry-and-biology");
    expect(slugify("!!!")).toBe("program");
    expect(slugify("x".repeat(200)).length).toBe(80);
    expect(uniqueSlug("a", new Set())).toEqual({ slug: "a", collided: false });
    expect(uniqueSlug("a", new Set(["a"]), "org")).toEqual({ slug: "a-org", collided: true });
    expect(uniqueSlug("a", new Set(["a", "a-org", "a-2"]), "org")).toEqual({ slug: "a-3", collided: true });
  });

  it("derives a stable 16-hex candidate key from the normalized parts", async () => {
    const k = await candidateKey("Example Org", "Sample Program", "www.example.org");
    expect(k).toMatch(/^[0-9a-f]{16}$/);
    expect(await candidateKey("example org.", "SAMPLE program", "example.org")).toBe(k);
  });
});

describe("csv", () => {
  it("reads quoted fields, doubled quotes, embedded newlines, CRLF and a BOM", () => {
    const t = parseCsv('\ufeffname,notes\r\n"Sample, One","said ""hi""\nthen left"\r\n\r\nSample Two,plain\n');
    expect(t.header).toEqual(["name", "notes"]);
    expect(t.rows).toEqual([
      { line: 2, cells: ["Sample, One", 'said "hi"\nthen left'] },
      { line: 5, cells: ["Sample Two", "plain"] },
    ]);
  });

  it("detects semicolon and tab delimiters", () => {
    expect(parseCsv("a;b\n1;2").rows[0]!.cells).toEqual(["1", "2"]);
    expect(parseCsv("a\tb\n1\t2").rows[0]!.cells).toEqual(["1", "2"]);
  });

  it("reports an unterminated quote with its line", () => {
    expect(() => parseCsv('a\n"open\nstill open')).toThrow(CsvError);
  });
});

describe("candidate schema", () => {
  it("normalizes column names and aliases", () => {
    expect(camelKey("Official URL")).toBe("officialUrl");
    expect(camelKey("official_url")).toBe("officialUrl");
    const { record, ignored } = normalizeKeys({ "Program Name": "A", org: "B", url: "https://x.example.org", Mystery: "?", blank: "  " });
    expect(record).toEqual({ name: "A", organization: "B", officialUrl: "https://x.example.org" });
    expect(ignored).toEqual(["Mystery"]);
  });

  it("reads researchers' broad one-word types as the closest taxonomy slug", () => {
    expect(OpportunityTypeRefSchema.parse("research")).toBe("research_program");
    expect(OpportunityTypeRefSchema.parse("insight_week")).toBe("early_career_exposure");
    expect(OpportunityTypeRefSchema.parse("Insight week")).toBe("early_career_exposure");
    expect(OpportunityTypeRefSchema.parse("Scholarship")).toBe("private_scholarship");
    // Exact slugs and labels still win over a broad word.
    expect(OpportunityTypeRefSchema.parse("apprenticeship")).toBe("apprenticeship");
    expect(OpportunityTypeRefSchema.parse("national_scholarship")).toBe("national_scholarship");
    for (const word of Object.keys(RESEARCHER_TYPE_WORDS)) expect(OpportunityTypeRefSchema.safeParse(word).success, word).toBe(true);
    expect(OpportunityTypeRefSchema.safeParse("gig").success).toBe(false);
  });

  it("parses a JSON array with aliases, nested deadlines and quotes", () => {
    const [row] = rowsOf(
      JSON.stringify([
        {
          program_name: "Sample Coastal Ecology Fellowship",
          org: { name: "Example Ocean Institute", type: "nonprofit", country: "us" },
          url: "https://ocean.example.org/fellowship",
          type: "Undergraduate summer fellowships; research_program",
          deadline: { due_date: "2027-01-15", type: "application", tz: "America/New_York", quote: "Apply by January 15, 2027." },
          quotes: [{ field: "deadline", source: "https://ocean.example.org/fellowship", text: "Apply by January 15, 2027." }],
          eligibility: "First- and second-year undergraduates | U.S. institutions",
          sensitive_audience: "no",
          researcher: "Sample Researcher 1",
          checked_at: "2026-11-10T12:00:00Z",
          id: 42,
        },
      ]),
    );
    expect(row!.ok).toBe(true);
    if (!row!.ok) return;
    const c = row!.candidate;
    expect(c.types).toEqual(["undergraduate_fellowship", "research_program"]);
    expect(c.organization).toBe("Example Ocean Institute");
    expect(c.organizationKind).toBe("nonprofit");
    expect(c.organizationCountry).toBe("US");
    expect(c.deadlines).toEqual([{ kind: "application", date: "2027-01-15", isoDate: "2027-01-15", timeZone: "America/New_York", quote: "Apply by January 15, 2027." }]);
    expect(c.evidence[0]).toMatchObject({ field: "deadline", url: "https://ocean.example.org/fellowship", quote: "Apply by January 15, 2027." });
    expect(c.eligibility).toEqual(["First- and second-year undergraduates", "U.S. institutions"]);
    expect(c.sensitiveAudience).toBe(false);
    expect(c.checkedOn).toBe("2026-11-10");
    expect(c.externalId).toBe("42");
  });

  it("applies file-level defaults from a wrapper object", () => {
    const rows = rowsOf(JSON.stringify({ researcher: "Sample Researcher 2", checked_on: "2026-11-09", candidates: [base] }));
    expect(rows[0]!.ok && rows[0]!.candidate.researcher).toBe("Sample Researcher 2");
    expect(rows[0]!.ok && rows[0]!.candidate.checkedOn).toBe("2026-11-09");
  });

  it("parses CSV with flat deadline and quote columns", () => {
    const csv = [
      "Program,Organization,Official URL,Types,Deadline,Deadline Kind,Deadline Quote,Quote,Quote Field,Tags",
      'Sample Data Science Sprint,Example Analytics Co,https://analytics.example.org/sprint,sprinternship,"March 1, 2027",application,"Applications close March 1, 2027.","A paid three-week sprint.",compensation,data;paid',
    ].join("\n");
    const [row] = rowsOf(csv, "candidates.csv");
    expect(row!.row).toBe(2);
    expect(row!.ok).toBe(true);
    if (!row!.ok) return;
    expect(row!.candidate.deadlines).toEqual([{ kind: "application", date: "March 1, 2027", isoDate: null, quote: "Applications close March 1, 2027." }]);
    expect(row!.candidate.evidence).toEqual([{ field: "compensation", url: "https://analytics.example.org/sprint", quote: "A paid three-week sprint." }]);
    expect(row!.candidate.tags).toEqual(["data", "paid"]);
  });

  it("reports each bad row by path with fixed messages and never echoes the value", () => {
    const secret = "javascript:alert('SECRET-VALUE')";
    const rows = rowsOf(
      JSON.stringify([
        { ...base, officialUrl: secret },
        { name: "Sample Missing Fields" },
        { ...base, types: ["not_a_type"] },
        { ...base, researcher: "someone@example.org" },
        { ...base, types: ["gap_year"] },
        "just text",
        base,
      ]),
    );
    expect(rows.map((r) => r.ok)).toEqual([false, false, false, false, false, false, true]);
    const errs = rows.flatMap((r) => (r.ok ? [] : r.errors));
    expect(JSON.stringify(errs)).not.toContain("SECRET-VALUE");
    expect(JSON.stringify(errs)).not.toContain("someone@");
    const first = rows[0]!;
    expect(!first.ok && first.errors).toEqual([{ path: "officialUrl", message: "Must start with http:// or https://" }]);
    const second = rows[1]!;
    expect(!second.ok && second.errors.map((e) => e.path).sort()).toEqual(["officialUrl", "organization", "types"]);
    expect(!rows[2]!.ok && rows[2]!.errors[0]!.message).toMatch(/Unknown opportunity type/);
    expect(!rows[4]!.ok && rows[4]!.errors[0]!.message).toMatch(/out of scope/);
  });

  it("refuses broken files with one clear error", () => {
    expect(parseCandidateFile("{not json", { hint: "a.json" })).toMatchObject({ ok: false, error: "The file is not valid JSON." });
    expect(parseCandidateFile("{}", { hint: "a.json" })).toMatchObject({ ok: false });
    expect(parseCandidateFile("[]")).toMatchObject({ ok: false, error: "The file has no candidates." });
    expect(parseCandidateFile("name,organization\n")).toMatchObject({ ok: false, error: "The file has a header but no candidates." });
    expect(parseCandidateFile(JSON.stringify([base, base, base]), { maxRows: 2 })).toMatchObject({ ok: false });
    expect(parseCandidateFile('name\n"open')).toMatchObject({ ok: false, format: "csv" });
  });

  it("detects the format from the name, the type or the content", () => {
    expect(detectFormat("x", "file.JSON")).toBe("json");
    expect(detectFormat("x", "text/csv")).toBe("csv");
    expect(detectFormat("  [1]")).toBe("json");
    expect(detectFormat("name,org")).toBe("csv");
  });
});

describe("planImport", () => {
  const opts = (extra: Partial<Parameters<typeof planImport>[2]> = {}) => ({ now: NOW, fileSha256: "f".repeat(64), format: "json" as const, actor: ACTOR, newId: counter(), ...extra });

  it("creates an unpublished draft with an Organization, a pending Source, a ref, a task and an audit row", async () => {
    const plan = await planImport(rowsOf(JSON.stringify([{ ...base, organization_kind: "nonprofit", deadline: "2027-02-01" }])), EMPTY, opts());
    expect(summarize(plan)).toMatchObject({ rows: 1, created: 1, newOrganizations: 1, reviewTasks: 1, possibleDuplicates: 0 });
    const [unit] = plan.units;
    expect(plan.organizations[0]!.row).toMatchObject({ slug: "example-ocean-institute", kind: "nonprofit", country: "US", isSample: false });
    expect(unit!.program).toMatchObject({
      slug: "sample-coastal-ecology-fellowship",
      officialUrl: "https://ocean.example.org/fellowship",
      isPublished: false,
      isSample: false,
      summary: null,
      recurrence: "annual",
      sensitiveAudience: false,
    });
    expect(unit!.types).toEqual([{ programId: unit!.program.id, typeSlug: "undergraduate_fellowship", isPrimary: true }]);
    expect(unit!.source).toMatchObject({ kind: "official_page", approval: "pending_approval", nextCheckAt: null, host: "ocean.example.org" });
    expect(unit!.host).toMatchObject({ host: "ocean.example.org", policy: "allowed", policySource: "default" });
    expect(unit!.externalRef).toMatchObject({ system: IMPORT_SYSTEM, rowKind: "json", programId: unit!.program.id, sourceId: unit!.source!.id });
    expect(unit!.externalRef.externalId).toMatch(/^[0-9a-f]{16}$/);
    const t = unit!.tasks[0]!;
    expect(t).toMatchObject({ kind: "new_program", subjectType: "program", subjectId: unit!.program.id, reasonCodes: ["list_row"], state: "open", priority: 5, dueAt: NOW + REVIEW_SLA_MS });
    expect(t.payload).toMatchObject({ import: { row: 1, importedBy: "Sample Curator Ana", batchId: plan.batchId }, proposal: { verified: false, deadlines: [{ date: "2027-02-01" }] } });
    expect(unit!.audits[0]).toMatchObject({ entityType: "program", field: "import.created", actor: ACTOR });
  });

  it("raises priority when a proposed deadline is within 30 days", async () => {
    const soon = new Date(NOW + NEAR_DEADLINE_MS - 86_400_000).toISOString().slice(0, 10);
    const past = new Date(NOW - 3 * 86_400_000).toISOString().slice(0, 10);
    const plan = await planImport(rowsOf(JSON.stringify([{ ...base, deadline: soon }, { ...base, name: "Sample Other", deadline: past }])), EMPTY, opts());
    expect(plan.units.map((u) => u.tasks[0]!.priority)).toEqual([4, 5]);
  });

  it("skips exact duplicates, earlier imports and repeated rows, and reuses Organizations", async () => {
    const rows = rowsOf(
      JSON.stringify([
        // Same normalized name, Organization and host as p-1 (www and case differ).
        { name: "the sample summer research program", organization: "Example Science Foundation.", officialUrl: "https://WWW.research.example.org/other-page", types: ["research_program"] },
        { ...base, id: "sheet-7" },
        { ...base, name: "Sample New Program", organization: "example state university", officialUrl: "https://newprog.example.edu/" },
        { ...base, name: "Sample New Program", organization: "Example State University", officialUrl: "https://newprog.example.edu/" },
      ]),
    );
    const plan = await planImport(rows, registry(), opts());
    expect(plan.outcomes.map((o) => o.status)).toEqual(["duplicate", "already_imported", "created", "duplicate_in_file"]);
    expect(plan.outcomes[0]).toMatchObject({ programId: "p-1", slug: "sample-summer-research" });
    expect(plan.outcomes[1]).toMatchObject({ programId: "p-1" });
    expect(plan.outcomes[1]!.warnings?.[0]).toMatch(/imported before for "Sample Summer Research Program"/);
    expect(plan.outcomes[2]).toMatchObject({ organizationId: "org-2", newOrganization: false });
    expect(plan.organizations).toEqual([]);
  });

  it("imports near matches as drafts with a possible_duplicate task", async () => {
    const rows = rowsOf(
      JSON.stringify([
        // Same name and Organization as p-1, on another host.
        { name: "Sample Summer Research Program", organization: "Example Science Foundation", officialUrl: "https://apply.example.net/srp", types: ["research_program"] },
        // Same official URL as p-2's Source, different name.
        { name: "Sample Chemistry Summer Site", organization: "Example State University", officialUrl: "https://chem.example.edu/reu/", types: ["research_program"] },
        // A sibling REU site at the same host and Organization: not a duplicate.
        { name: "Sample REU Site in Physics", organization: "Example State University", officialUrl: "https://chem.example.edu/physics-reu", types: ["research_program"] },
      ]),
    );
    const plan = await planImport(rows, registry(), opts());
    expect(plan.outcomes.map((o) => o.status)).toEqual(["created", "created", "created"]);
    expect(plan.outcomes[0]!.possibleDuplicates).toEqual([{ programId: "p-1", slug: "sample-summer-research", name: "Sample Summer Research Program", reasons: ["same_name_and_organization"], inThisImport: false }]);
    expect(plan.outcomes[1]!.possibleDuplicates?.[0]).toMatchObject({ programId: "p-2", reasons: ["same_official_url"] });
    expect(plan.outcomes[2]!.possibleDuplicates).toBeUndefined();
    const dupTask = plan.units[0]!.tasks[1]!;
    expect(dupTask).toMatchObject({ kind: "possible_duplicate", subjectId: plan.units[0]!.program.id, dedupeKey: `possible_duplicate:program:${plan.units[0]!.program.id}` });
    expect(dupTask.payload).toMatchObject({ matches: [{ programId: "p-1" }] });
    expect(summarize(plan).possibleDuplicates).toBe(2);
    expect(summarize(plan).reviewTasks).toBe(5);
  });

  it("flags near matches inside one file", async () => {
    const rows = rowsOf(
      JSON.stringify([
        { ...base, name: "Sample Twin Program" },
        { ...base, name: "Sample Twin Program", officialUrl: "https://mirror.example.net/twin" },
      ]),
    );
    const plan = await planImport(rows, EMPTY, opts());
    expect(plan.outcomes[1]!.possibleDuplicates?.[0]).toMatchObject({ programId: plan.units[0]!.program.id, inThisImport: true });
  });

  it("rejects never hosts, skips Sources on link-only hosts, and keeps stored policies", async () => {
    const rows = rowsOf(
      JSON.stringify([
        { ...base, name: "Sample A", officialUrl: "https://www.linkedin.com/company/example" },
        { ...base, name: "Sample B", officialUrl: "https://strict.example.org/page" },
        { ...base, name: "Sample C", officialUrl: "https://forms.gle/sample" },
        { ...base, name: "Sample D", officialUrl: "https://example.smapply.io/prog/sample" },
        { ...base, name: "Sample E", officialUrl: "https://files.example.org/guide.PDF" },
      ]),
    );
    const plan = await planImport(rows, registry(), opts());
    expect(plan.outcomes.map((o) => o.status)).toEqual(["rejected", "rejected", "created", "created", "created"]);
    expect(plan.outcomes[0]!.errors?.[0]?.path).toBe("officialUrl");
    const [c, d, e] = plan.units;
    expect(c!.source).toBeNull();
    expect(plan.outcomes[2]!.warnings?.join(" ")).toMatch(/Link-only/);
    expect(d!.source?.approval).toBe("pending_approval");
    expect(d!.host).toMatchObject({ policy: "manual_only", policySource: "seed" });
    expect(e!.source?.kind).toBe("official_pdf");
  });

  it("never takes a used or redirected slug, and records the collision", async () => {
    const rows = rowsOf(
      JSON.stringify([
        { ...base, name: "Sample Summer Research", organization: "Example New Org" },
        { ...base, name: "Sample Old Name", officialUrl: "https://old.example.org/" },
      ]),
    );
    const plan = await planImport(rows, registry(), opts());
    expect(plan.units[0]!.program.slug).toBe("sample-summer-research-example-new-org");
    expect(plan.units[0]!.tasks[0]!.reasonCodes).toEqual(["list_row", "slug_collision"]);
    expect(plan.units[1]!.program.slug).not.toBe("sample-old-name");
  });

  it("marks rows as sample only when asked, and stores the audience flags", async () => {
    const plan = await planImport(rowsOf(JSON.stringify([{ ...base, sensitive_audience: "yes", identity_audience: "race_ethnicity;parenting" }])), EMPTY, opts({ sample: true }));
    expect(plan.units[0]!.program).toMatchObject({ isSample: true, sensitiveAudience: true, identityAudience: ["race_ethnicity", "parenting"] });
    expect(plan.organizations[0]!.row.isSample).toBe(true);
  });

  it("reports invalid rows and ignored columns", async () => {
    const plan = await planImport(rowsOf(JSON.stringify([{ name: "x" }, { ...base, color: "blue" }])), EMPTY, opts());
    expect(plan.outcomes[0]).toMatchObject({ row: 1, status: "invalid" });
    expect(plan.outcomes[1]).toMatchObject({ row: 2, status: "created" });
    expect(plan.outcomes[1]!.warnings).toContain("Ignored columns: color");
  });
});
