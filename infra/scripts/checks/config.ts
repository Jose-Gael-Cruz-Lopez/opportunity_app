/**
 * Wrangler configuration rules. Works on the raw config object (wrangler's own TOML reader turns
 * the file into it), so the rules are pure and testable.
 *
 * - Production never exposes workers.dev or version URLs (they would serve production data on a
 *   public hostname) and has no `previews` block.
 * - No production resource id or bucket appears in local, staging or any `previews` block.
 * - Secrets never appear as plain vars.
 * - The app Worker has every binding server/env.ts expects and the three cron triggers.
 * - Observability never stores invocation logs (they record full URLs, and paths carry bearer
 *   tokens) and strips query strings.
 * - With `strict`, the target environment holds no REPLACE_WITH placeholders (deploy gate).
 */
import type { Finding } from "./files";

const CHECK = "config";

export const APP_CRONS = ["*/5 * * * *", "0 * * * *", "0 8 * * *"] as const;
export const SECRET_NAMES = [
  "GEMINI_API_KEY",
  "BETTER_AUTH_SECRET",
  "INTERNAL_HMAC_KEYS",
  "SENTRY_DSN",
  "D1_EXPORT_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "TURNSTILE_SECRET_KEY",
] as const;
const APP_VARS = ["APP_ORIGIN", "ENVIRONMENT", "GEMINI_MODEL"] as const;
const ENVIRONMENTS = ["local", "staging", "production"] as const;

interface D1Entry {
  binding?: string;
  database_name?: string;
  database_id?: string;
  migrations_dir?: string;
}
interface R2Entry {
  binding?: string;
  bucket_name?: string;
}
export interface EnvBlock {
  name?: string;
  workers_dev?: boolean;
  preview_urls?: boolean;
  vars?: Record<string, unknown>;
  d1_databases?: D1Entry[];
  r2_buckets?: R2Entry[];
  send_email?: Array<{ name?: string }>;
  assets?: { binding?: string; directory?: string };
  triggers?: { crons?: string[] };
  previews?: unknown;
  workflows?: Array<{ binding?: string }>;
  observability?: { enabled?: boolean; redact_query_string?: boolean; logs?: { enabled?: boolean; invocation_logs?: boolean } };
}
export interface RawConfig extends EnvBlock {
  env?: Record<string, EnvBlock>;
}

const isPlaceholder = (v: string | undefined): boolean => !v || v.startsWith("REPLACE_WITH");

/** Resource identifiers that belong to production: D1 ids and R2 bucket names. */
export function productionIdentifiers(config: RawConfig): string[] {
  const prod = config.env?.production;
  if (!prod) return [];
  const ids = [
    ...(prod.d1_databases ?? []).map((d) => d.database_id),
    ...(prod.r2_buckets ?? []).map((b) => b.bucket_name),
  ];
  return ids.filter((v): v is string => typeof v === "string" && !isPlaceholder(v));
}

function stringLeaves(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (node && typeof node === "object") for (const v of Object.values(node)) stringLeaves(v, out);
  return out;
}

function blocksExceptProduction(config: RawConfig): Array<[string, unknown]> {
  const { env, ...top } = config;
  const out: Array<[string, unknown]> = [["top level", top]];
  for (const [name, block] of Object.entries(env ?? {})) {
    if (name !== "production") out.push([`env.${name}`, block]);
    else if (block.previews !== undefined) out.push(["env.production.previews", block.previews]);
  }
  return out;
}

export function checkWranglerConfig(file: string, config: RawConfig, opts: { app: boolean }): Finding[] {
  const findings: Finding[] = [];
  const fail = (message: string): void => {
    findings.push({ check: CHECK, file, message });
  };

  const prod = config.env?.production;
  if (!prod) fail("missing [env.production]");
  else {
    if (prod.workers_dev !== false) fail("env.production must set workers_dev = false");
    if (prod.preview_urls !== false) fail("env.production must set preview_urls = false");
    if (prod.previews !== undefined) fail("env.production must not define a previews block");
  }

  const prodIds = productionIdentifiers(config);
  for (const [where, block] of blocksExceptProduction(config)) {
    const values = stringLeaves(block);
    for (const id of prodIds) {
      // Exact values, plus ids embedded in JSON vars such as BACKUP_DATABASES.
      if (values.some((v) => v === id || v.includes(`"${id}"`))) fail(`${where} references production resource "${id}"`);
    }
  }

  const blocks: Array<[string, EnvBlock]> = [["top level", config]];
  for (const [name, block] of Object.entries(config.env ?? {})) blocks.push([`env.${name}`, block]);
  for (const [where, block] of blocks) {
    for (const secret of SECRET_NAMES) {
      if (block.vars && secret in block.vars) fail(`${where}.vars.${secret} is a secret; use wrangler secret put`);
    }
  }

  if (opts.app) {
    for (const [where, block] of blocks) findings.push(...checkAppBlock(file, where, block));
  }
  return findings;
}

function checkAppBlock(file: string, where: string, block: EnvBlock): Finding[] {
  const findings: Finding[] = [];
  const fail = (message: string): void => {
    findings.push({ check: CHECK, file, message: `${where}: ${message}` });
  };
  const d1 = new Map((block.d1_databases ?? []).map((d) => [d.binding, d]));
  for (const binding of ["DB", "EVENTS_DB"]) {
    const entry = d1.get(binding);
    if (!entry) fail(`missing D1 binding ${binding}`);
    else if (!entry.migrations_dir) fail(`D1 binding ${binding} needs migrations_dir`);
  }
  if (!(block.r2_buckets ?? []).some((b) => b.binding === "STORE")) fail("missing R2 binding STORE");
  if (!(block.send_email ?? []).some((b) => b.name === "EMAIL")) fail("missing send_email binding EMAIL");
  if (block.assets?.binding !== "ASSETS") fail("missing assets binding ASSETS");
  for (const v of APP_VARS) if (!block.vars || !(v in block.vars)) fail(`missing var ${v}`);
  const env = block.vars?.ENVIRONMENT;
  if (typeof env === "string" && !(ENVIRONMENTS as readonly string[]).includes(env)) fail(`ENVIRONMENT "${env}" is not local, staging or production`);
  const obs = block.observability;
  if (obs?.enabled !== false) {
    // invocation_logs defaults to true on Cloudflare, so it must be switched off explicitly.
    if (obs?.logs?.invocation_logs !== false) fail("observability.logs.invocation_logs must be false (request URLs carry tokens)");
    if (obs?.redact_query_string !== true) fail("observability.redact_query_string must be true");
  }
  const crons = [...(block.triggers?.crons ?? [])].sort();
  if (JSON.stringify(crons) !== JSON.stringify([...APP_CRONS].sort())) fail(`crons must be ${APP_CRONS.join(", ")}`);
  return findings;
}

/** Deploy gate: the environment about to be deployed may not hold placeholder ids. */
export function checkNoPlaceholders(file: string, config: RawConfig, envName: string): Finding[] {
  const block = envName === "" ? config : config.env?.[envName];
  if (!block) return [{ check: CHECK, file, message: `no environment "${envName}"` }];
  const text = JSON.stringify(block);
  const hits = text.match(/REPLACE_WITH_[A-Z0-9_]+/g) ?? [];
  return [...new Set(hits)].map((h) => ({ check: CHECK, file, message: `env ${envName || "top level"} still has placeholder ${h}` }));
}
