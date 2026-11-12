import { z } from "zod";
import type { ProgramCard } from "../contracts/registry";
import { sha256Hex } from "../eligibility/hash";
import { MATCHING_CONFIG } from "./config";

/**
 * The embeddings leg's data: the canonical program text that gets embedded, the release file the
 * pipeline produces, int8 vector decoding and cosine retrieval. Pure and synchronous; no network.
 *
 * Program text only. Vectors are made offline by pipeline/novus_pipeline/embeddings from the
 * public release (the same cards students see), never from student text. The Python port of
 * `embeddingText`, `queryTextHash` and the int8 codec must stay byte-identical; the vectors in
 * fixtures/embedding-parity.json are checked by both test suites.
 */

const DENSE = MATCHING_CONFIG.dense;

/** Domain-separation prefixes for the two hashes, so a program text can never alias a query. */
const PROGRAM_TEXT_TAG = "novus-embed-program";
const QUERY_TEXT_TAG = "novus-embed-query";

/** NFKC, whitespace runs to one space, trimmed. */
function clean(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function slugWords(values: readonly string[]): string {
  return values
    .map((v) => clean(v.replace(/[_-]+/g, " ")))
    .filter(Boolean)
    .join("; ");
}

/**
 * The text a program is embedded from, version MATCHING_CONFIG.dense.textVersion. Only raw card
 * fields (no label lookups), so the Python port needs no taxonomy tables:
 *
 *   {name}
 *   Also known as: {aliases joined "; "}         (omitted when empty)
 *   Organization: {organizationName}
 *   Type: {opportunity type slugs as words}      (omitted when empty)
 *   Fields: {major family slugs as words}        (omitted when empty)
 *   Topics: {interest tags as words}             (omitted when empty)
 *   {summary}                                    (omitted when empty)
 */
export function embeddingText(card: Pick<ProgramCard, "name" | "aliases" | "organizationName" | "opportunityTypes" | "majorFamilies" | "interestTags" | "summary">): string {
  const lines: string[] = [clean(card.name)];
  const aliases = card.aliases.map(clean).filter(Boolean);
  if (aliases.length) lines.push(`Also known as: ${aliases.join("; ")}`);
  lines.push(`Organization: ${clean(card.organizationName)}`);
  const types = slugWords(card.opportunityTypes);
  if (types) lines.push(`Type: ${types}`);
  const fields = slugWords(card.majorFamilies);
  if (fields) lines.push(`Fields: ${fields}`);
  const topics = slugWords(card.interestTags);
  if (topics) lines.push(`Topics: ${topics}`);
  const summary = clean(card.summary ?? "");
  if (summary) lines.push(summary);
  return lines.join("\n");
}

/** SHA-256 of the tagged, versioned program text: a stored vector is fresh only while this matches. */
export function embeddingTextHash(card: Parameters<typeof embeddingText>[0], textVersion: number = DENSE.textVersion): string {
  return sha256Hex(`${PROGRAM_TEXT_TAG}-v${textVersion}\n${embeddingText(card)}`);
}

/** The form a query is embedded and looked up in: NFKC, lower case, single spaces, trimmed. */
export function normalizeQueryText(query: string): string {
  return clean(query).toLowerCase();
}

/** Key for a precomputed query vector (labelled eval queries only; never a student's query). */
export function queryTextHash(query: string): string {
  return sha256Hex(`${QUERY_TEXT_TAG}-v1\n${normalizeQueryText(query)}`);
}

// ---------------------------------------------------------------------------------------------
// Release file
// ---------------------------------------------------------------------------------------------

export const EMBEDDINGS_FORMAT = "novus.program-embeddings.v1";

const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const VectorB64Schema = z.string().min(4).max(20_000).regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const ProgramEmbeddingsFileSchema = z
  .object({
    format: z.literal(EMBEDDINGS_FORMAT),
    model: z.string().min(1).max(80),
    dims: z.number().int().min(8).max(4096),
    textVersion: z.number().int().positive(),
    docTask: z.string().max(40),
    queryTask: z.string().max(40),
    /** Each vector is int8 (two's complement), symmetric per vector, base64; cosine is scale-free. */
    encoding: z.literal("int8-b64"),
    generatedAt: z.string().max(40),
    /** The release whose cards were embedded, when known. */
    sourceRelease: z.number().int().nonnegative().nullable(),
    programs: z.array(z.object({ id: z.string().min(1).max(64), textHash: HashSchema, v: VectorB64Schema }).strict()).max(20_000),
    /** Vectors of labelled, team-written eval queries (never student queries), for the hybrid gate. */
    queries: z.array(z.object({ textHash: HashSchema, v: VectorB64Schema }).strict()).max(5_000).default([]),
  })
  .strict();
export type ProgramEmbeddingsFile = z.infer<typeof ProgramEmbeddingsFileSchema>;

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX: ReadonlyMap<string, number> = new Map([...B64].map((c, i) => [c, i]));

function base64ToBytes(b64: string): Uint8Array {
  const clean64 = b64.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean64.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let j = 0;
  for (const ch of clean64) {
    const v = B64_INDEX.get(ch);
    if (v === undefined) throw new RangeError("invalid base64");
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (buffer >> bits) & 0xff;
    }
  }
  return out.subarray(0, j);
}

