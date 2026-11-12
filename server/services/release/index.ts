import { ProgramDetailSchema, ReleaseArtifactSchema, type ProgramCard, type ReleaseArtifact, type ReleasePointer } from "@shared/contracts/registry";
import { PRODUCT } from "@shared/config/product";
import { buildEvalContext } from "@shared/eligibility/context";
import { buildIndex, generateKnownItemQueries, retrievalGate, runRetrievalEval } from "@shared/matching";
import { toIsoInstant } from "@shared/time";
// Pure and synchronous, no file or network access; also run by infra/scripts/release-gates.ts.
import { runBoundaryGate, type BoundaryTarget } from "../../../infra/eligibility/boundary";
import type { Db } from "@server/db/client";
import { registry } from "@server/db/repos";
import { createD1RegistryStore } from "@server/api/v1/registry/store";
import type { CitationOptions, RegistryStore } from "@server/api/v1/registry/ports";
import { REGISTRY_CITATION } from "@server/api/v1/registry/routes";
import { sha256Hex } from "@server/lib/crypto";

/**
 * release.build: turns the published registry in D1 into an immutable RegistryRelease in R2.
 *
 *   releases/{n}/programs/{slug}.json   ProgramDetail per published program (MCP get_program, pages)
 *   releases/{n}/client-core.json       ReleaseArtifact (browser index, MCP search)
 *   releases/current.json               ReleasePointer; `path` is the client-core R2 key
 *
 * The build is resumable: program details already written for release n are skipped, so a build
 * that runs out of budget continues on the next invocation. Gates run before the pointer moves;
 * a failed gate marks the release failed and keeps the previous release live.
 *
 * Gates run here: contract validation of every file (stands in for the compile gate), the
 * client-core size budget, the retrieval eval on generated known-item queries, and the generated
 * eligibility boundary profiles over every rule set the release ships (lint, stored hash, no
 * RULE_ERROR, contract, monotone, order-independent). The hand-labelled golden cases test the
 * engine rather than the data, so they run in CI in every runtime (node, workerd, python:
 * infra/scripts/release-gates.ts), not in each build.
 */

export const RELEASE_KEYS = {
  pointer: "releases/current.json",
  clientCore: (n: number) => `releases/${n}/client-core.json`,
  detail: (n: number, slug: string) => `releases/${n}/programs/${slug}.json`,
} as const;

/** Slug merges older than this drop out of `merged` (13 months, same window as the live fallback). */
const MERGED_WINDOW_MS = 395 * 86_400_000;

/**
 * The size budget is set for brotli; Workers' CompressionStream has no brotli, so gzip is measured.
 * gzip is larger than brotli on JSON, so passing on gzip is conservative.
 */
export const CLIENT_CORE_BUDGET_BYTES = PRODUCT.budgets.clientCoreBrotliKB * 1024;

/** Rough D1 calls per program detail read (detail, deadlines, requirements, odds, history). */
const CALLS_PER_DETAIL = 8;

/** The R2 surface the build needs (a structural subset of R2Bucket, so tests pass a Map). */
export interface ReleaseStoreBucket {
  head(key: string): Promise<unknown | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
}

export interface ReleaseBudget {
  allows(calls?: number): boolean;
  spend(calls?: number): void;
}

export type ReleaseLog = (level: "info" | "warn" | "error" | "alert", event: string, fields?: Record<string, string | number | boolean | null>) => void;

export interface BuildDeps {
  readonly db: Db;
  readonly bucket: ReleaseStoreBucket;
  readonly now: () => number;
  /** Public origin for citations (APP_ORIGIN). */
  readonly origin: string;
  readonly budget: ReleaseBudget;
  readonly log: ReleaseLog;
  /** Seam for tests; defaults to the D1 registry store. */
  readonly store?: RegistryStore;
}

export type BuildOutcome =
  | { readonly status: "published"; readonly release: number; readonly programs: number; readonly gzipBytes: number }
  | { readonly status: "superseded"; readonly release: number }
  | { readonly status: "partial"; readonly release: number; readonly written: number; readonly remaining: number }
  | { readonly status: "failed"; readonly release: number; readonly reasons: readonly string[] };

const JSON_TYPE = "application/json; charset=utf-8";

export async function gzipSize(text: string): Promise<number> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

/** At most this many boundary failures are reported; the count of the rest is appended. */
const MAX_BOUNDARY_REASONS = 20;

/** One boundary target per card with a rule set, in the context the browser and MCP use. */
export function boundaryTargets(cards: readonly ProgramCard[]): BoundaryTarget[] {
  return cards
    .filter((c): c is ProgramCard & { rules: NonNullable<ProgramCard["rules"]> } => c.rules !== null)
    .map((c) => ({
      ruleSet: c.rules,
      context: buildEvalContext({ deadlines: c.deadlines.map((d) => ({ ...d, institutionId: null })) }),
      label: `${c.slug} ${c.cycleKey}`,
    }));
}

/** The eligibility boundary gate over every shipped rule set, evaluated as of the release date. */
export function eligibilityBoundaryReasons(cards: readonly ProgramCard[], asOf: string): string[] {
  const report = runBoundaryGate(boundaryTargets(cards), asOf);
  const head = report.failures.slice(0, MAX_BOUNDARY_REASONS).map((f) => `eligibility boundary profiles: ${f}`);
  if (report.failures.length > MAX_BOUNDARY_REASONS) head.push(`eligibility boundary profiles: and ${report.failures.length - MAX_BOUNDARY_REASONS} more`);
  return head;
}

