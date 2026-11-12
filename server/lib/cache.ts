import { sha256Hex } from "./crypto";

/**
 * HTTP caching helpers: strong ETags, If-None-Match matching, cache keys, and the minimal Cache
 * API surface the edge cache uses (an interface, so tests can pass an in-memory cache).
 */

/** A strong ETag from the body bytes (128 bits of SHA-256 is plenty for change detection). */
export async function computeETag(body: string | ArrayBuffer | Uint8Array): Promise<string> {
  return `"${(await sha256Hex(body)).slice(0, 32)}"`;
}

/** Strips the weak prefix for the weak comparison RFC 9110 prescribes for If-None-Match. */
function opaque(tag: string): string {
  return tag.trim().replace(/^W\//, "");
}

/** True when an If-None-Match header matches the ETag (`*`, single, or a comma list). */
export function ifNoneMatchMatches(header: string | null | undefined, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === "*") return true;
  const want = opaque(etag);
  return header.split(",").some((t) => opaque(t) === want);
}

/** True when a Cache-Control value forbids shared caching. */
export function isPrivateCacheControl(value: string | null): boolean {
  if (!value) return false;
  return /(^|,)\s*(private|no-store|no-cache)\b/i.test(value);
}

/**
 * The edge cache key for a public page: origin and path plus allowlisted query parameters in
 * sorted order. Everything else in the query is dropped, so tracking parameters cannot split the
 * cache and query text never becomes a key.
 */
export function pageCacheKey(url: URL, allowedParams: readonly string[] = []): string {
  const keep = new URLSearchParams();
  for (const name of [...allowedParams].sort()) {
    for (const v of url.searchParams.getAll(name)) keep.append(name, v);
  }
  const qs = keep.toString();
  return `${url.origin}${url.pathname}${qs ? `?${qs}` : ""}`;
}

/** The plan's separate key space for last-good copies, so evicting one never evicts the other. */
export const LAST_GOOD_ORIGIN = "https://lastgood.novus.internal";

export function lastGoodKey(cacheKey: string): string {
  const u = new URL(cacheKey);
  return `${LAST_GOOD_ORIGIN}${u.pathname}${u.search}`;
}

/** Last-good copies live 1 day when a deadline is within 14 days, otherwise 7 days. */
export const LAST_GOOD_TTL = { nearDeadline: 86_400, default: 604_800 } as const;

/** The subset of the Workers Cache API used here. */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
}

/** caches.default in workerd; null where the Cache API does not exist (Node tests, some dev). */
export function defaultCache(): CacheLike | null {
  const g = globalThis as unknown as { caches?: { default?: unknown } };
  const c = g.caches?.default;
  return c ? (c as CacheLike) : null;
}

/** A Map-backed cache for tests and local development. */
export class MemoryCache implements CacheLike {
  readonly entries = new Map<string, { body: ArrayBuffer; init: ResponseInit }>();

  async match(key: string): Promise<Response | undefined> {
    const e = this.entries.get(key);
    return e ? new Response(e.body.slice(0), e.init) : undefined;
  }

  async put(key: string, response: Response): Promise<void> {
    const body = await response.arrayBuffer();
    this.entries.set(key, { body, init: { status: response.status, headers: new Headers(response.headers) } });
  }
}

/** Escapes text for HTML element content (the stale banner). */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}