function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = i + 1 < bytes.length ? (bytes[i + 1] as number) : 0;
    const c = i + 2 < bytes.length ? (bytes[i + 2] as number) : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

/**
 * int8 encoding, as the pipeline writes it: q_i = round(127 * x_i / max|x|), half away from
 * zero, as two's-complement bytes in base64. A zero vector encodes as zeros. Used by tests and
 * fixtures; production vectors are encoded in Python (same rule).
 */
export function encodeVectorInt8(values: ArrayLike<number>): string {
  let max = 0;
  for (let i = 0; i < values.length; i++) max = Math.max(max, Math.abs(values[i] as number));
  const bytes = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const x = values[i] as number;
    const q = max === 0 ? 0 : Math.sign(x) * Math.floor((127 * Math.abs(x)) / max + 0.5);
    bytes[i] = q & 0xff;
  }
  return bytesToBase64(bytes);
}

/** Decodes an int8 base64 vector to unit length; null when the length is wrong or it is all zeros. */
export function decodeVectorInt8(b64: string, dims: number): Float32Array | null {
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    return null;
  }
  if (bytes.length !== dims) return null;
  const v = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    const b = bytes[i] as number;
    const x = b > 127 ? b - 256 : b;
    v[i] = x;
    norm += x * x;
  }
  if (norm === 0) return null;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < dims; i++) v[i] = (v[i] as number) * inv;
  return v;
}

/** Unit-length copy of a float vector; null for a wrong length, a non-finite value or all zeros. */
export function unitVector(values: ArrayLike<number>, dims: number): Float32Array | null {
  if (values.length !== dims) return null;
  const v = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    const x = values[i] as number;
    if (!Number.isFinite(x)) return null;
    v[i] = x;
    norm += x * x;
  }
  if (norm === 0) return null;
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < dims; i++) v[i] = (v[i] as number) * inv;
  return v;
}

// ---------------------------------------------------------------------------------------------
// Dense index
// ---------------------------------------------------------------------------------------------

export interface DenseIndex {
  readonly model: string;
  readonly dims: number;
  readonly textVersion: number;
  readonly queryTask: string;
  readonly ids: readonly string[];
  /** ids.length x dims, row-major, each row unit length. */
  readonly matrix: Float32Array;
  readonly minSimilarity: number;
  /** Precomputed eval-query vectors by queryTextHash (labelled queries only). */
  readonly queryVectors: ReadonlyMap<string, Float32Array>;
  readonly sourceRelease: number | null;
}

export type DenseAlignIssue = "unknown_format" | "model_not_allowlisted" | "dims_mismatch" | "text_version_mismatch" | "low_coverage";

export interface DenseAlignment {
  /** Null when the file cannot be used at all; search is then lexical only. */
  readonly index: DenseIndex | null;
  /** Cards with a fresh vector, cards whose text changed since embedding, and cards never embedded. */
  readonly fresh: number;
  readonly stale: number;
  readonly missing: number;
  readonly coverage: number;
  readonly issues: readonly DenseAlignIssue[];
  /** The file restricted to this release's fresh vectors, for releases/{n}/embeddings.json. */
  readonly file: ProgramEmbeddingsFile | null;
}

