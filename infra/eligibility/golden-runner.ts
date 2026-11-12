import { EligibilityResultSchema, type EligibilityResult, type EligibilityRuleSet } from "../../shared/contracts/eligibility";
import type { EvalContext } from "../../shared/eligibility/context";
import { GoldenCasesFileSchema, GoldenRuleSetsFileSchema, type GoldenCase, type GoldenCasesFile, type GoldenRuleSetsFile } from "../../shared/eligibility/golden/schema";
import { ENGINE_VERSION, computeRuleSetHash, evaluateEligibility, parseRuleSet } from "../../shared/eligibility/index";

/**
 * Server-safe golden runner for shared/eligibility. One implementation, run wherever the server
 * engine runs: Node (the release gate script and infra tests) and workerd (the Workers Vitest
 * project). It only ever calls `evaluateEligibility` from the server-safe entry point; it never
 * imports shared/eligibility/sensitive.ts and never reads a case's device answers, so a case with
 * a `device` block is checked through its redacted twin only.
 *
 * Checks per case:
 * 1. expectation: for cases that list `runtime` (and so carry no device answers), the result
 *    matches the hand-labelled tuple: verdict, status, per-rule verdicts, reason codes, missing
 *    fields, pending items (as a set) and basedOnListedRequirements;
 * 2. redacted twin (device cases): never contradicts the labelled verdict, sensitive rules and
 *    attestations stay unknown, every other rule agrees with the label;
 * 3. contract: the result parses with EligibilityResultSchema;
 * 4. monotone: forgetting any one profile answer never flips met <-> not_met;
 * 5. order: reversing rules, groups and attestations changes nothing;
 * 6. parity: when a snapshot of Node results is given, the whole result is deep-equal to it.
 * Per rule set: the stored hash matches the canonical hash.
 */

export type GoldenRuntime = "node" | "workerd";

export interface GoldenInput {
  readonly cases: unknown;
  readonly ruleSets: unknown;
  /** Node results keyed by case id (pipeline/novus_eligibility/data/node-results.json `results`). */
  readonly snapshot?: Readonly<Record<string, unknown>>;
}

export interface GoldenReport {
  readonly runtime: GoldenRuntime;
  readonly engineVersion: string;
  readonly cases: number;
  readonly expectationsChecked: number;
  readonly twinsChecked: number;
  readonly ruleSets: number;
  readonly failures: readonly string[];
}

interface Loaded {
  readonly casesFile: GoldenCasesFile;
  readonly ruleSetsFile: GoldenRuleSetsFile;
  readonly ruleSets: ReadonlyMap<string, EligibilityRuleSet>;
}

export function loadGoldenFiles(input: Pick<GoldenInput, "cases" | "ruleSets">): Loaded {
  const casesFile = GoldenCasesFileSchema.parse(input.cases);
  const ruleSetsFile = GoldenRuleSetsFileSchema.parse(input.ruleSets);
  const ruleSets = new Map<string, EligibilityRuleSet>();
  for (const [key, entry] of Object.entries(ruleSetsFile.ruleSets)) ruleSets.set(key, parseRuleSet(entry.ruleSet));
  return { casesFile, ruleSetsFile, ruleSets };
}

