/**
 * TEST ONLY. A minimal D1Database implementation over Node's built-in `node:sqlite` (Node 22.5+,
 * unflagged in Node 24), so repositories run against real SQLite with the real migrations in
 * plain vitest. It mirrors the D1 behaviours repositories rely on: foreign keys always on,
 * booleans bound as 0/1, `batch()` as one transaction that rolls back as a unit, and result
 * shapes `{ results, success, meta }` / `raw()` arrays.
 *
 * It is not D1: no 100-parameter limit, no per-query time limit, no read replicas. Anything
 * that depends on those needs the Workers pool (`*.worker.test.ts`, see server/db/README.md).
 *
 * Node modules are loaded dynamically because the server tsconfig only includes Workers types.
 */

interface SqliteStatement {
  all(...params: unknown[]): Record<string, unknown>[] | unknown[][];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  columns(): { name: string }[];
  setReturnArrays(enabled: boolean): void;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

interface SqliteModule {
  DatabaseSync: new (path: string) => SqliteDatabase;
}

interface FsModule {
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: "utf8"): string;
}

function normalizeParam(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  return value;
}

function meta(changes = 0, lastRowId = 0) {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    changes,
  };
}

class ShimStatement {
  constructor(
    private readonly db: SqliteDatabase,
    readonly sql: string,
    readonly params: readonly unknown[] = [],
  ) {}

  bind(...values: unknown[]): ShimStatement {
    return new ShimStatement(this.db, this.sql, values.map(normalizeParam));
  }

  /** Runs the statement synchronously, returning a D1Result-shaped object. */
  execute(): { results: Record<string, unknown>[]; success: true; meta: ReturnType<typeof meta> } {
    const stmt = this.db.prepare(this.sql);
    if (stmt.columns().length > 0) {
      const rows = stmt.all(...this.params) as Record<string, unknown>[];
      return { results: rows.map((r) => ({ ...r })), success: true, meta: meta(0) };
    }
    const r = stmt.run(...this.params);
    return { results: [], success: true, meta: meta(Number(r.changes), Number(r.lastInsertRowid)) };
  }

  async all() {
    return this.execute();
  }

  async run() {
    return this.execute();
  }

  async first(column?: string) {
    const row = this.execute().results[0];
    if (!row) return null;
    return column ? (row[column] ?? null) : row;
  }

  async raw(options?: { columnNames?: boolean }) {
    const stmt = this.db.prepare(this.sql);
    if (stmt.columns().length === 0) {
      stmt.run(...this.params);
      return [];
    }
    stmt.setReturnArrays(true);
    const rows = stmt.all(...this.params) as unknown[][];
    return options?.columnNames ? [stmt.columns().map((c) => c.name), ...rows] : rows;
  }
}

export interface SqliteD1 {
  /** Pass to getDb / repositories. */
  d1: D1Database;
  /** Direct access for assertions (synchronous). */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  exec(sql: string): void;
  close(): void;
}

async function loadModule<T>(name: string): Promise<T> {
  // A variable specifier keeps TypeScript from resolving Node typings the server tsconfig lacks.
  return (await import(/* @vite-ignore */ name)) as T;
}

export async function createSqliteD1(): Promise<SqliteD1> {
  const { DatabaseSync } = await loadModule<SqliteModule>("node:sqlite");
  const db = new DatabaseSync(":memory:");
  // D1 always enforces foreign keys.
  db.exec("PRAGMA foreign_keys = ON");

  const shim = {
    prepare: (sql: string) => new ShimStatement(db, sql),
    async batch(statements: ShimStatement[]) {
      db.exec("BEGIN");
      try {
        const results = statements.map((s) => s.execute());
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    async exec(sql: string) {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
    async dump() {
      throw new Error("dump is not supported by the test shim");
    },
    withSession() {
      throw new Error("sessions are not supported by the test shim");
    },
  };

  return {
    d1: shim as unknown as D1Database,
    query: <T>(sql: string, ...params: unknown[]) => {
      const rows = db.prepare(sql).all(...params.map(normalizeParam)) as Record<string, unknown>[];
      return rows.map((r) => ({ ...r })) as T[];
    },
    exec: (sql: string) => db.exec(sql),
    close: () => db.close(),
  };
}

/** Applies every `*.sql` file in a migrations folder in name order (what wrangler does). */
export async function applyMigrationsFrom(target: SqliteD1, dir: string): Promise<string[]> {
  const fs = await loadModule<FsModule>("node:fs");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) target.exec(fs.readFileSync(`${dir}/${f}`, "utf8"));
  return files;
}

/** A fresh in-memory `novus-main` with all migrations applied. */
export async function createTestMainDb(repoRoot: string): Promise<SqliteD1> {
  const db = await createSqliteD1();
  await applyMigrationsFrom(db, `${repoRoot}/server/db/migrations`);
  return db;
}

export async function createTestEventsDb(repoRoot: string): Promise<SqliteD1> {
  const db = await createSqliteD1();
  await applyMigrationsFrom(db, `${repoRoot}/server/db/migrations-events`);
  return db;
}