export interface AlignOptions {
  readonly minCoverage?: number;
  readonly minSimilarity?: number;
  /** Allowlisted models; defaults to MATCHING_CONFIG.dense.models. */
  readonly models?: readonly string[];
  readonly dims?: number;
}

/**
 * Aligns a vectors file with the cards a release ships: a vector is kept only when its id is a
 * shipped card and its textHash matches that card's current text, so an edited summary never
 * keeps an old meaning. Gates (model allowlist, dimensions, text version, coverage) decide whether
 * the dense leg is usable for this release at all; any issue returns `index: null`.
 */
export function alignEmbeddings(raw: unknown, cards: readonly ProgramCard[], opts: AlignOptions = {}): DenseAlignment {
  const parsed = ProgramEmbeddingsFileSchema.safeParse(raw);
  const empty = (issues: DenseAlignIssue[]): DenseAlignment => ({ index: null, fresh: 0, stale: 0, missing: cards.length, coverage: 0, issues, file: null });
  if (!parsed.success) return empty(["unknown_format"]);
  const file = parsed.data;
  const issues: DenseAlignIssue[] = [];
  if (!(opts.models ?? DENSE.models).includes(file.model)) issues.push("model_not_allowlisted");
  if (file.dims !== (opts.dims ?? DENSE.dims)) issues.push("dims_mismatch");
  if (file.textVersion !== DENSE.textVersion) issues.push("text_version_mismatch");
  if (issues.length) return empty(issues);

  const byId = new Map(file.programs.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const kept: ProgramEmbeddingsFile["programs"] = [];
  const rows: Float32Array[] = [];
  let stale = 0;
  let missing = 0;
  for (const card of cards) {
    if (seen.has(card.programCycleId)) continue;
    seen.add(card.programCycleId);
    const entry = byId.get(card.programCycleId);
    if (!entry) {
      missing += 1;
      continue;
    }
    const vec = entry.textHash === embeddingTextHash(card, file.textVersion) ? decodeVectorInt8(entry.v, file.dims) : null;
    if (!vec) {
      stale += 1;
      continue;
    }
    kept.push(entry);
    rows.push(vec);
  }
  const total = seen.size;
  const coverage = total ? kept.length / total : 0;
  if (coverage < (opts.minCoverage ?? DENSE.minCoverage)) {
    return { index: null, fresh: kept.length, stale, missing, coverage, issues: ["low_coverage"], file: null };
  }
  const matrix = new Float32Array(rows.length * file.dims);
  rows.forEach((row, i) => matrix.set(row, i * file.dims));
  const queryVectors = new Map<string, Float32Array>();
  for (const q of file.queries) {
    const vec = decodeVectorInt8(q.v, file.dims);
    if (vec) queryVectors.set(q.textHash, vec);
  }
  const index: DenseIndex = {
    model: file.model,
    dims: file.dims,
    textVersion: file.textVersion,
    queryTask: file.queryTask,
    ids: kept.map((p) => p.id),
    matrix,
    minSimilarity: opts.minSimilarity ?? DENSE.minSimilarity[file.model] ?? 0,
    queryVectors,
    sourceRelease: file.sourceRelease,
  };
  return { index, fresh: kept.length, stale, missing, coverage, issues: [], file: { ...file, programs: kept } };
}

/**
 * Program ids by cosine similarity to a unit query vector, best first: at most `depth`, only those
 * at or above the index's floor, only those `keep` admits (filters). Ties break by id so the
 * order is deterministic. Similarities never leave this function.
 */
export function denseRanking(index: DenseIndex, query: Float32Array, depth: number = MATCHING_CONFIG.fusion.depth, keep?: (id: string) => boolean): string[] {
  if (query.length !== index.dims) return [];
  const scored: { id: string; s: number }[] = [];
  const d = index.dims;
  for (let row = 0; row < index.ids.length; row++) {
    const id = index.ids[row] as string;
    if (keep && !keep(id)) continue;
    let s = 0;
    const off = row * d;
    for (let i = 0; i < d; i++) s += (index.matrix[off + i] as number) * (query[i] as number);
    if (s >= index.minSimilarity) scored.push({ id, s });
  }
  scored.sort((a, b) => b.s - a.s || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return scored.slice(0, depth).map((x) => x.id);
}
