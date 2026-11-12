import { computeRuleSetHash } from "../../shared/eligibility/versioning";

/**
 * Pure helpers shared by repositories and seeds: instant conversion, canonical JSON, hashing,
 * D1 parameter limits and cursors.
 */

/** D1 binds at most 100 parameters per statement (limits page, checked 2026-11-10). */
export const D1_MAX_PARAMS = 100;

/** Rows per multi-row INSERT so that rows * columns stays within D1's parameter limit. */
export function rowsPerInsert(columnsPerRow: number, maxParams: number = D1_MAX_PARAMS): number {
  if (columnsPerRow < 1) throw new Error("columnsPerRow must be positive");
  return Math.max(1, Math.floor(maxParams / columnsPerRow));
}

export function chunked<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Epoch ms -> ISO instant (UTC), preserving null. */
export function isoOrNull(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString();
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** ISO instant -> epoch ms, preserving null; throws on an unparseable value. */
export function msOrNull(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`invalid instant ${value}`);
  return t;
}

/** `YYYY-MM-DD` of an instant in UTC (for verifiedOn-style display dates). */
export function utcDate(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : new Date(ms).toISOString().slice(0, 10);
}

/** JSON with object keys sorted recursively, so equal values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------------------------
// Keyset cursors: opaque base64url of [sortKey, id]; never an offset, so pages stay stable.
// ---------------------------------------------------------------------------------------------

export interface Cursor {
  readonly k: string | number | null;
  readonly id: string;
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeCursor(cursor: Cursor): string {
  return toBase64Url(JSON.stringify([cursor.k, cursor.id]));
}

/** Returns null for a malformed cursor (the route answers 400 rather than guessing). */
export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(fromBase64Url(raw));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [k, id] = parsed as [unknown, unknown];
    if (typeof id !== "string") return null;
    if (k !== null && typeof k !== "string" && typeof k !== "number") return null;
    return { k, id };
  } catch {
    return null;
  }
}

/** Parses a JSON text column that may arrive as a string (raw SQL) or already parsed (Drizzle). */
export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/**
 * The rule-set hash: shared/eligibility's computeRuleSetHash (sha256 of the canonical JSON of what
 * decides a result: format, coverage, rules, anyOf groups, attestations, nomination; evidence,
 * ids and state excluded), so a hash the Worker stores is the one hashMatches(), the release
 * gate, the golden runner and the Python port check. Pass the PARSED rule set (zod defaults
 * applied); hashing raw input would differ from what the browser and the gate see.
 */
export function ruleSetHash(ruleSet: Parameters<typeof computeRuleSetHash>[0]): Promise<string> {
  return Promise.resolve(computeRuleSetHash(ruleSet));
}
