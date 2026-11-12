import { describe, expect, it } from "vitest";
import { isSensitiveKey } from "../../../shared/contracts/sensitive";
import { checkNoPlaceholders, checkWranglerConfig, type RawConfig } from "./config";
import { checkContent, isContentScope } from "./content";
import { checkDevVarsExample, checkForbiddenFiles, scanTextForSecrets } from "./secrets";
import { checkJsonSchema, checkLogTemplates, checkMigrationSql, columnsFromSql } from "./sensitive";
import { checkWorkflow } from "./workflows";

// Credential-shaped fixtures are assembled at runtime so this file never trips the scanner itself.
const fakeGoogleKey = ["AI", "za", "Sy", "A".repeat(33)].join("");
const fakePrivateKey = ["-----BEGIN ", "PRIVATE KEY-----"].join("");

describe("secrets", () => {
  it("refuses local secret files but allows the example", () => {
    const files = [".dev.vars", "server/.dev.vars.staging", ".dev.vars.example", ".env", ".env.example", ".wrangler/state/x", "keys/a.pem", "README.md"];
    expect(checkForbiddenFiles(files).map((f) => f.file)).toEqual([".dev.vars", "server/.dev.vars.staging", ".env", ".wrangler/state/x", "keys/a.pem"]);
  });

  it("finds credential shapes and reports the line, not the value", () => {
    const findings = scanTextForSecrets("a.ts", `const x = 1;\nconst k = "${fakeGoogleKey}";\n${fakePrivateKey}\n`);
    expect(findings.map((f) => f.line)).toEqual([2, 3]);
    expect(JSON.stringify(findings)).not.toContain(fakeGoogleKey);
  });

  it("ignores ordinary code and lock files", () => {
    expect(scanTextForSecrets("a.ts", 'const apiKey = env.GEMINI_API_KEY; // "your-gemini-key-here"')).toEqual([]);
    expect(scanTextForSecrets("package-lock.json", fakeGoogleKey)).toEqual([]);
  });

  it("accepts placeholders in .dev.vars.example and rejects real-looking values", () => {
    const ok = 'GEMINI_API_KEY=your-gemini-key-here\nSENTRY_DSN=\nINTERNAL_HMAC_KEYS={"fetch":"your-fetch-hmac-secret"}\nGEMINI_MODEL=gemini-3.5-flash-lite\n';
    expect(checkDevVarsExample(ok)).toEqual([]);
    expect(checkDevVarsExample("BETTER_AUTH_SECRET=q9Zr2mX8vL1pT6wN3bK0\n")).toHaveLength(1);
  });
});

const goodApp = (): RawConfig => {
  const block = (env: string, suffix: string) => ({
    workers_dev: false,
    preview_urls: false,
    vars: { APP_ORIGIN: "x", ENVIRONMENT: env, GEMINI_MODEL: "m" },
    d1_databases: [
      { binding: "DB", database_name: "novus-main", database_id: `main-${suffix}`, migrations_dir: "m" },
      { binding: "EVENTS_DB", database_name: "novus-events", database_id: `events-${suffix}`, migrations_dir: "e" },
    ],
    r2_buckets: [{ binding: "STORE", bucket_name: `novus-store-${suffix}` }],
    send_email: [{ name: "EMAIL" }],
    assets: { binding: "ASSETS", directory: "d" },
    triggers: { crons: ["*/5 * * * *", "0 * * * *", "0 8 * * *"] },
    observability: { enabled: true, redact_query_string: true, logs: { enabled: true, invocation_logs: false } },
  });
  return { ...block("local", "local"), env: { staging: block("staging", "stg"), production: block("production", "prod") } };
};

describe("wrangler config", () => {
  it("passes a well-formed config", () => {
    expect(checkWranglerConfig("w.toml", goodApp(), { app: true })).toEqual([]);
  });

  it("fails when staging points at a production database", () => {
    const c = goodApp();
    const stagingDb = c.env?.staging?.d1_databases?.[0];
    if (stagingDb) stagingDb.database_id = "main-prod";
    expect(checkWranglerConfig("w.toml", c, { app: true }).map((f) => f.message)).toEqual([
      'env.staging references production resource "main-prod"',
    ]);
  });

  it("does not confuse a production bucket with a longer local name", () => {
    const c = goodApp();
    const prodBucket = c.env?.production?.r2_buckets?.[0];
    if (prodBucket) prodBucket.bucket_name = "novus-store";
    expect(checkWranglerConfig("w.toml", c, { app: true })).toEqual([]);
  });

  it("fails on exposed production hostnames, previews, secrets in vars and missing crons", () => {
    const c = goodApp();
    const prod = c.env?.production;
    if (!prod) throw new Error("fixture");
    prod.preview_urls = true;
    prod.previews = { vars: {} };
    prod.vars = { ...prod.vars, GEMINI_API_KEY: "x" };
    prod.triggers = { crons: ["*/5 * * * *"] };
    const messages = checkWranglerConfig("w.toml", c, { app: true }).map((f) => f.message);
    expect(messages).toContain("env.production must set preview_urls = false");
    expect(messages).toContain("env.production must not define a previews block");
    expect(messages).toContain("env.production.vars.GEMINI_API_KEY is a secret; use wrangler secret put");
    expect(messages.some((m) => m.startsWith("env.production: crons must be"))).toBe(true);
  });

  it("fails when observability would store request URLs or query strings", () => {
    const c = goodApp();
    const staging = c.env?.staging;
    const prod = c.env?.production;
    if (!staging || !prod) throw new Error("fixture");
    staging.observability = { enabled: true, redact_query_string: true };
    prod.observability = { enabled: true, logs: { invocation_logs: false } };
    const messages = checkWranglerConfig("w.toml", c, { app: true }).map((f) => f.message);
    expect(messages).toEqual([
      "env.staging: observability.logs.invocation_logs must be false (request URLs carry tokens)",
      "env.production: observability.redact_query_string must be true",
    ]);
  });

  it("deploy gate refuses placeholder ids", () => {
    const c = goodApp();
    const db = c.env?.production?.d1_databases?.[0];
    if (db) db.database_id = "REPLACE_WITH_PRODUCTION_NOVUS_MAIN_ID";
    expect(checkNoPlaceholders("w.toml", c, "production")).toHaveLength(1);
    expect(checkNoPlaceholders("w.toml", c, "staging")).toEqual([]);
  });
});

