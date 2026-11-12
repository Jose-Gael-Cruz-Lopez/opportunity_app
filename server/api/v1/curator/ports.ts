import type { Context } from "hono";
import type { Db } from "@server/db/client";
import type { AppEnv, SessionUser } from "@server/env";

/**
 * What the Curator routes need from the outside world. `index.ts` wires the production
 * bindings; tests pass in-memory SQLite and a Map-backed bucket.
 */

/** The R2 surface the Curator API uses (a structural subset of R2Bucket). */
export interface CuratorBucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  head(key: string): Promise<unknown | null>;
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string; cacheControl?: string } }): Promise<unknown>;
}

export type CuratorLog = (level: "info" | "warn" | "error" | "alert", event: string, fields?: Record<string, string | number | boolean | null>) => void;

export interface CuratorDeps {
  db(c: Context<AppEnv>): Db;
  /** R2 store with `snapshots/` and `releases/`; null when unbound (tests, a broken binding). */
  bucket(c: Context<AppEnv>): CuratorBucket | null;
  user(c: Context<AppEnv>): SessionUser | undefined;
  now(): number;
  /** ENVIRONMENT var: staging and production require the console surface (curate.). */
  environment(c: Context<AppEnv>): string;
  log: CuratorLog;
}