/** Runs the gates that do not need D1. Returns the reasons a release must not be published. */
export async function releaseGates(artifact: ReleaseArtifact, body: string): Promise<{ reasons: string[]; gzipBytes: number }> {
  const reasons: string[] = [];
  const parsed = ReleaseArtifactSchema.safeParse(artifact);
  if (!parsed.success) reasons.push(`client-core fails its contract: ${parsed.error.issues[0]?.path.join(".") ?? "?"}`);
  const gzipBytes = await gzipSize(body);
  if (gzipBytes > CLIENT_CORE_BUDGET_BYTES) reasons.push(`client-core is ${gzipBytes} bytes gzipped, above the ${CLIENT_CORE_BUDGET_BYTES}-byte budget`);
  if (artifact.cards.length > 0) {
    const gate = retrievalGate(runRetrievalEval(buildIndex(artifact), generateKnownItemQueries(artifact.cards)));
    reasons.push(...gate.reasons);
  }
  reasons.push(...eligibilityBoundaryReasons(artifact.cards, artifact.generatedAt.slice(0, 10)));
  return { reasons, gzipBytes };
}

/**
 * Builds and publishes release n. Each call does as much as the budget allows; details are
 * written first (idempotent), then client-core, then the pointer, then the D1 state.
 */
export async function buildRelease(deps: BuildDeps, n: number): Promise<BuildOutcome> {
  const { db, bucket, budget, log } = deps;
  const latest = await registry.latestPublishedRelease(db);
  budget.spend();
  if (latest && latest.number > n) {
    // A later release already moved the pointer; this one would roll it back.
    await registry.markReleaseFailed(db, n);
    return { status: "superseded", release: n };
  }

  const now = deps.now();
  const store = deps.store ?? createD1RegistryStore(db);
  const cards: ProgramCard[] = await store.listCards(now);
  const merged = await store.mergedSlugs(now - MERGED_WINDOW_MS);
  budget.spend(4);

  const citation: CitationOptions = { origin: deps.origin, ...REGISTRY_CITATION };
  const slugs = [...new Set(cards.map((c) => c.slug))].sort();
  let written = 0;
  for (const slug of slugs) {
    const key = RELEASE_KEYS.detail(n, slug);
    if (await bucket.head(key)) continue;
    if (!budget.allows(CALLS_PER_DETAIL)) {
      return { status: "partial", release: n, written, remaining: slugs.length - written };
    }
    const detail = await store.programDetail(slug, now, citation);
    budget.spend(CALLS_PER_DETAIL);
    if (!detail) continue; // unpublished between the card read and now; the card set still lists it
    const ok = ProgramDetailSchema.safeParse(detail);
    if (!ok.success) {
      const reasons = [`detail for ${slug} fails its contract at ${ok.error.issues[0]?.path.join(".") ?? "?"}`];
      await failRelease(deps, n, reasons);
      return { status: "failed", release: n, reasons };
    }
    await bucket.put(key, JSON.stringify(ok.data), { httpMetadata: { contentType: JSON_TYPE } });
    written++;
  }

  const artifact: ReleaseArtifact = {
    v: 1,
    release: n,
    generatedAt: toIsoInstant(now),
    cards,
    merged,
    containsSample: cards.some((c) => c.isSample),
  };
  const body = JSON.stringify(artifact);
  const { reasons, gzipBytes } = await releaseGates(artifact, body);
  if (reasons.length > 0) {
    await failRelease(deps, n, reasons);
    return { status: "failed", release: n, reasons };
  }

  const clientCoreKey = RELEASE_KEYS.clientCore(n);
  const sha256 = await sha256Hex(body);
  await bucket.put(clientCoreKey, body, { httpMetadata: { contentType: JSON_TYPE } });
  await registry.markReleaseBuilt(db, n, { clientCoreKey, sizeBytes: body.length, sha256, containsSample: artifact.containsSample }, now);
  budget.spend();

  const pointer: ReleasePointer = { release: n, path: clientCoreKey, sha256, publishedAt: toIsoInstant(now) };
  // Pointer before the D1 state: if the write below fails, the next run sees `built` and repeats
  // both, which is harmless; the reverse order could mark a release published that nobody serves.
  await bucket.put(RELEASE_KEYS.pointer, JSON.stringify(pointer), { httpMetadata: { contentType: JSON_TYPE, cacheControl: "no-cache" } });
  const moved = await registry.markReleasePublished(db, n, now);
  budget.spend(2);
  if (!moved) return { status: "superseded", release: n };
  log("info", "release_published", { release: n, programs: cards.length, gzipBytes, containsSample: artifact.containsSample });
  return { status: "published", release: n, programs: cards.length, gzipBytes };
}

async function failRelease(deps: BuildDeps, n: number, reasons: readonly string[]): Promise<void> {
  await registry.markReleaseFailed(deps.db, n);
  // Reasons name gates and slugs only (registry facts), never student data.
  deps.log("alert", "release_gate_failed", { release: n, reasons: reasons.join("; ").slice(0, 500) });
}

/**
 * The release this invocation should build, or null. Only the newest unpublished release is
 * built, because each build reads the whole current registry; older unpublished ones are marked
 * failed (superseded). Failed releases are not retried: a gate failure needs a person.
 *
 * A fresh environment with published programs and no release at all gets release 1 allocated
 * here, so local development and new staging databases need no manual step.
 */
export async function releaseToBuild(db: Db, now: number, log: ReleaseLog): Promise<number | null> {
  const open = await registry.unpublishedReleases(db);
  const newest = open.at(-1);
  if (newest) {
    for (const older of open.slice(0, -1)) {
      await registry.markReleaseFailed(db, older.number);
      log("info", "release_superseded", { release: older.number, by: newest.number });
    }
    return newest.number;
  }
  if (await registry.latestPublishedRelease(db)) return null;
  if (!(await registry.hasPublishedPrograms(db))) return null;
  return registry.allocateRelease(db, now);
}
