import { renderGuardsSql } from "../guards";
import { buildSampleSeed } from "./build";
import { renderLookupsSql } from "./lookups";
import { SAMPLE_TODAY } from "./sample-data";
import { renderSeedSql } from "./statements";

/**
 * Prints generated SQL to stdout. Run with tsx (it resolves the repository's extensionless imports):
 *   npx tsx server/db/seed/cli.ts sample [--today 2026-11-11] [--reset]
 *   npx tsx server/db/seed/cli.ts lookups   # body of the lookups migration
 *   npx tsx server/db/seed/cli.ts guards    # body of the guards migration
 * infra/scripts/seed-local.ts wraps `sample` and applies it to the local D1.
 */

// Node globals, declared locally because the server tsconfig only loads Workers types.
declare const process: { argv: string[]; stdout: { write(text: string): void }; stderr: { write(text: string): void }; exitCode?: number };

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: readonly string[]): Promise<void> {
  const [command] = args;
  switch (command) {
    case "lookups":
      process.stdout.write(renderLookupsSql());
      return;
    case "guards":
      process.stdout.write(renderGuardsSql());
      return;
    case "sample": {
      const seed = await buildSampleSeed(flagValue(args, "--today") ?? SAMPLE_TODAY);
      process.stdout.write(renderSeedSql(seed, { reset: args.includes("--reset") }));
      return;
    }
    default:
      process.stderr.write("usage: cli.ts sample [--today YYYY-MM-DD] [--reset] | lookups | guards\n");
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
