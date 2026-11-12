import type { EligibilityPending, EligibilityResult, EligibilityRuleResult } from "../contracts/eligibility";
import type { EvidenceQuote } from "../contracts/evidence";

/**
 * Part 1: eligibility. Readiness shows the evaluator's EligibilityResult unchanged (so the
 * browser, the Worker and MCP agree) and adds only a summary for copy and next actions. It never
 * re-evaluates a rule, and it never sees a SensitiveAnswer: in the browser, sensitive rules
 * arrive already evaluated; on the server they stay unknown with resolver "student".
 */

export interface RuleLine {
  readonly ruleId: string;
  readonly dimension: string;
  readonly reason: string;
  readonly officialText: string;
  readonly sensitive: boolean;
  readonly evidence: EvidenceQuote | null;
}

export interface EligibilitySummary {
  readonly status: EligibilityResult["status"];
  readonly verdict: EligibilityResult["verdict"];
  /** One sentence for the panel header. */
  readonly headline: string;
  readonly met: readonly RuleLine[];
  readonly notMet: readonly RuleLine[];
  readonly unknown: readonly RuleLine[];
  /** Open items the student can resolve ("Eligible if ..."), sensitive ones answered on the device. */
  readonly studentToResolve: readonly EligibilityPending[];
  /**
   * How many separate conditions studentToResolve stands for: an unresolved anyOf group counts
   * once, because one member is enough (and members can exclude each other).
   */
  readonly studentConditions: number;
  /** Open items Novus has not checked yet ("see the official page"). */
  readonly novusToResolve: readonly EligibilityPending[];
  readonly basedOnListedRequirements: boolean;
}

function line(r: EligibilityRuleResult): RuleLine {
  return {
    ruleId: r.ruleId,
    dimension: r.dimension,
    reason: r.reason,
    officialText: r.officialText,
    sensitive: r.sensitive,
    evidence: r.evidence,
  };
}

function byRuleId(a: RuleLine, b: RuleLine): number {
  return a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0;
}

export function summarizeEligibility(result: EligibilityResult): EligibilitySummary {
  const met = result.rules.filter((r) => r.verdict === "met").map(line).sort(byRuleId);
  const notMet = result.rules.filter((r) => r.verdict === "not_met").map(line).sort(byRuleId);
  const unknown = result.rules.filter((r) => r.verdict === "unknown").map(line).sort(byRuleId);
  const pending = [...result.pending].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const studentToResolve = pending.filter((p) => p.resolver === "student");
  const novusToResolve = pending.filter((p) => p.resolver === "novus");
  const open = openConditions(result, studentToResolve);
  return {
    status: result.status,
    verdict: result.verdict,
    headline: headlineFor(result.status, notMet, open, novusToResolve.length, result.basedOnListedRequirements),
    met,
    notMet,
    unknown,
    studentToResolve,
    studentConditions: open.standalone + open.groups,
    novusToResolve,
    basedOnListedRequirements: result.basedOnListedRequirements,
  };
}

interface OpenConditions {
  /** Pending rules and attestations that must each apply. */
  readonly standalone: number;
  /** Unresolved anyOf groups, each satisfied by any one member. */
  readonly groups: number;
}

/**
 * Groups pending items by their anyOf group. The evaluator lists every unknown member of an
 * unresolved group as its own pending item; the rule results carry the group id, so the summary
 * can count the group once instead of asking the student to meet every alternative.
 */
function openConditions(result: EligibilityResult, pending: readonly EligibilityPending[]): OpenConditions {
  const groupOf = new Map<string, string>();
  for (const r of result.rules) if (r.group && r.group !== "all") groupOf.set(r.ruleId, r.group);
  const groups = new Set<string>();
  let standalone = 0;
  for (const p of pending) {
    const group = p.kind === "rule" ? groupOf.get(p.id) : undefined;
    if (group === undefined) standalone++;
    else groups.add(group);
  }
  return { standalone, groups: groups.size };
}

function conditionalHeadline(open: OpenConditions): string {
  const total = open.standalone + open.groups;
  if (total === 1) return open.groups === 1 ? "Eligible if one of these applies to you." : "Eligible if one more rule applies to you.";
  // With an anyOf group in the count, "rules" would overstate it: a group is met by one member.
  return open.groups > 0 ? `Eligible if ${total} more conditions apply to you.` : `Eligible if ${total} more rules apply to you.`;
}

function headlineFor(
  status: EligibilityResult["status"],
  notMet: readonly RuleLine[],
  studentOpen: OpenConditions,
  novusOpen: number,
  basedOnListed: boolean,
): string {
  switch (status) {
    case "eligible":
      return basedOnListed ? "You meet every requirement the program lists." : "You meet every eligibility rule Novus has checked.";
    case "not_eligible":
      return notMet[0] ? `Not eligible: ${notMet[0].reason}`.slice(0, 300) : "Not eligible under the official rules.";
    case "conditional":
      return conditionalHeadline(studentOpen);
    case "unknown":
      return novusOpen > 0 ? "Novus has not checked every rule yet: see the official page." : "Eligibility is not settled yet.";
  }
}

/**
 * The result to show when a program has no verified rule set yet: unknown, with one item that
 * Novus resolves ("see the official page"). It never reads "eligible".
 */
export function missingEligibilityResult(asOf: string): EligibilityResult {
  return {
    verdict: "unknown",
    status: "unknown",
    rules: [],
    pending: [
      {
        id: "rule-set-missing",
        kind: "rule_set_missing",
        dimension: null,
        sensitive: false,
        resolver: "novus",
        selfCheckText: "Novus has not checked this program's eligibility rules yet: see the official page.",
      },
    ],
    nomination: null,
    ruleSet: null,
    basedOnListedRequirements: false,
    asOf,
    sensitiveEvaluated: false,
  };
}
