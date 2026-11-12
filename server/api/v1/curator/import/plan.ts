import { CreateReviewTaskInputSchema, type Actor } from "../../../../../shared/contracts/ops";
import type { ReviewReasonCode } from "../../../../../shared/contracts/ops";
import type { HostPolicy, OpportunityTypeSlug } from "../../../../../shared/taxonomy";
import { uuidv7 } from "../../../../db/columns";
import type { RegistryAuditInput } from "../../../../db/repos/audit";
import type * as s from "../../../../db/schema";
import { resolveSeedPolicy, stricter } from "../../../../internal/host-policy";
import { IMPORT_SYSTEM, type ExistingRegistry } from "./existing";
import { candidateKey, hostKey, normalizeName, slugify, uniqueSlug, urlKey } from "./normalize";
import type { CandidateFormat, ParsedRow, RowIssue } from "./parse";
import type { Candidate } from "./schema";

/**
 * Plans an import without touching the database (plan 04 4.4, 4.9, 4.10). For each valid row it
 * decides one of:
 *
 * - `duplicate`: a Program with the same normalized name, Organization and official host exists.
 * - `already_imported`: an earlier import holds this row's id (or hash key). Re-running a file
 *   therefore creates nothing new.
 * - `duplicate_in_file`: an earlier row of this file has the same key.
 * - `rejected`: the official URL is on a host Novus never uses (host policy `never`).
 * - `created`: a draft Program (`is_published = 0`, no cycle, no verified fact) in its
 *   Organization (reused by normalized name, or created), a pending-approval Source with no check
 *   time (so nothing fetches it before a Curator approves), an ExternalRef, a registry_audit row,
 *   a `new_program` ReviewTask with the researcher's proposal, and a `possible_duplicate` task
 *   when the row is close to an existing Program (same name and Organization on another host, the
 *   same name on the same host, or the same official URL).
 *
 * Nothing is ever published here: publishing stays a Curator's decision in the console.
 */

/** Review SLA for new_program and possible_duplicate (plan 04 4.10 table: 7 days). */
export const REVIEW_SLA_MS = 7 * 24 * 60 * 60_000;
/** A proposed deadline this close moves the task up one priority step. */
export const NEAR_DEADLINE_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_PRIORITY = 5;
const NEAR_PRIORITY = 4;
const MAX_MATCHES = 3;

export type RowStatus = "created" | "duplicate" | "already_imported" | "duplicate_in_file" | "rejected" | "invalid" | "failed";

export type MatchReason = "same_name_and_organization" | "same_name_and_host" | "same_official_url";

export interface ProgramMatch {
  programId: string;
  slug: string;
  name: string;
  reasons: MatchReason[];
  /** True when the match is another row of this same import. */
  inThisImport: boolean;
}

export interface RowOutcome {
  row: number;
  status: RowStatus;
  name?: string;
  organization?: string;
  programId?: string;
  slug?: string;
  organizationId?: string;
  newOrganization?: boolean;
  taskIds?: string[];
  possibleDuplicates?: ProgramMatch[];
  errors?: RowIssue[];
  warnings?: string[];
}

type OrgRow = typeof s.organizations.$inferInsert;
type ProgramRow = typeof s.programs.$inferInsert;
type TypeRow = typeof s.programTypes.$inferInsert;
type HostRow = typeof s.sourceHosts.$inferInsert;
type SourceRow = typeof s.sources.$inferInsert;
type RefRow = typeof s.externalRefs.$inferInsert;
type TaskRow = typeof s.reviewTasks.$inferInsert;

export interface PlannedOrganization {
  row: OrgRow;
  audit: RegistryAuditInput;
}

/** Everything one created row writes; applied as one D1 batch. */
export interface PlannedUnit {
  row: number;
  program: ProgramRow;
  types: TypeRow[];
  host: HostRow | null;
  source: SourceRow | null;
  externalRef: RefRow;
  tasks: TaskRow[];
  audits: RegistryAuditInput[];
}

export interface ImportPlan {
  batchId: string;
  fileSha256: string;
  format: CandidateFormat;
  now: number;
  sample: boolean;
  organizations: PlannedOrganization[];
  units: PlannedUnit[];
  outcomes: RowOutcome[];
}

export interface PlanOptions {
  now: number;
  fileSha256: string;
  format: CandidateFormat;
  /** Who imports: a Curator handle (route) or `local-cli:import-candidates` (CLI). */
  actor: Actor;
  /** Mark every row `is_sample = 1` (invented data for development and tests). */
  sample?: boolean;
  /** Id generator; defaults to UUIDv7. Tests pass a counter. */
  newId?: (now: number) => string;
}

