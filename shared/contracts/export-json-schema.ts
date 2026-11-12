/**
 * Writes JSON Schema files for the Python pipeline to shared/contracts/json-schema/.
 *
 *   npx tsx shared/contracts/export-json-schema.ts           # write
 *   npx tsx shared/contracts/export-json-schema.ts --check   # fail if the committed files are stale
 *
 * The pipeline generates pydantic models from these files, so a contract change shows up as a
 * diff here and CI can fail on drift.
 *
 * This file sits under shared/, which both the browser and Worker tsconfigs include and neither
 * loads Node types for, so Node APIs are imported dynamically behind minimal local interfaces.
 */
import { toJsonSchema } from "./json-schema";
import { JSON_SCHEMA_EXPORTS, OUTPUT_MODE_EXPORTS, type JsonSchemaExportName } from "./schema-registry";

interface NodeFs {
  mkdirSync(path: string, opts: { recursive: boolean }): unknown;
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: "utf8"): string;
  rmSync(path: string): void;
  writeFileSync(path: string, data: string): void;
}
interface NodePath {
  join(...parts: string[]): string;
  dirname(path: string): string;
}
interface NodeUrl {
  fileURLToPath(url: string): string;
}
interface NodeProcess {
  argv: string[];
  exit(code: number): never;
}

/** Renders every exported schema to file name -> JSON text (pure; used by tests and the CLI). */
export function renderAll(): Map<string, string> {
  const files = new Map<string, string>();
  const names = (Object.keys(JSON_SCHEMA_EXPORTS) as JsonSchemaExportName[]).sort();
  for (const name of names) {
    const schema = toJsonSchema(JSON_SCHEMA_EXPORTS[name], {
      title: name,
      id: `novus/${name}.json`,
      mode: OUTPUT_MODE_EXPORTS.has(name) ? "output" : "input",
    });
    files.set(`${name}.json`, `${JSON.stringify(schema, null, 2)}\n`);
  }
  files.set("index.json", `${JSON.stringify({ schemas: names.map((n) => `${n}.json`) }, null, 2)}\n`);
  return files;
}

async function main(): Promise<void> {
  const fs = (await import("node:fs" as string)) as NodeFs;
  const path = (await import("node:path" as string)) as NodePath;
  const url = (await import("node:url" as string)) as NodeUrl;
  const proc = (globalThis as unknown as { process: NodeProcess }).process;

  const here = url.fileURLToPath((import.meta as unknown as { url: string }).url);
  const outDir = path.join(path.dirname(here), "json-schema");
  const files = renderAll();

  if (proc.argv.includes("--check")) {
    const stale = [...files.keys()].filter((file) => {
      try {
        return fs.readFileSync(path.join(outDir, file), "utf8") !== files.get(file);
      } catch {
        return true;
      }
    });
    if (stale.length > 0) {
      console.error(`JSON Schema out of date: ${stale.join(", ")}. Run: npx tsx shared/contracts/export-json-schema.ts`);
      proc.exit(1);
    }
    console.log(`JSON Schema up to date (${files.size} files).`);
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const existing of fs.readdirSync(outDir)) {
    if (existing.endsWith(".json") && !files.has(existing)) fs.rmSync(path.join(outDir, existing));
  }
  for (const [file, text] of files) fs.writeFileSync(path.join(outDir, file), text);
  console.log(`Wrote ${files.size} JSON Schema files to ${outDir}`);
}

const proc = (globalThis as unknown as { process?: NodeProcess }).process;
const entry = proc?.argv[1] ?? "";
if (/export-json-schema\.(ts|js|mjs)$/.test(entry)) {
  main().catch((err: unknown) => {
    console.error(err);
    proc?.exit(1);
  });
}
