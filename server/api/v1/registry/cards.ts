import type { ProgramCard } from "@shared/contracts/registry";
import { buildIndex, type ProgramSearchIndex } from "@shared/matching";
import { publicOrder } from "./order";
import type { RegistryStore } from "./ports";

/**
 * A per-isolate cache of the published cards and their search index, so list and search
 * requests do not reload the registry from D1 each time (plan 2.3.4: "build the same index once
 * per isolate and release").
 *
 * - Within `checkMs` (60 s, the release pointer's own TTL) the cached set is used as is.
 * - After that, one cheap query reads the release number; a new release reloads at once.
 * - Cards are reloaded at least every `maxAgeMs` (5 minutes) even without a new release, because
 *   freshness labels move with the clock and local data can change without a release.
 * Concurrent requests share one reload.
 */

export interface CardSet {
  readonly release: number;
  /** Published cards in public order. */
  readonly cards: readonly ProgramCard[];
  readonly byId: ReadonlyMap<string, ProgramCard>;
  /** When the cards were loaded (also the live artifact's generatedAt). */
  readonly loadedAt: number;
  /** Built on first search only; browsing never pays for it. */
  index(): ProgramSearchIndex;
}

export interface CardCacheOptions {
  readonly checkMs?: number;
  readonly maxAgeMs?: number;
}

function cardSet(release: number, cards: readonly ProgramCard[], now: number): CardSet {
  const ordered = publicOrder(cards, now);
  let index: ProgramSearchIndex | null = null;
  return {
    release,
    cards: ordered,
    byId: new Map(ordered.map((c) => [c.programId, c])),
    loadedAt: now,
    index: () => (index ??= buildIndex(ordered)),
  };
}

export class CardCache {
  private current: CardSet | null = null;
  private checkedAt = 0;
  private pending: Promise<CardSet> | null = null;
  private readonly checkMs: number;
  private readonly maxAgeMs: number;

  constructor(options: CardCacheOptions = {}) {
    this.checkMs = options.checkMs ?? 60_000;
    this.maxAgeMs = options.maxAgeMs ?? 300_000;
  }

  async get(store: RegistryStore, now: number): Promise<CardSet> {
    const cached = this.current;
    if (cached && now - this.checkedAt < this.checkMs) return cached;
    this.pending ??= this.refresh(store, now).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Drops the cached set (tests; an admin rollback in this isolate). */
  clear(): void {
    this.current = null;
    this.checkedAt = 0;
  }

  private async refresh(store: RegistryStore, now: number): Promise<CardSet> {
    const release = await store.currentRelease();
    const cached = this.current;
    if (cached && cached.release === release && now - cached.loadedAt < this.maxAgeMs) {
      this.checkedAt = now;
      return cached;
    }
    const next = cardSet(release, await store.listCards(now), now);
    this.current = next;
    this.checkedAt = now;
    return next;
  }
}
