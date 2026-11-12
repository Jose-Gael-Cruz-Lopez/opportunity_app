import {
  ProgramDetailSchema,
  ReleaseArtifactSchema,
  ReleasePointerSchema,
  type ProgramDetail,
  type ReleaseArtifact,
  type ReleasePointer,
} from "@shared/contracts";
import type { PageData } from "./data";

/**
 * Read access to the published registry release in R2. Two uses:
 * - `/data/release.json` and `/data/client-core/{n}.json`, the public files the Explore island
 *   and the SPA index in the browser;
 * - the reduced-page fallback: when D1 fails and the edge has no last-good copy, pages render
 *   from the release instead (plan s02 2.3.2), so no D1 read is needed.
 *
 * Key layout (shared with server/mcp/registry.ts and the release builder):
 *   releases/current.json                    ReleasePointer, `path` is the artifact's R2 key
 *   releases/{n}/client-core.json            ReleaseArtifact
 *   releases/{n}/programs/{slug}.json        ProgramDetail
 */

export const RELEASE_POINTER_KEY = "releases/current.json";
export const clientCoreKey = (release: number): string => `releases/${release}/client-core.json`;
export const programDetailKey = (release: number, slug: string): string => `releases/${release}/programs/${slug}.json`;

/** Public URL of a release's client-core file (what `/data/release.json` points browsers to). */
export const clientCorePath = (release: number): string => `/data/client-core/${release}.json`;

/** The R2 surface used here: a structural subset of R2Bucket, so tests pass a Map. */
export interface ReleaseBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

/** A slow bucket must fail the fallback quickly rather than hang the request. */
export const RELEASE_READ_TIMEOUT_MS = 2000;

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("release read timed out")), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Raw text of an object, or null when it does not exist. */
export async function readText(bucket: ReleaseBucket, key: string): Promise<string | null> {
  const object = await withTimeout(bucket.get(key), RELEASE_READ_TIMEOUT_MS);
  return object ? withTimeout(object.text(), RELEASE_READ_TIMEOUT_MS) : null;
}

async function readParsed<T>(bucket: ReleaseBucket, key: string, parse: (raw: unknown) => T | null): Promise<T | null> {
  const text = await readText(bucket, key);
  if (text === null) return null;
  try {
    return parse(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

export function readPointer(bucket: ReleaseBucket): Promise<ReleasePointer | null> {
  return readParsed(bucket, RELEASE_POINTER_KEY, (raw) => {
    const parsed = ReleasePointerSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  });
}

/** The R2 key holding release `n`: the pointer's own key for the current release, else the convention. */
export function artifactKeyFor(release: number, pointer: ReleasePointer | null): string {
  return pointer && pointer.release === release ? pointer.path : clientCoreKey(release);
}

/** The browser-facing pointer: same release and hash, path rewritten to the public URL. */
export function publicPointer(pointer: ReleasePointer): ReleasePointer {
  return { ...pointer, path: clientCorePath(pointer.release) };
}

/**
 * PageData backed by the current release. Cycle history needs D1, so it is empty here; the
 * reduced page says it is a saved copy. Organization and list reads are left out on purpose. Unpublished records never reach a release, but the check
 * is repeated so a bad artifact cannot expose a draft.
 */
export function releasePageData(bucket: ReleaseBucket): PageData {
  let artifact: Promise<ReleaseArtifact | null> | null = null;
  const loadArtifact = (): Promise<ReleaseArtifact | null> => {
    artifact ??= readPointer(bucket).then((pointer) =>
      pointer
        ? readParsed(bucket, pointer.path, (raw) => {
            const parsed = ReleaseArtifactSchema.safeParse(raw);
            return parsed.success ? parsed.data : null;
          })
        : null,
    );
    return artifact;
  };
  const require = async (): Promise<ReleaseArtifact> => {
    const found = await loadArtifact();
    if (!found) throw new Error("no published release");
    return found;
  };
  return {
    listCards: async () => (await require()).cards,
    async getDetail(slug) {
      const release = await require();
      return readParsed<ProgramDetail>(bucket, programDetailKey(release.release, slug), (raw) => {
        const parsed = ProgramDetailSchema.safeParse(raw);
        return parsed.success && parsed.data.program.isPublished ? parsed.data : null;
      });
    },
    cycleHistory: async () => [],
    async resolveSlug(slug) {
      const release = await require();
      if (release.cards.some((c) => c.slug === slug)) return { kind: "found" };
      const survivor = release.merged[slug];
      return survivor ? { kind: "moved", slug: survivor } : { kind: "missing" };
    },
    mergedSlugs: async () => ({ ...(await require()).merged }),
    // Organizations and advisor lists are not in the release: those pages answer "unavailable".
  };
}
