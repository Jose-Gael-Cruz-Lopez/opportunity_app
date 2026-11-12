import { ProgramDetailSchema, ReleaseArtifactSchema, ReleasePointerSchema, type ProgramCard, type ProgramDetail, type ReleaseArtifact } from "@shared/contracts";
import { buildIndex, type ProgramSearchIndex } from "@shared/matching";

/**
 * The MCP server's read model: one published RegistryRelease, held in isolate memory.
 *
 * MCP reads only release artifacts (client-core in R2 plus optional per-program detail JSON),
 * never D1, so it can serve published records only and never competes with student traffic for
 * D1's single connection. This module must not import server/db/repos (a test checks the import
 * graph of server/mcp).
 */

export interface McpRegistry {
  readonly release: number;
  readonly generatedAt: string;
  readonly containsSample: boolean;
  readonly cards: readonly ProgramCard[];
  /** Loser slug -> survivor slug for recent merges. */
  readonly merged: Readonly<Record<string, string>>;
  readonly index: ProgramSearchIndex;
  /** Card lookup by slug, programId or programCycleId. */
  findCard(ref: string): ProgramCard | null;
  /** Per-program detail for this release; null when the release did not publish one. */
  getDetail(slug: string): Promise<ProgramDetail | null>;
}

export type DetailLoader = (release: number, slug: string) => Promise<ProgramDetail | null>;

/** Builds the in-memory registry from a release artifact. Published cards only. */
export function registryFromArtifact(artifact: ReleaseArtifact, loadDetail: DetailLoader = async () => null): McpRegistry {
  const cards = artifact.cards;
  const bySlug = new Map<string, ProgramCard>();
  const byId = new Map<string, ProgramCard>();
  for (const card of cards) {
    if (!bySlug.has(card.slug)) bySlug.set(card.slug, card);
    if (!byId.has(card.programId)) byId.set(card.programId, card);
    byId.set(card.programCycleId, card);
  }
  const findCard = (ref: string): ProgramCard | null => {
    const key = ref.trim().toLowerCase();
    const survivor = artifact.merged[key];
    return bySlug.get(key) ?? (survivor ? bySlug.get(survivor) : undefined) ?? byId.get(ref.trim()) ?? null;
  };
  const details = new Map<string, Promise<ProgramDetail | null>>();
  return {
    release: artifact.release,
    generatedAt: artifact.generatedAt,
    containsSample: artifact.containsSample,
    cards,
    merged: artifact.merged,
    index: buildIndex(artifact),
    findCard,
    getDetail(slug: string) {
      let pending = details.get(slug);
      if (!pending) {
        pending = loadDetail(artifact.release, slug).catch(() => null);
        details.set(slug, pending);
      }
      return pending;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// R2 reader
// ---------------------------------------------------------------------------------------------

/** The R2 surface this module needs (a structural subset of R2Bucket). */
export interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export const RELEASE_KEYS = {
  /** Pointer to the current release artifact (ReleasePointer). */
  pointer: "releases/current.json",
  /** Per-program detail JSON written by release.build (ProgramDetail). */
  detail: (release: number, slug: string) => `releases/${release}/programs/${slug}.json`,
} as const;

/** Reads time out after 2 seconds (plan 8.12) so a slow bucket fails the call instead of hanging. */
export const READ_TIMEOUT_MS = 2000;
/** How long an isolate trusts its pointer before re-reading it. */
export const POINTER_TTL_MS = 60_000;

export class RegistryUnavailableError extends Error {
  constructor(reason: string) {
    super(`registry release unavailable: ${reason}`);
    this.name = "RegistryUnavailableError";
  }
}

export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RegistryUnavailableError(`${label} timed out`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readJson(bucket: R2Like, key: string, label: string): Promise<unknown | null> {
  const object = await withTimeout(bucket.get(key), READ_TIMEOUT_MS, label);
  if (!object) return null;
  const text = await withTimeout(object.text(), READ_TIMEOUT_MS, label);
  return JSON.parse(text) as unknown;
}

function r2DetailLoader(bucket: R2Like): DetailLoader {
  return async (release, slug) => {
    const raw = await readJson(bucket, RELEASE_KEYS.detail(release, slug), "detail");
    if (raw === null) return null;
    const parsed = ProgramDetailSchema.safeParse(raw);
    return parsed.success && parsed.data.program.isPublished ? parsed.data : null;
  };
}

interface CachedRelease {
  readonly sha256: string;
  readonly registry: McpRegistry;
  checkedAt: number;
}

/**
 * Loads the current release from R2 and caches it per isolate, keyed by the pointer's hash.
 * A new pointer is picked up within POINTER_TTL_MS; the artifact itself is immutable.
 */
export function createR2RegistrySource(): (bucket: R2Like, now: number) => Promise<McpRegistry> {
  let cached: CachedRelease | null = null;
  return async (bucket, now) => {
    if (cached && now - cached.checkedAt < POINTER_TTL_MS) return cached.registry;
    const pointerRaw = await readJson(bucket, RELEASE_KEYS.pointer, "pointer");
    const pointer = ReleasePointerSchema.safeParse(pointerRaw);
    if (!pointer.success) {
      if (cached) return cached.registry; // keep serving the last good release
      throw new RegistryUnavailableError("no release pointer");
    }
    if (cached && cached.sha256 === pointer.data.sha256) {
      cached.checkedAt = now;
      return cached.registry;
    }
    const artifactRaw = await readJson(bucket, pointer.data.path, "artifact");
    const artifact = ReleaseArtifactSchema.safeParse(artifactRaw);
    if (!artifact.success) {
      if (cached) return cached.registry;
      throw new RegistryUnavailableError("release artifact missing or invalid");
    }
    const registry = registryFromArtifact(artifact.data, r2DetailLoader(bucket));
    cached = { sha256: pointer.data.sha256, registry, checkedAt: now };
    return registry;
  };
}
