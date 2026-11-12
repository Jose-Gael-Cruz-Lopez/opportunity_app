import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { ProgramDetailSchema, ReleaseArtifactSchema, ReleasePointerSchema } from "@shared/contracts/registry";
import * as s from "@server/db/schema";
import { freshDb, seededDb } from "@server/db/testing/fixtures";
import { boundaryTargets, buildRelease, CLIENT_CORE_BUDGET_BYTES, eligibilityBoundaryReasons, RELEASE_KEYS, releaseGates, releaseToBuild, type ReleaseBudget, type ReleaseLog, type ReleaseStoreBucket } from "./index";

/** Integration: release.build over the committed migrations and the SAMPLE seed, into an in-memory bucket. */

const NOW = Date.parse("2026-11-11T15:00:00Z");
const ORIGIN = "https://novus.example.org";

class MemoryBucket implements ReleaseStoreBucket {
  readonly objects = new Map<string, string>();
  async head(key: string) {
    return this.objects.has(key) ? { key } : null;
  }
  async put(key: string, value: string) {
    this.objects.set(key, value);
    return { key };
  }
  json(key: string): unknown {
    const v = this.objects.get(key);
    if (v === undefined) throw new Error(`missing ${key}`);
    return JSON.parse(v);
  }
}

/** A budget that allows `calls` D1 calls in total. */
function budgetOf(calls: number): ReleaseBudget & { left: () => number } {
  let left = calls;
  return {
    allows: (n = 1) => left >= n,
    spend: (n = 1) => {
      left -= n;
    },
    left: () => left,
  };
}

const logs: { level: string; event: string }[] = [];
const log: ReleaseLog = (level, event) => logs.push({ level, event });

async function releaseState(db: Awaited<ReturnType<typeof seededDb>>["db"], n: number) {
  const [row] = await db.select().from(s.registryReleases).where(eq(s.registryReleases.number, n));
  return row;
}

describe("releaseToBuild", () => {
  it("allocates release 1 in a fresh environment that has published programs", async () => {
    const t = await seededDb();
    expect(await releaseToBuild(t.db, NOW, log)).toBe(1);
    // The allocated release is now open, so the next call returns it instead of allocating again.
    expect(await releaseToBuild(t.db, NOW, log)).toBe(1);
  });

  it("allocates nothing without published programs", async () => {
    const t = await freshDb();
    expect(await releaseToBuild(t.db, NOW, log)).toBeNull();
  });

  it("builds only the newest open release and marks older ones failed", async () => {
    const t = await seededDb();
    await t.db.insert(s.registryReleases).values([
      { number: 1, createdAt: NOW },
      { number: 2, createdAt: NOW },
    ]);
    expect(await releaseToBuild(t.db, NOW, log)).toBe(2);
    expect((await releaseState(t.db, 1))?.state).toBe("failed");
  });
});

