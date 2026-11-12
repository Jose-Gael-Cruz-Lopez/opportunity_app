/** Pure helpers for the backup Worker, kept apart from `cloudflare:workers` so Node tests can import them. */

export interface DatabaseRef {
  name: string;
  id: string;
}

/** R2 multipart parts must all be the same size except the last, and at least 5 MiB. */
export const PART_SIZE = 8 * 1024 * 1024;

export function parseDatabases(raw: string): DatabaseRef[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("BACKUP_DATABASES must be a JSON array");
  return parsed.map((entry: unknown) => {
    const e = (entry ?? {}) as Partial<DatabaseRef>;
    if (typeof e.name !== "string" || typeof e.id !== "string" || !/^[a-z0-9-]+$/.test(e.name)) {
      throw new Error("each database needs a plain name and an id");
    }
    return { name: e.name, id: e.id };
  });
}

export function backupKey(date: string, name: string): string {
  return `full/${date}/${name}.sql.nvbk1`;
}

/** Groups a byte stream into parts of exactly `size` bytes (the last may be shorter). */
export async function* fixedParts(source: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  let part = new Uint8Array(size);
  let filled = 0;
  for await (const piece of source) {
    let offset = 0;
    while (offset < piece.length) {
      const take = Math.min(size - filled, piece.length - offset);
      part.set(piece.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === size) {
        yield part;
        part = new Uint8Array(size);
        filled = 0;
      }
    }
  }
  if (filled > 0) yield part.slice(0, filled);
}
