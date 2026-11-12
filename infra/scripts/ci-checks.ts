/**
 * Repository guards run by CI and locally:
 *
 *   npx tsx infra/scripts/ci-checks.ts [all|secrets|config|sensitive|content|workflows|fonts]
 *   npx tsx infra/scripts/ci-checks.ts deploy-gate --env production   (no placeholder ids)
 *
 * Exit code 1 on any finding. Output names files and lines only, never matched values, so a
 * leaked secret is not copied into public CI logs.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isSensitiveKey } from "../../shared/contracts/sensitive";
import { checkNoPlaceholders, checkWranglerConfig, type RawConfig } from "./checks/config";
import { checkContent, isContentScope } from "./checks/content";
import { checkCspFonts, checkFontFolder, checkFontReferences, FONT_DIR, isFontScope } from "./checks/fonts";
import { buildCsp } from "../../server/config/security";
import { listRepoFiles, readText, REPO_ROOT, type Finding } from "./checks/files";
import { checkDevVarsExample, checkForbiddenFiles, scanTextForSecrets } from "./checks/secrets";
import { checkJsonSchema, checkLogTemplates, checkMigrationSql } from "./checks/sensitive";
import { checkWorkflow } from "./checks/workflows";

const APP_CONFIG = "infra/wrangler/wrangler.toml";
const BACKUP_CONFIG = "infra/wrangler/backup.toml";

function secrets(files: readonly string[]): Finding[] {
  const findings = checkForbiddenFiles(files);
  for (const f of files) {
    const text = readText(REPO_ROOT, f);
    if (text !== null) findings.push(...scanTextForSecrets(f, text));
  }
  const example = readText(REPO_ROOT, ".dev.vars.example");
  if (example === null) findings.push({ check: "secrets", file: ".dev.vars.example", message: "missing" });
  else findings.push(...checkDevVarsExample(example));
  return findings;
}

async function readWranglerConfig(path: string): Promise<RawConfig> {
  // wrangler's own reader, so TOML parsing matches what deploy sees.
  const wrangler = (await import("wrangler")) as unknown as {
    experimental_readRawConfig: (args: { config: string }) => { rawConfig: RawConfig };
  };
  return wrangler.experimental_readRawConfig({ config: join(REPO_ROOT, path) }).rawConfig;
}

async function config(): Promise<Finding[]> {
  return [
    ...checkWranglerConfig(APP_CONFIG, await readWranglerConfig(APP_CONFIG), { app: true }),
    ...checkWranglerConfig(BACKUP_CONFIG, await readWranglerConfig(BACKUP_CONFIG), { app: false }),
  ];
}

function sqlFiles(dir: string): string[] {
  try {
    return readdirSync(join(REPO_ROOT, dir))
      .filter((f) => f.endsWith(".sql"))
      .map((f) => `${dir}/${f}`);
  } catch {
    return [];
  }
}

function sensitive(files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of [...sqlFiles("server/db/migrations"), ...sqlFiles("server/db/migrations-events")]) {
    const sql = readText(REPO_ROOT, f);
    if (sql !== null) findings.push(...checkMigrationSql(f, sql, isSensitiveKey));
  }
  for (const f of files.filter((x) => x.startsWith("shared/contracts/json-schema/") && x.endsWith(".json"))) {
    const text = readText(REPO_ROOT, f);
    if (text !== null) findings.push(...checkJsonSchema(f, JSON.parse(text) as unknown, isSensitiveKey));
  }
  const logScope = (f: string): boolean =>
    /^(server\/.*\.tsx?|pipeline\/(?!tests\/|\.venv\/).*\.py)$/.test(f) && !/\.test\.tsx?$/.test(f);
  for (const f of files.filter(logScope)) {
    const text = readText(REPO_ROOT, f);
    if (text !== null) findings.push(...checkLogTemplates(f, text, isSensitiveKey));
  }
  return findings;
}

function content(files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files.filter(isContentScope)) {
    const text = readText(REPO_ROOT, f);
    if (text !== null) findings.push(...checkContent(f, text));
  }
  return findings;
}

function fonts(files: readonly string[]): Finding[] {
  const dir = join(REPO_ROOT, FONT_DIR);
  const names = existsSync(dir) ? readdirSync(dir) : [];
  const findings = checkFontFolder(names, (name) => readText(dir, name));
  const fontFiles = new Set(names);
  for (const f of files.filter(isFontScope)) {
    const text = readText(REPO_ROOT, f);
    if (text !== null) findings.push(...checkFontReferences(f, text, fontFiles));
  }
  findings.push(...checkCspFonts({ base: buildCsp(), spa: buildCsp({ turnstile: true, inlineStyles: true }) }));
  return findings;
}

function workflows(files: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  for (const f of files.filter((x) => /^\.github\/workflows\/.*\.ya?ml$/.test(x))) {
    const text = readText(REPO_ROOT, f);
    if (text !== null) findings.push(...checkWorkflow(f, text));
  }
  return findings;
}

async function main(argv: readonly string[]): Promise<number> {
  const which = argv[0] ?? "all";
  const files = listRepoFiles();
  const runners: Record<string, () => Promise<Finding[]> | Finding[]> = {
    secrets: () => secrets(files),
    config,
    sensitive: () => sensitive(files),
    content: () => content(files),
    workflows: () => workflows(files),
    fonts: () => fonts(files),
  };
  let findings: Finding[] = [];
  if (which === "deploy-gate") {
    const i = argv.indexOf("--env");
    const envName = i >= 0 ? (argv[i + 1] ?? "") : "production";
    findings = [
      ...checkNoPlaceholders(APP_CONFIG, await readWranglerConfig(APP_CONFIG), envName),
      ...(envName === "production" ? checkNoPlaceholders(BACKUP_CONFIG, await readWranglerConfig(BACKUP_CONFIG), envName) : []),
    ];
  } else if (which === "all") {
    for (const run of Object.values(runners)) findings.push(...(await run()));
  } else if (runners[which]) {
    findings = await runners[which]();
  } else {
    console.error(`unknown check "${which}"`);
    return 2;
  }
  for (const f of findings) console.error(`[${f.check}] ${f.file}${f.line ? `:${f.line}` : ""} ${f.message}`);
  console.log(findings.length === 0 ? `ok: ${which}` : `${findings.length} finding(s) in ${which}`);
  return findings.length === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