function semverAtLeast(have: string, need: string): boolean {
  const a = have.split(".").map(Number);
  const b = need.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

type Profile = Parameters<typeof evaluateEligibility>[1];

/** Server-safe evaluation of a golden case (never with device answers). */
export function evaluateGoldenCase(loaded: Loaded, c: GoldenCase, override?: { profile?: Record<string, unknown>; ruleSet?: EligibilityRuleSet | null }): EligibilityResult {
  let ruleSet: EligibilityRuleSet | null = null;
  if (override && "ruleSet" in override) ruleSet = override.ruleSet ?? null;
  else if (c.ruleSet !== null) {
    const found = loaded.ruleSets.get(c.ruleSet);
    if (!found) throw new Error(`unknown rule set ${c.ruleSet}`);
    ruleSet = found;
  }
  const context = loaded.casesFile.contexts[c.context];
  if (!context) throw new Error(`unknown context ${c.context}`);
  return evaluateEligibility(ruleSet, (override?.profile ?? c.profile) as Profile, { asOf: c.asOf, context: context as unknown as EvalContext });
}

/** Node results for every case, keyed by id: the cross-runtime parity snapshot. */
export function goldenSnapshot(input: Pick<GoldenInput, "cases" | "ruleSets">): Record<string, EligibilityResult> {
  const loaded = loadGoldenFiles(input);
  const out: Record<string, EligibilityResult> = {};
  for (const c of loaded.casesFile.cases) out[c.id] = evaluateGoldenCase(loaded, c);
  return out;
}

const verdicts = (r: EligibilityResult): Record<string, string> => Object.fromEntries(r.rules.map((x) => [x.ruleId, x.verdict]));
const flips = (a: string | undefined, b: string | undefined): boolean => (a === "met" && b === "not_met") || (a === "not_met" && b === "met");

/** Structural equality that keeps JSON types apart (true is not 1). */
export function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameJsonValue(v, b[i]));
  const oa = a as Record<string, unknown>;
  const ob = b as Record<string, unknown>;
  const ka = Object.keys(oa).filter((k) => oa[k] !== undefined).sort();
  const kb = Object.keys(ob).filter((k) => ob[k] !== undefined).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameJsonValue(oa[k], ob[k]));
}

function sameRecord(a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>): boolean {
  return sameJsonValue(a, b);
}