describe("buildRelease", () => {
  it("writes details, client-core and the pointer, and marks the release published", async () => {
    const t = await seededDb();
    const bucket = new MemoryBucket();
    const n = (await releaseToBuild(t.db, NOW, log)) as number;
    const out = await buildRelease({ db: t.db, bucket, now: () => NOW, origin: ORIGIN, budget: budgetOf(10_000), log }, n);
    expect(out.status).toBe("published");

    const pointer = ReleasePointerSchema.parse(bucket.json(RELEASE_KEYS.pointer));
    expect(pointer).toMatchObject({ release: n, path: RELEASE_KEYS.clientCore(n) });
    const artifact = ReleaseArtifactSchema.parse(bucket.json(pointer.path));
    expect(artifact.cards.length).toBeGreaterThan(0);
    // Sample data stays labelled as sample all the way into the published artifact.
    expect(artifact.containsSample).toBe(true);
    for (const card of artifact.cards) {
      const detail = ProgramDetailSchema.parse(bucket.json(RELEASE_KEYS.detail(n, card.slug)));
      expect(detail.program.slug).toBe(card.slug);
    }
    const row = await releaseState(t.db, n);
    expect(row).toMatchObject({ state: "published", clientCoreKey: RELEASE_KEYS.clientCore(n), sha256: pointer.sha256 });
  });

  it("resumes a build that ran out of budget without rewriting finished details", async () => {
    const t = await seededDb();
    const bucket = new MemoryBucket();
    const n = (await releaseToBuild(t.db, NOW, log)) as number;
    const first = await buildRelease({ db: t.db, bucket, now: () => NOW, origin: ORIGIN, budget: budgetOf(40), log }, n);
    expect(first.status).toBe("partial");
    expect(bucket.objects.has(RELEASE_KEYS.pointer)).toBe(false);
    const writtenBefore = bucket.objects.size;
    expect(writtenBefore).toBeGreaterThan(0);

    const second = await buildRelease({ db: t.db, bucket, now: () => NOW, origin: ORIGIN, budget: budgetOf(10_000), log }, n);
    expect(second.status).toBe("published");
    expect(bucket.objects.has(RELEASE_KEYS.pointer)).toBe(true);
  });

  it("never moves the pointer back to an older release", async () => {
    const t = await seededDb();
    const bucket = new MemoryBucket();
    await t.db.insert(s.registryReleases).values([
      { number: 1, createdAt: NOW },
      { number: 2, createdAt: NOW, state: "published", publishedAt: NOW },
    ]);
    const out = await buildRelease({ db: t.db, bucket, now: () => NOW, origin: ORIGIN, budget: budgetOf(10_000), log }, 1);
    expect(out.status).toBe("superseded");
    expect(bucket.objects.size).toBe(0);
    expect((await releaseState(t.db, 1))?.state).toBe("failed");
  });
});

describe("releaseGates", () => {
  it("passes an empty registry (nothing to retrieve, tiny artifact)", async () => {
    const artifact = { v: 1 as const, release: 1, generatedAt: "2026-11-11T15:00:00Z", cards: [], merged: {}, containsSample: false };
    const gates = await releaseGates(artifact, JSON.stringify(artifact));
    expect(gates.reasons).toEqual([]);
  });

  it("runs the eligibility boundary profiles over every shipped rule set, and blocks a tampered one", async () => {
    const t = await seededDb();
    const bucket = new MemoryBucket();
    const n = (await releaseToBuild(t.db, NOW, log)) as number;
    expect((await buildRelease({ db: t.db, bucket, now: () => NOW, origin: ORIGIN, budget: budgetOf(10_000), log }, n)).status).toBe("published");
    const artifact = ReleaseArtifactSchema.parse(bucket.json(RELEASE_KEYS.clientCore(n)));
    const targets = boundaryTargets(artifact.cards);
    expect(targets.length).toBe(artifact.cards.filter((c) => c.rules !== null).length);
    expect(targets.length).toBeGreaterThan(0);
    // The seeded (and Curator-published) hashes are the ones the shared engine recomputes.
    expect(eligibilityBoundaryReasons(artifact.cards, "2026-11-11")).toEqual([]);

    const victim = artifact.cards.find((c) => c.rules !== null && c.rules.rules.length > 0)!;
    const tampered = artifact.cards.map((c) =>
      c === victim ? { ...c, rules: { ...c.rules!, rules: c.rules!.rules.slice(1) } } : c,
    );
    const reasons = eligibilityBoundaryReasons(tampered, "2026-11-11");
    expect(reasons).toContain(`eligibility boundary profiles: ${victim.slug} ${victim.cycleKey}: stored hash does not match the rule set`);
    const gates = await releaseGates({ ...artifact, cards: tampered }, JSON.stringify({ ...artifact, cards: tampered }));
    expect(gates.reasons.some((r) => r.startsWith("eligibility boundary profiles:"))).toBe(true);
  });

  it("fails the size budget on an artifact above it", async () => {
    // Random hex compresses to about half its length; 4 x 64 KiB random bytes as hex is about
    // 256 KiB gzipped, well above the budget. (getRandomValues takes at most 64 KiB per call.)
    const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(65_536)), (b) => b.toString(16).padStart(2, "0")).join("");
    const noise = [randomHex(), randomHex(), randomHex(), randomHex()].join("");
    const artifact = { v: 1 as const, release: 1, generatedAt: "2026-11-11T15:00:00Z", cards: [], merged: {}, containsSample: false };
    const gates = await releaseGates(artifact, JSON.stringify({ ...artifact, noise }));
    expect(gates.reasons.some((r) => r.includes("budget"))).toBe(true);
  });
});
