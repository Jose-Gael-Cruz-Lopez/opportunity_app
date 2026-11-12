import type { HostPolicy } from "../../../../../shared/taxonomy";

/**
 * What the planner needs to know about the registry: every Organization and Program (for
 * de-duplication and slugs), Source URLs, stored host policies and earlier imports. The registry
 * holds hundreds of programs, so loading it whole is cheap; the same SQL serves the Worker route
 * (through Drizzle) and the CLI (through `wrangler d1 execute --json`).
 */

/** ExternalRef system for researcher candidates; `external_id` is the row's id or its hash key. */
export const IMPORT_SYSTEM = "novus-research";

export interface ExistingRegistry {
  organizations: { id: string; slug: string; name: string }[];
  programs: { id: string; slug: string; name: string; organizationId: string; officialUrl: string }[];
  /** Slugs held by redirects; a new program never takes one. */
  redirectSlugs: string[];
  sources: { url: string; programId: string | null }[];
  hostPolicies: Map<string, { policy: HostPolicy; policySource: "seed" | "default" | "curator" }>;
  /** external_id -> program id, for refs of IMPORT_SYSTEM. */
  importedRefs: Map<string, string | null>;
}

/** Read-only queries with no parameters; column aliases are the field names above. */
export const EXISTING_QUERIES = {
  organizations: "SELECT id, slug, name FROM organizations",
  programs: "SELECT id, slug, name, organization_id AS organizationId, official_url AS officialUrl FROM programs",
  redirectSlugs: "SELECT from_slug AS slug FROM slug_redirects",
  sources: "SELECT url, program_id AS programId FROM sources",
  hostPolicies: "SELECT host, policy, policy_source AS policySource FROM source_hosts",
  importedRefs: `SELECT external_id AS externalId, program_id AS programId FROM external_refs WHERE system = '${IMPORT_SYSTEM}'`,
} as const;

export type ExistingQueryName = keyof typeof EXISTING_QUERIES;
export type RowsByQuery = Record<ExistingQueryName, readonly Record<string, unknown>[]>;

const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function existingFromRows(rows: RowsByQuery): ExistingRegistry {
  return {
    organizations: rows.organizations.map((r) => ({ id: str(r.id), slug: str(r.slug), name: str(r.name) })),
    programs: rows.programs.map((r) => ({ id: str(r.id), slug: str(r.slug), name: str(r.name), organizationId: str(r.organizationId), officialUrl: str(r.officialUrl) })),
    redirectSlugs: rows.redirectSlugs.map((r) => str(r.slug)),
    sources: rows.sources.map((r) => ({ url: str(r.url), programId: strOrNull(r.programId) })),
    hostPolicies: new Map(
      rows.hostPolicies.map((r) => [str(r.host), { policy: str(r.policy) as HostPolicy, policySource: str(r.policySource) as "seed" | "default" | "curator" }]),
    ),
    importedRefs: new Map(rows.importedRefs.map((r) => [str(r.externalId), strOrNull(r.programId)])),
  };
}

/** Runs every query with `run` (Drizzle `db.all`, or wrangler) and builds the view. */
export async function loadExisting(run: (sql: string) => Promise<readonly Record<string, unknown>[]>): Promise<ExistingRegistry> {
  const names = Object.keys(EXISTING_QUERIES) as ExistingQueryName[];
  const results = await Promise.all(names.map((n) => run(EXISTING_QUERIES[n])));
  return existingFromRows(Object.fromEntries(names.map((n, i) => [n, results[i]!])) as RowsByQuery);
}
