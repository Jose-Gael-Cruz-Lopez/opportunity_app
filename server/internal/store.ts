import { and, desc, eq, inArray } from "drizzle-orm";
import type { HostPolicy } from "@shared/taxonomy";
import { resolveSeedPolicy, stricter, hostOf } from "./host-policy";
import type { Db } from "@server/db/client";
import * as s from "@server/db/schema";

/**
 * Reads the internal API needs that server/db/repos does not offer yet (candidates for
 * repos/registry.ts). Read-only; every write goes through the repos.
 */

export async function storedHostPolicies(db: Db, hosts: readonly string[]): Promise<Map<string, HostPolicy>> {
  const unique = [...new Set(hosts)];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ host: s.sourceHosts.host, policy: s.sourceHosts.policy }).from(s.sourceHosts).where(inArray(s.sourceHosts.host, unique));
  return new Map(rows.map((r) => [r.host, r.policy as HostPolicy]));
}

export interface SourcePolicy {
  readonly policy: HostPolicy;
  readonly policySource: "seed" | "default" | "curator";
}

/**
 * The policy to store with a new or updated Source: the stricter of the seed table and D1's row.
 * The repo's upsert overwrites the host row, so a Curator's stricter decision (and its
 * `policy_source`) must be carried through here, never replaced by a looser seed default.
 */
export async function sourcePolicyFor(db: Db, url: string): Promise<SourcePolicy | null> {
  const host = hostOf(url);
  if (!host) return null;
  const seed = resolveSeedPolicy(url);
  const row = await db.query.sourceHosts.findFirst({ where: eq(s.sourceHosts.host, host) });
  const seedSource = seed.entry ? "seed" : "default";
  if (!row) return { policy: seed.policy, policySource: seedSource };
  const stored = row.policy as HostPolicy;
  const policy = stricter(seed.policy, stored);
  const policySource = policy === stored ? (row.policySource as SourcePolicy["policySource"]) : seedSource;
  return { policy, policySource };
}

export async function getSource(db: Db, sourceId: string) {
  return (await db.query.sources.findFirst({ where: eq(s.sources.id, sourceId) })) ?? null;
}

export async function getSourceByUrl(db: Db, url: string) {
  return (await db.query.sources.findFirst({ where: eq(s.sources.url, url) })) ?? null;
}

export async function getSnapshot(db: Db, snapshotId: string) {
  return (await db.query.snapshots.findFirst({ where: eq(s.snapshots.id, snapshotId) })) ?? null;
}

/** The newest Snapshot of a Source with the same normalized text, if any (for "none" changes). */
export async function latestSnapshotOfSource(db: Db, sourceId: string) {
  return (await db.query.snapshots.findFirst({ where: eq(s.snapshots.sourceId, sourceId), orderBy: desc(s.snapshots.fetchedAt) })) ?? null;
}

/** Any Snapshot that already stored this exact content for this Source (retry idempotency). */
export async function findSnapshot(db: Db, sourceId: string, rawSha256: string, normalizerVersion: string, fetchedAt: number) {
  return (
    (await db.query.snapshots.findFirst({
      where: and(
        eq(s.snapshots.sourceId, sourceId),
        eq(s.snapshots.rawSha256, rawSha256),
        eq(s.snapshots.normalizerVersion, normalizerVersion),
        eq(s.snapshots.fetchedAt, fetchedAt),
      ),
    })) ?? null
  );
}