function checkExpectation(c: GoldenCase, r: EligibilityResult, fail: (msg: string) => void): void {
  const e = c.expect;
  if (r.verdict !== e.verdict) fail(`verdict ${r.verdict}, expected ${e.verdict}`);
  if (r.status !== e.status) fail(`status ${r.status}, expected ${e.status}`);
  if (!sameRecord(verdicts(r), e.rules)) fail(`rule verdicts ${JSON.stringify(verdicts(r))}, expected ${JSON.stringify(e.rules)}`);
  const codes = Object.fromEntries(r.rules.map((x) => [x.ruleId, x.reasonCode]));
  if (!sameRecord(codes, e.reasonCodes)) fail(`reason codes ${JSON.stringify(codes)}, expected ${JSON.stringify(e.reasonCodes)}`);
  for (const rule of r.rules) {
    const want = e.missingFields?.[rule.ruleId] ?? [];
    if (!sameJsonValue(rule.missingFields, want)) fail(`${rule.ruleId} missing fields ${JSON.stringify(rule.missingFields)}, expected ${JSON.stringify(want)}`);
  }
  const key = (p: { id: string; kind: string; resolver: string; sensitive: boolean }): string => `${p.id}|${p.kind}|${p.resolver}|${p.sensitive}`;
  const got = r.pending.map(key).sort();
  const want = e.pending.map(key).sort();
  if (!sameJsonValue(got, want)) fail(`pending ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  if (r.basedOnListedRequirements !== e.basedOnListedRequirements) fail(`basedOnListedRequirements ${r.basedOnListedRequirements}`);
  if (r.asOf !== c.asOf) fail(`asOf ${r.asOf}`);
  if (r.sensitiveEvaluated) fail("sensitiveEvaluated is true on the server path");
}

function checkTwin(c: GoldenCase, twin: EligibilityResult, ruleSet: EligibilityRuleSet | null, fail: (msg: string) => void): void {
  if (flips(c.expect.verdict, twin.verdict)) fail(`redacted twin says ${twin.verdict}, labelled ${c.expect.verdict}`);
  for (const r of twin.rules) {
    if (r.sensitive || r.group === "attestations") {
      if (r.verdict !== "unknown") fail(`${r.ruleId} is ${r.verdict} without device answers`);
      if (r.reasonCode !== "SENSITIVE_ON_DEVICE" && r.reasonCode !== "ATTESTATION_ON_DEVICE") fail(`${r.ruleId} reason ${r.reasonCode} without device answers`);
    } else if (r.verdict !== c.expect.rules[r.ruleId]) {
      fail(`${r.ruleId} is ${r.verdict} in the redacted twin, ${String(c.expect.rules[r.ruleId])} with device answers`);
    }
  }
  const deviceOnly = (ruleSet?.rules.some((r) => r.sensitive) ?? false) || (ruleSet?.attestations.length ?? 0) > 0;
  if (deviceOnly && twin.verdict === "met") fail("redacted twin is met although device-only rules exist");
}

export function runGoldenCases(input: GoldenInput, runtime: GoldenRuntime): GoldenReport {
  const failures: string[] = [];
  const loaded = loadGoldenFiles(input);
  const { casesFile, ruleSetsFile } = loaded;
  if (!semverAtLeast(ENGINE_VERSION, casesFile.engineMin)) failures.push(`engine ${ENGINE_VERSION} is older than the files' engineMin ${casesFile.engineMin}`);

  for (const [key, entry] of Object.entries(ruleSetsFile.ruleSets)) {
    const parsed = loaded.ruleSets.get(key) as EligibilityRuleSet;
    const hash = computeRuleSetHash(parsed);
    if (hash !== entry.expectHash) failures.push(`rule set ${key}: hash ${hash}, expected ${entry.expectHash}`);
  }

  const ids = new Set<string>();
  let expectationsChecked = 0;
  let twinsChecked = 0;
  for (const c of casesFile.cases) {
    const fail = (msg: string): void => {
      failures.push(`case ${c.id} [${runtime}]: ${msg}`);
    };
    if (ids.has(c.id)) fail("duplicate case id");
    ids.add(c.id);
    const ruleSet = c.ruleSet === null ? null : (loaded.ruleSets.get(c.ruleSet) ?? null);
    if (c.ruleSet !== null && !ruleSet) {
      fail(`unknown rule set ${c.ruleSet}`);
      continue;
    }
    let result: EligibilityResult;
    try {
      result = evaluateGoldenCase(loaded, c);
    } catch (err) {
      fail(`threw ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (c.device) {
      twinsChecked += 1;
      checkTwin(c, result, ruleSet, fail);
    } else if (c.runtimes.includes(runtime)) {
      expectationsChecked += 1;
      checkExpectation(c, result, fail);
    }

    const contract = EligibilityResultSchema.safeParse(result);
    if (!contract.success) fail(`result breaks the contract at ${contract.error.issues[0]?.path.join(".") ?? "?"}`);

    const before = verdicts(result);
    for (const key of Object.keys(c.profile)) {
      const profile = { ...c.profile };
      delete profile[key];
      const less = evaluateGoldenCase(loaded, c, { profile });
      if (flips(result.verdict, less.verdict)) fail(`forgetting ${key} flips the verdict`);
      for (const r of less.rules) if (flips(before[r.ruleId], r.verdict)) fail(`forgetting ${key} flips ${r.ruleId}`);
    }

    if (ruleSet) {
      const reversed: EligibilityRuleSet = {
        ...ruleSet,
        rules: [...ruleSet.rules].reverse(),
        attestations: [...ruleSet.attestations].reverse(),
        anyOf: [...ruleSet.anyOf].reverse(),
      };
      const again = evaluateGoldenCase(loaded, c, { ruleSet: reversed });
      if (again.verdict !== result.verdict || again.status !== result.status || !sameRecord(verdicts(again), before)) fail("result depends on rule order");
    }

    if (input.snapshot) {
      const want = input.snapshot[c.id];
      if (want === undefined) fail("missing from the Node snapshot");
      else if (!sameJsonValue(JSON.parse(JSON.stringify(result)), want)) fail("differs from the Node snapshot");
    }
  }
  if (input.snapshot) {
    for (const id of Object.keys(input.snapshot)) if (!ids.has(id)) failures.push(`snapshot has unknown case ${id}`);
  }

  return {
    runtime,
    engineVersion: ENGINE_VERSION,
    cases: casesFile.cases.length,
    expectationsChecked,
    twinsChecked,
    ruleSets: Object.keys(ruleSetsFile.ruleSets).length,
    failures,
  };
}
