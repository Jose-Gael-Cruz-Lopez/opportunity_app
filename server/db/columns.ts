import { sql, type SQL } from "drizzle-orm";
import { check, integer, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * Column kit shared by both D1 schemas. Conventions (data model 3.2):
 * - Keys are UUIDv7 text generated in the application; user-linked records also carry `public_id`.
 * - Instants are UTC epoch milliseconds (plain integers); published dates stay `YYYY-MM-DD` text.
 * - JSON is text under `CHECK (json_valid(...))`, validated with zod at the single write path.
 * - Closed enums are CHECKs; growing enums on referenced tables are lookup rows (foreign keys).
 */

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

function formatUuid(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += "-";
    out += HEX[bytes[i] as number];
  }
  return out;
}

/** Writes the RFC 9562 version-7 and variant bits in place. */
function stampV7(bytes: Uint8Array): Uint8Array {
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  return bytes;
}

/** UUIDv7 (RFC 9562): 48-bit millisecond timestamp then random bits, so keys sort by creation. */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let ts = Math.max(0, Math.floor(nowMs));
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ts % 256;
    ts = Math.floor(ts / 256);
  }
  return formatUuid(stampV7(bytes));
}

/**
 * A deterministic UUIDv7-shaped id from a stable key (cyrb128-style mixing). Seeds use it so
 * re-running a seed targets the same rows; it is not a security primitive.
 */
export function stableId(key: string): string {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < key.length; i++) {
    const k = key.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const words = [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
  const bytes = new Uint8Array(16);
  words.forEach((w, i) => {
    bytes[i * 4] = (w >>> 24) & 0xff;
    bytes[i * 4 + 1] = (w >>> 16) & 0xff;
    bytes[i * 4 + 2] = (w >>> 8) & 0xff;
    bytes[i * 4 + 3] = w & 0xff;
  });
  return formatUuid(stampV7(bytes));
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 128 random bits in base62 (22 chars): the only id of a user-linked record that leaves the server. */
export function newPublicId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out.padStart(22, "0");
}

// ---------------------------------------------------------------------------------------------
// Column builders
// ---------------------------------------------------------------------------------------------

export const pk = () => text("id").primaryKey().$defaultFn(() => uuidv7());

/** UTC instant in epoch milliseconds. */
export const ms = (name: string) => integer(name);

/** A published date (`YYYY-MM-DD`, or `YYYY-MM` for month-only rows); never parsed as an instant. */
export const day = (name: string) => text(name);

export const flag = (name: string, fallback = false) => integer(name, { mode: "boolean" }).notNull().default(fallback);

export const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

/** Optimistic concurrency: `UPDATE ... WHERE id = ? AND version = ?` (3.2). */
export const version = () => integer("version").notNull().default(1);

export const createdAt = () =>
  integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now());

export const updatedAt = () =>
  integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now());

export const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() });

// ---------------------------------------------------------------------------------------------
// Constraint builders
// ---------------------------------------------------------------------------------------------

const SAFE_ENUM_VALUE = /^[A-Za-z0-9_.:-]+$/;

/** CHECK for a closed set. Values are inlined, so only identifier characters are accepted. */
export function oneOf(name: string, column: AnySQLiteColumn, values: readonly string[]) {
  for (const v of values) {
    if (!SAFE_ENUM_VALUE.test(v)) throw new Error(`unsafe enum value ${JSON.stringify(v)} in ${name}`);
  }
  return check(name, sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`);
}

/** Same as oneOf but lets NULL through (nullable enum columns). */
export function oneOfOrNull(name: string, column: AnySQLiteColumn, values: readonly string[]) {
  for (const v of values) {
    if (!SAFE_ENUM_VALUE.test(v)) throw new Error(`unsafe enum value ${JSON.stringify(v)} in ${name}`);
  }
  return check(name, sql`${column} IS NULL OR ${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`);
}

export function jsonValid(name: string, column: AnySQLiteColumn) {
  return check(name, sql`${column} IS NULL OR json_valid(${column})`);
}

export function jsonArray(name: string, column: AnySQLiteColumn) {
  return check(name, sql`${column} IS NULL OR (json_valid(${column}) AND json_type(${column}) = 'array')`);
}

export function jsonObject(name: string, column: AnySQLiteColumn) {
  return check(name, sql`${column} IS NULL OR (json_valid(${column}) AND json_type(${column}) = 'object')`);
}

/** Exactly one of two nullable columns is set (for example user_id xor contact_id). */
export function exactlyOne(name: string, a: AnySQLiteColumn, b: AnySQLiteColumn) {
  return check(name, sql`(${a} IS NULL) <> (${b} IS NULL)`);
}

export const emptyJsonArray: SQL = sql`'[]'`;
export const emptyJsonObject: SQL = sql`'{}'`;
