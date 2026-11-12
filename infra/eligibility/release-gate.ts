import { runBoundaryGate, type BoundaryReport, type BoundaryTarget } from "./boundary";
import { runGoldenCases, type GoldenInput, type GoldenReport, type GoldenRuntime } from "./golden-runner";

/**
 * The eligibility release gate: the golden cases (with the Node snapshot when given) plus the
 * generated boundary profiles over every rule set a release ships. Pure and synchronous, with no
 * file or network access, so it runs in the CI script (infra/scripts/release-gates.ts) and can run
 * inside the Worker's release.build (server/services/release releaseGates) unchanged.
 *
 * Reasons name gates, case ids and rule-set labels only (registry facts), never student data.
 */

export interface EligibilityGateInput {
  readonly golden: GoldenInput;
  readonly targets: readonly BoundaryTarget[];
  /** Evaluation date for boundary profiles (the release date), YYYY-MM-DD. */
  readonly asOf: string;
  readonly runtime?: GoldenRuntime;
}

export interface EligibilityGateResult {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  readonly golden: GoldenReport;
  readonly boundary: BoundaryReport;
}

/** At most this many reasons are reported per gate; the count of the rest is appended. */
const MAX_REASONS = 20;

function capped(gate: string, failures: readonly string[]): string[] {
  const head = failures.slice(0, MAX_REASONS).map((f) => `${gate}: ${f}`);
  if (failures.length > MAX_REASONS) head.push(`${gate}: and ${failures.length - MAX_REASONS} more`);
  return head;
}

export function eligibilityReleaseGate(input: EligibilityGateInput): EligibilityGateResult {
  const golden = runGoldenCases(input.golden, input.runtime ?? "node");
  const boundary = runBoundaryGate(input.targets, input.asOf);
  const reasons = [...capped("eligibility golden cases", golden.failures), ...capped("eligibility boundary profiles", boundary.failures)];
  if (golden.expectationsChecked === 0) reasons.push("eligibility golden cases: no case was checked");
  return { ok: reasons.length === 0, reasons, golden, boundary };
}
