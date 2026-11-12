import { PIPELINE_JOB_KINDS } from "@shared/contracts/ops";

/**
 * Internal API keys and their route scopes (architecture 2.3.14). Each pipeline function family
 * has its own key; the key's power is bounded here, not by where Modal stores it. Any key-route
 * pair outside this table answers 403 and logs an ops alert.
 *
 * Key ids may carry a rotation suffix (`fetch.2026q4`, `fetch:2`): the family before the first
 * `.` or `:` decides the scope, so a rotation adds a key without touching this table.
 */

export type PipelineJobKind = (typeof PIPELINE_JOB_KINDS)[number];

/** Every route the internal router serves, including the four plan-4.12 routes not yet in ROUTES. */
export const INTERNAL_ROUTE_IDS = [
  "ingestCurationPatch",
  "ingestSnapshot",
  "putSnapshotRaw",
  "getSnapshotRaw",
  "getSnapshot",
  "upsertSource",
  "leaseJobs",
  "completeJob",
  "failJob",
  "tickCatchUp",
  "ingestExtraction",
  "createReviewTask",
  "heartbeat",
  "llmCalls",
  "cyclesRollover",
] as const;
export type InternalRouteId = (typeof INTERNAL_ROUTE_IDS)[number];

export interface KeyScope {
  readonly routes: readonly InternalRouteId[];
  /** Pipeline kinds this key may lease, complete or fail. */
  readonly leaseKinds: readonly PipelineJobKind[];
  /** A flag that must be enabled in D1 for the key to work at all (break-glass). */
  readonly requiresFlag?: string;
}

const JOB_ROUTES = ["leaseJobs", "completeJob", "failJob", "heartbeat"] as const satisfies readonly InternalRouteId[];

export const KEY_SCOPES = {
  /** The Curator CLI import: patches plus the evidence Snapshots for the rows it imports. */
  curate_import: { routes: ["ingestCurationPatch", "ingestSnapshot", "putSnapshotRaw", "upsertSource"], leaseKinds: [] },
  /** s04's fetch, nsf_sync and list_sync. Never curation patches, never publish. */
  fetch: {
    routes: [...JOB_ROUTES, "ingestSnapshot", "putSnapshotRaw", "getSnapshotRaw", "getSnapshot", "upsertSource", "ingestExtraction", "createReviewTask"],
    leaseKinds: ["fetch", "nsf_sync", "list_sync"],
  },
  /** s07's predict_cycles. */
  guidance: { routes: [...JOB_ROUTES], leaseKinds: ["predict_cycles"] },
  /** Modal's drain cron: the catch-up watchdog only. */
  clock: { routes: ["tickCatchUp"], leaseKinds: [] },
  /** Laptop runbooks: fetch kinds and the watchdog only, and only while the flag is on. */
  breakglass: {
    routes: [...JOB_ROUTES, "ingestSnapshot", "putSnapshotRaw", "tickCatchUp"],
    leaseKinds: ["fetch", "nsf_sync", "list_sync"],
    requiresFlag: "breakglass.enabled",
  },
  rollover: { routes: [...JOB_ROUTES, "cyclesRollover"], leaseKinds: ["rollover"] },
  /** s08's LLM kinds: extractions and review tasks, never registry writes. */
  llm: {
    routes: [...JOB_ROUTES, "ingestExtraction", "createReviewTask", "llmCalls", "getSnapshot", "getSnapshotRaw"],
    leaseKinds: ["llm", "llm_collect", "eval_run"],
  },
  docintel: { routes: [...JOB_ROUTES], leaseKinds: ["docintel_ocr_hint", "docintel_eval"] },
  /** Judgment: mirror and backup copies lease through their own key so no data key covers them. */
  ops: { routes: [...JOB_ROUTES], leaseKinds: ["mirror_export", "backup_copy"] },
} as const satisfies Record<string, KeyScope>;

export type KeyFamily = keyof typeof KEY_SCOPES;

export function keyFamily(keyId: string): KeyFamily | null {
  const family = keyId.split(/[.:]/, 1)[0] ?? "";
  return Object.prototype.hasOwnProperty.call(KEY_SCOPES, family) ? (family as KeyFamily) : null;
}

export function scopeFor(keyId: string): KeyScope | null {
  const family = keyFamily(keyId);
  return family ? KEY_SCOPES[family] : null;
}

export function mayCall(keyId: string, route: InternalRouteId): boolean {
  return scopeFor(keyId)?.routes.includes(route) ?? false;
}

export function leasableKinds(keyId: string): readonly PipelineJobKind[] {
  return scopeFor(keyId)?.leaseKinds ?? [];
}

export function mayHandleKind(keyId: string, kind: string): boolean {
  return (leasableKinds(keyId) as readonly string[]).includes(kind);
}

/**
 * Parses INTERNAL_HMAC_KEYS (a JSON object of key id -> secret). Malformed JSON, unknown
 * families and short secrets are dropped, so a bad secret disables a key instead of the API.
 */
export function parseKeyring(raw: string | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [id, secret] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof secret !== "string" || secret.length < 32) continue;
    if (!keyFamily(id)) continue;
    out.set(id, secret);
  }
  return out;
}
