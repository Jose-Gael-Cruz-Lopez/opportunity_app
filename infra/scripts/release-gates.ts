/**
 * Release build gates for eligibility (plan 06 6.12, 13 parity). A release must not ship unless
 * the golden cases agree in every runtime that evaluates them on the server side:
 *
 *   npx tsx infra/scripts/release-gates.ts                 all gates
 *   npx tsx infra/scripts/release-gates.ts --only node     one gate (node | workerd | python)
 *   npx tsx infra/scripts/release-gates.ts --rule-sets release-rule-sets.json --as-of 2026-11-11
 *
 * Gates:
 * - node: golden cases (labels, redacted twins, contract, monotonicity, order, hashes) against
 *   the committed Node snapshot, the generated Python data files are fresh, and the boundary
 *   profiles over the sample rule sets plus every rule set in --rule-sets (a JSON array of
 *   EligibilityRuleSet, or of { ruleSet, context?, label? });
 * - workerd: the same cases inside workerd (npx vitest run --config infra/vitest.workers.config.ts);
 * - python: pipeline/novus_eligibility's runner (python -m novus_eligibility golden), using
 *   $NOVUS_PYTHON or pipeline/.venv/bin/python.
 *
 * Exit 1 when any gate fails, 2 on bad usage. Output names gates, case ids and rule-set labels
 * only; the profiles are synthetic and no SensitiveAnswers exist on this path.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalContext } from "../../shared/eligibility/context";
import { parseRuleSet } from "../../shared/eligibility/index";
import type { BoundaryTarget } from "../eligibility/boundary";
import { loadGoldenFiles } from "../eligibility/golden-runner";
import { eligibilityReleaseGate } from "../eligibility/release-gate";
import { jsonText, nodeResultsFile, pythonCatalogue, PYTHON_DATA_DIR } from "../eligibility/snapshots";
import { REPO_ROOT } from "./checks/files";

const GATES = ["node", "workerd", "python"] as const;
type Gate = (typeof GATES)[number];

interface Options {
  only: Gate | null;
  ruleSetsFile: string | null;
  asOf: string;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function parseArgs(argv: readonly string[]): Options | string {
  const opts: Options = { only: null, ruleSetsFile: null, asOf: today() };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--only" && value && (GATES as readonly string[]).includes(value)) opts.only = value as Gate;
    else if (arg === "--rule-sets" && value) opts.ruleSetsFile = value;
    else if (arg === "--as-of" && value && /^\d{4}-\d{2}-\d{2}$/.test(value)) opts.asOf = value;
    else return `unknown or incomplete argument "${arg}"`;
    i++;
  }
  return opts;
}

/** Reads --rule-sets: an array of rule sets, or of { ruleSet, context?, label? }. */
export function readTargets(text: string): BoundaryTarget[] {
  const raw: unknown = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error("--rule-sets must hold a JSON array");
  return raw.map((item: unknown, i) => {
    const wrapper = item && typeof item === "object" && "ruleSet" in item ? (item as { ruleSet: unknown; context?: EvalContext; label?: unknown }) : null;
    const ruleSet = parseRuleSet(wrapper ? wrapper.ruleSet : item);
    const context = wrapper?.context ?? undefined;
    const label = typeof wrapper?.label === "string" ? wrapper.label : `rule-sets[${i}] ${ruleSet.id ?? "?"} v${ruleSet.version}`;
    return { ruleSet, context, label };
  });
}

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
}

function nodeGate(opts: Options): string[] {
  const cases = readJson("shared/eligibility/golden/cases.json");
  const ruleSets = readJson("shared/eligibility/golden/rule-sets.json");
  const reasons: string[] = [];

  for (const [name, value] of [["catalogue.json", pythonCatalogue()], ["node-results.json", nodeResultsFile({ cases, ruleSets })]] as const) {
    const rel = `${PYTHON_DATA_DIR}/${name}`;
    const path = join(REPO_ROOT, rel);
    if (!existsSync(path) || readFileSync(path, "utf8") !== jsonText(value)) {
      reasons.push(`${rel} is stale: UPDATE_GOLDEN=1 npx vitest run --config infra/vitest.config.ts infra/eligibility`);
    }
  }

  const snapshotPath = join(REPO_ROOT, PYTHON_DATA_DIR, "node-results.json");
  const snapshot = existsSync(snapshotPath) ? (JSON.parse(readFileSync(snapshotPath, "utf8")) as { results: Record<string, unknown> }).results : undefined;
  const loaded = loadGoldenFiles({ cases, ruleSets });
  const targets: BoundaryTarget[] = [...loaded.ruleSets.entries()].map(([label, ruleSet]) => ({ ruleSet, label: `sample ${label}` }));
  if (opts.ruleSetsFile) targets.push(...readTargets(readFileSync(opts.ruleSetsFile, "utf8")));

  const gate = eligibilityReleaseGate({ golden: { cases, ruleSets, snapshot }, targets, asOf: opts.asOf, runtime: "node" });
  console.log(
    `node: ${gate.golden.cases} golden cases (${gate.golden.expectationsChecked} labelled, ${gate.golden.twinsChecked} redacted twins), ` +
      `${gate.boundary.ruleSets} rule sets, ${gate.boundary.profiles} boundary evaluations`,
  );
  return [...reasons, ...gate.reasons];
}

function run(command: string, args: readonly string[], cwd: string): { ok: boolean; detail: string } {
  const res = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (res.error) return { ok: false, detail: res.error.message };
  return { ok: res.status === 0, detail: `exit ${String(res.status)}` };
}

function workerdGate(): string[] {
  const res = run(process.platform === "win32" ? "npx.cmd" : "npx", ["vitest", "run", "--config", "infra/vitest.workers.config.ts"], REPO_ROOT);
  return res.ok ? [] : [`workerd golden cases failed (${res.detail})`];
}

export function pythonCommand(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NOVUS_PYTHON) return env.NOVUS_PYTHON;
  const venv = join(REPO_ROOT, "pipeline", ".venv", "bin", "python");
  return existsSync(venv) ? venv : "python3";
}

function pythonGate(): string[] {
  const res = run(pythonCommand(), ["-m", "novus_eligibility", "golden"], join(REPO_ROOT, "pipeline"));
  return res.ok ? [] : [`python golden cases failed (${res.detail})`];
}

export function main(argv: readonly string[]): number {
  const opts = parseArgs(argv);
  if (typeof opts === "string") {
    console.error(opts);
    return 2;
  }
  const gates: Record<Gate, () => string[]> = { node: () => nodeGate(opts), workerd: workerdGate, python: pythonGate };
  const reasons: string[] = [];
  for (const name of opts.only ? [opts.only] : GATES) {
    try {
      reasons.push(...gates[name]().map((r) => `[${name}] ${r}`));
    } catch (err) {
      reasons.push(`[${name}] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const r of reasons) console.error(r);
  console.log(reasons.length === 0 ? `ok: eligibility release gates (${opts.only ?? GATES.join(", ")})` : `${reasons.length} release gate finding(s)`);
  return reasons.length === 0 ? 0 : 1;
}

if (process.argv[1] && /release-gates\.ts$/.test(process.argv[1])) process.exit(main(process.argv.slice(2)));
