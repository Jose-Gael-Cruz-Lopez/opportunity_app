import { and, eq, gt } from "drizzle-orm";
import type { Actor } from "@shared/contracts/ops";
import { ReleasePointerSchema, type ReleasePointer } from "@shared/contracts/registry";
import { toIsoInstant } from "@shared/time";
import type { Db } from "@server/db/client";
import * as s from "@server/db/schema";
import { runBatch } from "@server/db/repos";
import { RELEASE_KEYS } from "@server/services/release";
import { clientCorePath } from "@server/api/v1/registry/release";
import { opsAudit } from "./audit";
import type { CuratorBucket, CuratorLog } from "./ports";

/**
 * Release rollback (route `releaseRollback`, admin only, matrix row `registry.release.rollback`
 * with obligations registry audit and "notify founders").
 *
 * A rollback points `releases/current.json` back at an earlier artifact that was built and passed
 * its gates; nothing is rebuilt and no artifact is deleted. Releases above the target are marked
 * `failed` so `latestPublishedRelease` (MCP, pages, the build's supersede check) agrees with the
 * pointer. The next Curator publish allocates a new release from the current D1 registry, so the
 * fix for whatever caused the rollback ships the normal way; a rollback is a pointer move, not an
 * undo of D1 changes.
 */

export type RollbackOutcome =
  | { ok: true; pointer: ReleasePointer; from: number | null }
  | { ok: false; code: "not_found" | "conflict" | "unavailable"; detail: string };

export async function rollbackRelease(
  db: Db,
  bucket: CuratorBucket | null,
  target: number,
  actor: Actor,
  requestId: string | null,
  now: number,
  log: CuratorLog,
): Promise<RollbackOutcome> {
  if (!bucket) return { ok: false, code: "unavailable", detail: "The release store is not bound." };
  const row = await db.query.registryReleases.findFirst({ where: eq(s.registryReleases.number, target) });
  if (!row) return { ok: false, code: "not_found", detail: "No such release." };
  if (!row.clientCoreKey || !row.sha256 || row.builtAt === null) return { ok: false, code: "conflict", detail: "That release was never built, so there is nothing to point at." };
  const current = await db.query.registryReleases.findFirst({
    where: eq(s.registryReleases.state, "published"),
    orderBy: (r, { desc }) => [desc(r.number)],
  });
  if (current && current.number <= target) return { ok: false, code: "conflict", detail: "Roll back only to a release older than the live one." };
  if (!(await bucket.head(row.clientCoreKey))) return { ok: false, code: "conflict", detail: "That release's artifact is missing from the store." };

  const pointer: ReleasePointer = { release: target, path: row.clientCoreKey, sha256: row.sha256, publishedAt: toIsoInstant(now) };
  ReleasePointerSchema.parse(pointer);

  // D1 first (with its audit row), then the pointer: if the pointer write fails the admin retries,
  // and the D1 state already says which release should be live.
  await runBatch(db, [
    db.update(s.registryReleases).set({ state: "failed" }).where(and(gt(s.registryReleases.number, target), eq(s.registryReleases.state, "published"))),
    db.update(s.registryReleases).set({ state: "published", publishedAt: now }).where(eq(s.registryReleases.number, target)),
    opsAudit(db, { actor, action: "release_rollback", fields: ["release", "state"], subjectKey: `release:${current?.number ?? 0}->${target}`, requestId, now }),
  ]);
  await bucket.put(RELEASE_KEYS.pointer, JSON.stringify(pointer), { httpMetadata: { contentType: "application/json; charset=utf-8", cacheControl: "no-cache" } });
  // "notify founders": an alert-level line, which the ops alerting routes to the founders' channel.
  log("alert", "release_rolled_back", { from: current?.number ?? null, to: target, actor: actor.ref });
  return { ok: true, pointer: { ...pointer, path: clientCorePath(target) }, from: current?.number ?? null };
}