describe("sensitive-terms guard", () => {
  const sql = [
    "CREATE TABLE `student_profiles` (",
    "  `id` text PRIMARY KEY NOT NULL,",
    "  `citizenship` text,",
    "  `meta` text DEFAULT '{}' CHECK (json_valid(meta)),",
    "  FOREIGN KEY (`id`) REFERENCES `users`(`id`)",
    ");",
    "CREATE TABLE `programs` (`id` text, `sensitive_audience` integer, `identity_audience` integer);",
    "ALTER TABLE `outcomes` ADD `household_income` integer;",
  ].join("\n");

  it("parses columns, skipping constraints", () => {
    expect(columnsFromSql(sql).map((c) => `${c.table}.${c.column}`)).toEqual([
      "student_profiles.id",
      "student_profiles.citizenship",
      "student_profiles.meta",
      "programs.id",
      "programs.sensitive_audience",
      "programs.identity_audience",
      "outcomes.household_income",
    ]);
  });

  it("flags status columns and allows registry flags", () => {
    const messages = checkMigrationSql("m.sql", sql, isSensitiveKey).map((f) => f.message);
    expect(messages).toEqual([
      "column student_profiles.citizenship looks like a status or identity answer",
      "column outcomes.household_income looks like a status or identity answer",
    ]);
  });

  it("flags nested JSON Schema properties", () => {
    const schema = { properties: { profile: { type: "object", properties: { gender: { type: "string" }, major: { type: "string" } } } } };
    expect(checkJsonSchema("s.json", schema, isSensitiveKey).map((f) => f.message)).toEqual([
      "schema property $.properties.profile.properties.gender looks like a status or identity answer",
    ]);
  });

  it("flags sensitive names interpolated into log calls", () => {
    const src = 'console.log(`user ${userId}`);\nlogger.info("x", { firstGen: a.firstGen });\nconst race = 1;\n';
    expect(checkLogTemplates("a.ts", src, isSensitiveKey).map((f) => f.line)).toEqual([2, 2]);
  });

  it("ignores fixed message codes but sees interpolations in templates and f-strings", () => {
    expect(checkLogTemplates("a.ts", 'log.error("internal_key_disabled", { keyId });\n', isSensitiveKey)).toEqual([]);
    expect(checkLogTemplates("a.ts", 'console.log("gender");\n', isSensitiveKey)).toEqual([]);
    expect(checkLogTemplates("a.ts", "console.log(`x ${p.income}`);\n", isSensitiveKey)).toHaveLength(1);
    expect(checkLogTemplates("a.py", 'logger.info(f"user {visa_status}")\n', isSensitiveKey)).toHaveLength(1);
  });
});

describe("content check", () => {
  it("scopes to public client and page code", () => {
    expect(isContentScope("client/src/pages/home.tsx")).toBe(true);
    expect(isContentScope("server/pages/program.tsx")).toBe(true);
    expect(isContentScope("client/src/lib/a.test.ts")).toBe(false);
    expect(isContentScope("server/db/schema.ts")).toBe(false);
  });

  it("flags prototype branding, percentages and scores", () => {
    const text = "Pathful\nYou're 74% ready\nYour readiness score\nTestimonials\nFour parts, no single number";
    expect(checkContent("a.tsx", text).map((f) => f.line).sort()).toEqual([1, 2, 3, 4]);
  });
});

describe("workflow hygiene", () => {
  const pinned = "permissions:\n  contents: read\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n";

  it("accepts SHA-pinned actions with permissions", () => {
    expect(checkWorkflow("ci.yml", pinned)).toEqual([]);
  });

  it("rejects tag pins, pull_request_target, secrets and missing permissions", () => {
    const bad = "on: pull_request_target\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n      - run: echo ${{ secrets.TOKEN }}\n";
    expect(checkWorkflow("ci.yml", bad).map((f) => f.message)).toEqual([
      "actions/checkout@v7 must be pinned to a full commit SHA",
      "pull_request_target is banned",
      "CI holds no secrets; do not reference secrets.*",
      "declare top-level permissions (least privilege)",
    ]);
  });
});