interface PoolEntry {
  id: string;
  slug: string;
  name: string;
  nName: string;
  nOrg: string;
  host: string;
  url: string | null;
  inThisImport: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

function hostOfUrl(url: string): string {
  return new URL(url).hostname;
}

function pdfPath(url: string): boolean {
  return new URL(url).pathname.toLowerCase().endsWith(".pdf");
}

function matchesFor(pool: readonly PoolEntry[], nName: string, nOrg: string, host: string, url: string | null): { exact: PoolEntry | null; near: ProgramMatch[] } {
  let exact: PoolEntry | null = null;
  const near: ProgramMatch[] = [];
  for (const p of pool) {
    const sameName = p.nName === nName;
    const sameOrg = p.nOrg === nOrg;
    const sameHost = p.host === host;
    if (sameName && sameOrg && sameHost) {
      exact ??= p;
      continue;
    }
    const reasons: MatchReason[] = [];
    if (sameName && sameOrg) reasons.push("same_name_and_organization");
    if (sameName && sameHost) reasons.push("same_name_and_host");
    if (url !== null && p.url === url) reasons.push("same_official_url");
    if (reasons.length) near.push({ programId: p.id, slug: p.slug, name: p.name, reasons, inThisImport: p.inThisImport });
  }
  return { exact, near: near.slice(0, MAX_MATCHES) };
}

/** The researcher's facts, carried to the Curator unverified. Never written to registry fields. */
function proposalOf(c: Candidate) {
  return {
    verified: false,
    organizationKind: c.organizationKind ?? null,
    organizationUrl: c.organizationUrl ?? null,
    organizationCountry: c.organizationCountry ?? null,
    applicationUrl: c.applicationUrl ?? null,
    recurrence: c.recurrence ?? null,
    term: c.term ?? null,
    deadlines: c.deadlines,
    eligibility: c.eligibility,
    evidence: c.evidence,
    sensitiveAudience: c.sensitiveAudience ?? null,
    identityAudience: c.identityAudience ?? null,
    tags: c.tags,
    notes: c.notes ?? null,
    researcher: c.researcher ?? null,
    checkedOn: c.checkedOn ?? null,
  };
}

function priorityOf(c: Candidate, now: number): number {
  const near = c.deadlines.some((d) => {
    if (!d.isoDate) return false;
    const at = Date.parse(`${d.isoDate}T23:59:59Z`);
    return at >= now && at - now <= NEAR_DEADLINE_MS;
  });
  return near ? NEAR_PRIORITY : DEFAULT_PRIORITY;
}

function task(kind: "new_program" | "possible_duplicate", programId: string, reasons: ReviewReasonCode[], priority: number, now: number, id: string, payload: Record<string, unknown>): TaskRow {
  // Same validation the repo applies (shared contract), so a bad kind or reason fails the plan.
  const input = CreateReviewTaskInputSchema.parse({ kind, subject: { type: "program", id: programId }, reasonCodes: reasons, priority, dueAt: iso(now + REVIEW_SLA_MS) });
  return {
    id,
    kind: input.kind,
    subjectType: input.subject.type,
    subjectId: input.subject.id,
    dedupeKey: `${input.kind}:${input.subject.type}:${input.subject.id}`,
    reasonCodes: [...input.reasonCodes],
    evidenceIds: [],
    priority: input.priority,
    state: "open",
    dueAt: now + REVIEW_SLA_MS,
    payload,
    createdAt: now,
    updatedAt: now,
  };
}

export async function planImport(rows: readonly ParsedRow[], existing: ExistingRegistry, opts: PlanOptions): Promise<ImportPlan> {
  const now = opts.now;
  const newId = opts.newId ?? uuidv7;
  const sample = opts.sample ?? false;
  const plan: ImportPlan = { batchId: newId(now), fileSha256: opts.fileSha256, format: opts.format, now, sample, organizations: [], units: [], outcomes: [] };

  const orgById = new Map(existing.organizations.map((o) => [o.id, o]));
  const orgByName = new Map<string, { id: string; slug: string; isNew: boolean }>();
  for (const o of existing.organizations) {
    const k = normalizeName(o.name);
    if (!orgByName.has(k)) orgByName.set(k, { id: o.id, slug: o.slug, isNew: false });
  }
  const orgSlugs = new Set(existing.organizations.map((o) => o.slug));
  const programSlugs = new Set([...existing.programs.map((p) => p.slug), ...existing.redirectSlugs]);
  const sourceUrls = new Set(existing.sources.map((x) => x.url));
  const knownHosts = new Set(existing.hostPolicies.keys());
  const seenKeys = new Map<string, number>();

  const pool: PoolEntry[] = existing.programs.map((p) => {
    const org = orgById.get(p.organizationId);
    let host = "";
    try {
      host = hostKey(hostOfUrl(p.officialUrl));
    } catch {
      host = "";
    }
    return { id: p.id, slug: p.slug, name: p.name, nName: normalizeName(p.name), nOrg: org ? normalizeName(org.name) : "", host, url: urlKey(p.officialUrl), inThisImport: false };
  });
  // A Source URL already linked to a program also counts as that program's URL.
  const programById = new Map(pool.map((p) => [p.id, p]));
  for (const src of existing.sources) {
    if (!src.programId) continue;
    const p = programById.get(src.programId);
    const k = urlKey(src.url);
    if (p && k && k !== p.url) pool.push({ ...p, url: k });
  }

  const importRef = (row: number, key: string) => ({ batchId: plan.batchId, fileSha256: opts.fileSha256, format: opts.format, row, key, importedBy: opts.actor.ref, importedAt: iso(now) });

  for (const parsed of rows) {
    if (!parsed.ok) {
      plan.outcomes.push({ row: parsed.row, status: "invalid", errors: parsed.errors, warnings: parsed.ignored.length ? [`Ignored columns: ${parsed.ignored.slice(0, 10).join(", ")}`] : undefined });
      continue;
    }
    const c = parsed.candidate;
    const warnings: string[] = [];
    if (parsed.ignored.length) warnings.push(`Ignored columns: ${parsed.ignored.slice(0, 10).join(", ")}`);
    const base: RowOutcome = { row: parsed.row, status: "invalid", name: c.name, organization: c.organization };

    const officialHost = hostOfUrl(c.officialUrl);
    const seed = resolveSeedPolicy(c.officialUrl);
    const stored = existing.hostPolicies.get(officialHost);
    const policy: HostPolicy = stored ? stricter(seed.policy, stored.policy) : seed.policy;
    if (policy === "never") {
      plan.outcomes.push({ ...base, status: "rejected", errors: [{ path: "officialUrl", message: "This host is on the never-use list; give the program's own official page" }], warnings });
      continue;
    }

    const nName = normalizeName(c.name);
    const nOrg = normalizeName(c.organization);
    const host = hostKey(officialHost);
    const key = c.externalId ?? (await candidateKey(c.organization, c.name, officialHost));

    if (existing.importedRefs.has(key)) {
      const pid = existing.importedRefs.get(key) ?? undefined;
      const earlier = pid ? programById.get(pid) : undefined;
      // A file id reused for another program (ids must be unique across files) is worth a look.
      if (c.externalId && earlier && earlier.nName !== nName) warnings.push(`The id was imported before for "${earlier.name}"; ids must be unique across files`);
      plan.outcomes.push({ ...base, status: "already_imported", programId: pid, slug: earlier?.slug, warnings: warnings.length ? warnings : undefined });
      continue;
    }
    const earlierRow = seenKeys.get(key);
    if (earlierRow !== undefined) {
      plan.outcomes.push({ ...base, status: "duplicate_in_file", warnings: [...warnings, `Same program as row ${earlierRow}`] });
      continue;
    }
    seenKeys.set(key, parsed.row);

    const ownUrl = urlKey(c.officialUrl);
    const { exact, near } = matchesFor(pool, nName, nOrg, host, ownUrl);
    if (exact) {
      plan.outcomes.push({
        ...base,
        status: exact.inThisImport ? "duplicate_in_file" : "duplicate",
        programId: exact.inThisImport ? undefined : exact.id,
        slug: exact.slug,
        warnings,
      });
      continue;
    }

    // ---- Organization -----------------------------------------------------------------------
    let org = orgByName.get(nOrg);
    if (!org) {
      const slug = uniqueSlug(slugify(c.organization), orgSlugs).slug;
      orgSlugs.add(slug);
      const id = newId(now);
      const row: OrgRow = {
        id,
        slug,
        name: c.organization,
        kind: c.organizationKind ?? "other",
        country: c.organizationCountry ?? "US",
        websiteUrl: c.organizationUrl ?? null,
        isSample: sample,
        createdAt: now,
        updatedAt: now,
      };
      plan.organizations.push({
        row,
        audit: { at: now, actor: opts.actor, entityType: "organization", entityId: id, field: "import.created", before: undefined, after: { slug, name: c.organization, kind: row.kind, batchId: plan.batchId } },
      });
      org = { id, slug, isNew: true };
      orgByName.set(nOrg, org);
      if (!c.organizationKind) warnings.push("New Organization kind set to `other`; a Curator should correct it");
    }

    // ---- Program --------------------------------------------------------------------------------
    const programId = newId(now);
    const { slug, collided } = uniqueSlug(slugify(c.name), programSlugs, org.slug);
    programSlugs.add(slug);
    const types = [...new Set(c.types)] as OpportunityTypeSlug[];
    const program: ProgramRow = {
      id: programId,
      slug,
      name: c.name,
      organizationId: org.id,
      summary: null,
      officialUrl: c.officialUrl,
      recurrence: c.recurrence ?? "annual",
      // Stricter by default: a flagged program refuses person-linked rows without consent.
      sensitiveAudience: c.sensitiveAudience === true,
      identityAudience: [...(c.identityAudience ?? [])],
      isWedge: false,
      isPublished: false,
      isSample: sample,
      createdAt: now,
      updatedAt: now,
    };

    // ---- Source (pending approval, never scheduled) ------------------------------------------------
    let hostRow: HostRow | null = null;
    let source: SourceRow | null = null;
    if (policy === "link_only") {
      warnings.push("Link-only host: no Source was created and the page is never fetched");
    } else if (sourceUrls.has(c.officialUrl)) {
      warnings.push("This URL is already a Source; it was left as it is");
    } else {
      if (!knownHosts.has(officialHost)) {
        hostRow = { host: officialHost, policy: seed.policy, policySource: seed.entry ? "seed" : "default", updatedAt: now };
        knownHosts.add(officialHost);
      }
      source = {
        id: newId(now),
        kind: pdfPath(c.officialUrl) ? "official_pdf" : "official_page",
        url: c.officialUrl,
        host: officialHost,
        programId,
        organizationId: org.id,
        approval: "pending_approval",
        nextCheckAt: null,
        createdAt: now,
        updatedAt: now,
      };
      sourceUrls.add(c.officialUrl);
    }

    const externalRef: RefRow = {
      id: newId(now),
      system: IMPORT_SYSTEM,
      externalId: key,
      rowKind: opts.format === "json" ? "json" : "hand",
      sourceId: source?.id ?? null,
      programId,
      createdAt: now,
      updatedAt: now,
    };

    // ---- Review tasks -----------------------------------------------------------------------------
    const priority = priorityOf(c, now);
    const ref = importRef(parsed.row, key);
    const reasons: ReviewReasonCode[] = ["list_row"];
    if (collided) reasons.push("slug_collision");
    const tasks: TaskRow[] = [task("new_program", programId, reasons, priority, now, newId(now), { import: ref, proposal: proposalOf(c), warnings })];
    if (near.length) tasks.push(task("possible_duplicate", programId, ["list_row"], priority, now, newId(now), { import: ref, matches: near }));

    plan.units.push({
      row: parsed.row,
      program,
      types: types.map((t, i) => ({ programId, typeSlug: t, isPrimary: i === 0 })),
      host: hostRow,
      source,
      externalRef,
      tasks,
      audits: [
        {
          at: now,
          actor: opts.actor,
          entityType: "program",
          entityId: programId,
          field: "import.created",
          before: undefined,
          after: { slug, name: c.name, officialUrl: c.officialUrl, organizationId: org.id, types, batchId: plan.batchId, row: parsed.row },
          taskId: tasks[0]!.id ?? null,
        },
      ],
    });
    pool.push({ id: programId, slug, name: c.name, nName, nOrg, host, url: ownUrl, inThisImport: true });
    plan.outcomes.push({
      ...base,
      status: "created",
      programId,
      slug,
      organizationId: org.id,
      newOrganization: org.isNew,
      taskIds: tasks.map((t) => t.id!),
      possibleDuplicates: near.length ? near : undefined,
      warnings: warnings.length ? warnings : undefined,
    });
  }
  plan.outcomes.sort((a, b) => a.row - b.row);
  return plan;
}

export interface ImportSummary {
  rows: number;
  created: number;
  duplicates: number;
  alreadyImported: number;
  invalid: number;
  rejected: number;
  failed: number;
  newOrganizations: number;
  reviewTasks: number;
  possibleDuplicates: number;
}

export function summarize(plan: Pick<ImportPlan, "outcomes" | "organizations">): ImportSummary {
  const count = (...st: RowStatus[]) => plan.outcomes.filter((o) => st.includes(o.status)).length;
  const created = plan.outcomes.filter((o) => o.status === "created");
  return {
    rows: plan.outcomes.length,
    created: created.length,
    duplicates: count("duplicate", "duplicate_in_file"),
    alreadyImported: count("already_imported"),
    invalid: count("invalid"),
    rejected: count("rejected"),
    failed: count("failed"),
    newOrganizations: new Set(created.filter((o) => o.newOrganization).map((o) => o.organizationId)).size,
    reviewTasks: created.reduce((n, o) => n + (o.taskIds?.length ?? 0), 0),
    possibleDuplicates: created.filter((o) => o.possibleDuplicates?.length).length,
  };
}
