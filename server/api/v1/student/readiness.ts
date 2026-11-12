import type {
  EligibilityPending,
  EligibilityResult,
  ReadinessReport,
  RequirementProgress,
  StudentProfile,
} from "@shared/contracts";
import { PRODUCT } from "@shared/config/product";
import { buildEvalContext, evaluateEligibility, renderReason, type InstitutionLike } from "@shared/eligibility";
import { assessReadinessDetailed, type ReadinessDetail, type TrackedWorkload } from "@shared/readiness";
import { isValidTimeZone, localDateIn } from "@shared/time";
import type { AiSourceInput } from "@server/ai";
import type { ReadinessSource, TrackedCycle } from "./ports";

/**
 * Server-side readiness for one program cycle. Deterministic code decides all four parts
 * (shared/eligibility, then shared/readiness); nothing here is stored. Eligibility runs on the
 * stored, non-sensitive profile only, so any rule that reads a status or identity answer stays
 * `unknown` and is marked "check privately on your device" (markPrivateChecks). The browser
 * re-evaluates those rules with on-device answers that never reach this Worker.
 */

/** Tracker statuses whose applications still need preparation hours. */
const PREPARING = new Set<TrackedCycle["item"]["status"]>(["interested", "applying"]);

/** At most this many other applications feed the capacity-aware start-by dates. */
export const MAX_OTHER_WORKLOADS = 8;

export interface ReadinessRequest {
  readonly source: ReadinessSource;
  readonly profile: StudentProfile;
  /** The student's tracker item for this cycle, when tracked (private campus date). */
  readonly trackerItem: TrackedCycle["item"] | null;
  readonly progress: readonly RequirementProgress[];
  /** Every tracked cycle; the one being assessed is skipped. */
  readonly tracked: readonly TrackedCycle[];
  readonly institution: InstitutionLike | null;
  readonly participates: boolean;
  readonly now: number;
  /** The browser's zone (`?tz=`), used only when the profile has none. */
  readonly browserTimeZone: string | null;
  readonly methodologyUrl: string | null;
}

/** Same precedence as shared/readiness: profile zone, then the browser's, then the product default. */
export function studentTimeZone(profile: Pick<StudentProfile, "timeZone"> | null, browser: string | null): string {
  if (profile?.timeZone && isValidTimeZone(profile.timeZone)) return profile.timeZone;
  if (browser && isValidTimeZone(browser)) return browser;
  return PRODUCT.fallbackTimeZone;
}

/** Other applications being prepared, so start-by dates account for hours they share. */
export function otherWorkloads(tracked: readonly TrackedCycle[], currentCycleId: string): TrackedWorkload[] {
  return tracked
    .filter((t) => t.cycle.id !== currentCycleId && PREPARING.has(t.item.status) && t.requirements.length > 0)
    .slice(0, MAX_OTHER_WORKLOADS)
    .map((t) => ({
      id: t.cycle.id,
      requirements: t.requirements,
      deadlines: t.deadlines,
      ownCampusDeadline: t.item.ownCampusDeadline,
      nominationGated: t.requirements.some((r) => r.kind === "campus_nomination") || t.deadlines.some((d) => d.kind === "nomination"),
    }));
}

/**
 * Normalizes every sensitive rule to "check privately". The server evaluator already returns
 * these as unknown with SENSITIVE_ON_DEVICE; this keeps the invariant even if a future evaluator
 * change were to word one differently, and adds a pending self-check entry when one is missing.
 * It never sets a verdict other than unknown, so the result still satisfies the contract's
 * "sensitive rules stay unknown unless evaluated on the device" refinement.
 */
export function markPrivateChecks(result: EligibilityResult): EligibilityResult {
  const rules = result.rules.map((rule) =>
    rule.sensitive
      ? {
          ...rule,
          verdict: "unknown" as const,
          reasonCode: "SENSITIVE_ON_DEVICE",
          reason: renderReason("SENSITIVE_ON_DEVICE", { officialText: rule.officialText }).slice(0, 400),
          resolver: "student" as const,
        }
      : rule,
  );
  const pendingIds = new Set(result.pending.map((p) => p.id));
  const extraPending: EligibilityPending[] = rules
    .filter((r) => r.sensitive && !pendingIds.has(r.ruleId))
    .map((r) => ({
      id: r.ruleId,
      kind: "rule",
      dimension: r.dimension,
      sensitive: true,
      resolver: "student",
      selfCheckText: renderReason("SENSITIVE_UNANSWERED", { officialText: r.officialText }).slice(0, 400),
    }));
  return { ...result, rules, pending: [...result.pending, ...extraPending], sensitiveEvaluated: false };
}

/** Rule ids the student must check privately on their device (for copy and tests). */
export function privateCheckRuleIds(report: Pick<ReadinessReport, "eligibility">): string[] {
  return report.eligibility.rules.filter((r) => r.sensitive).map((r) => r.ruleId);
}

/** Eligibility on the stored non-sensitive profile, with the deadlines and campus as context. */
export function evaluateServerEligibility(req: ReadinessRequest, asOf: string): EligibilityResult {
  const { source, institution } = req;
  const context = buildEvalContext({
    deadlines: source.deadlines,
    institution,
    participatingInstitutionIds: institution && req.participates ? [institution.id] : [],
    ownCampusDeadline: req.trackerItem?.ownCampusDeadline ?? null,
  });
  return markPrivateChecks(evaluateEligibility(source.ruleSet, req.profile, { asOf, context }));
}

/** The four-part report plus plan details (for the AI explainer's facts). */
export function computeReadiness(req: ReadinessRequest): ReadinessDetail {
  const zone = studentTimeZone(req.profile, req.browserTimeZone);
  const asOf = localDateIn(req.now, zone);
  const eligibility = evaluateServerEligibility(req, asOf);
  const { source } = req;
  return assessReadinessDetailed({
    program: {
      id: source.program.id,
      slug: source.program.slug,
      sensitiveAudience: source.program.sensitiveAudience,
      newProgram: source.program.newProgram,
    },
    cycle: {
      id: source.cycle.id,
      cycleKey: source.cycle.cycleKey,
      opensOn: source.cycle.opensOn,
      predictedOpensOn: source.cycle.predictedOpensOn,
    },
    deadlines: source.deadlines,
    requirements: source.requirements,
    requirementsChecked: source.requirementsChecked,
    eligibility,
    nomination: source.ruleSet?.nomination ?? null,
    profile: req.profile,
    ownCampusDeadline: req.trackerItem?.ownCampusDeadline ?? null,
    progress: req.progress,
    stageOdds: source.stageOdds,
    otherTracked: otherWorkloads(req.tracked, source.cycle.id),
    now: req.now,
    browserTimeZone: req.browserTimeZone,
    options: { methodologyUrl: req.methodologyUrl },
  });
}

/** True when the program's verified rules state a GPA criterion (the only time gpaBand may reach a prompt). */
export function statesGpaRule(source: ReadinessSource): boolean {
  return source.ruleSet?.rules.some((r) => r.dimension === "gpa") ?? false;
}

function recordUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/$/, "")}/programs/${slug}`;
}

function deadlineLine(d: ReadinessSource["deadlines"][number]): string | null {
  if (d.withdrawnAt) return null;
  const when = d.localDate ?? (d.windowStart && d.windowEnd ? `${d.windowStart} to ${d.windowEnd}` : d.precision);
  const time = d.localTime ? ` ${d.localTime}` : "";
  const zone = d.tzMode === "applicant_local" ? " (your local time)" : d.timeZone ? ` (${d.timeZone})` : "";
  const scope = d.scope === "campus" ? "campus " : "";
  const basis = d.basis === "official" ? "" : ` [${d.basis}]`;
  return `- ${scope}${d.kind.replace(/_/g, " ")}: ${when}${time}${zone}${basis}`;
}

/**
 * Assistant sources for one cycle: the Novus record first (deadlines as published, the curated
 * checklist, the official eligibility wording), then verbatim official excerpts. Public registry
 * facts only; nothing about the student.
 */
export function programSources(source: ReadinessSource, origin: string, opts: { essayOnly?: boolean } = {}): AiSourceInput[] {
  const { program, cycle } = source;
  const lines: string[] = [];
  if (program.isSample) lines.push("SAMPLE RECORD: invented for demonstration, not a real program.");
  lines.push(`${program.name}, offered by ${program.organizationName}. Cycle ${cycle.cycleKey}.`);
  if (program.summary) lines.push(program.summary);
  if (cycle.opensOn) lines.push(`Opens on ${cycle.opensOn}.`);
  const deadlineLines = source.deadlines.map(deadlineLine).filter((l): l is string => l !== null);
  if (deadlineLines.length > 0) lines.push("Deadlines:", ...deadlineLines);
  if (source.requirements.length > 0) {
    lines.push(source.requirementsChecked ? "Requirements (checked by Novus):" : "Requirements (not yet checked by Novus):");
    for (const r of source.requirements) {
      const qty = r.quantity > 1 ? ` x${r.quantity}` : "";
      const words = r.wordLimit ? ` (up to ${r.wordLimit} words)` : "";
      lines.push(`- ${r.label}${qty}${words}`);
    }
  }
  const rules = source.ruleSet?.rules ?? [];
  if (rules.length > 0) lines.push("Eligibility as officially stated:", ...rules.map((r) => `- ${r.officialText}`));

  const record: AiSourceInput = {
    kind: "novus_record",
    title: `${program.name}: Novus record`,
    url: recordUrl(origin, program.slug),
    programSlug: program.slug,
    text: lines.join("\n"),
    retrievedOn: null,
  };
  const excerpts: AiSourceInput[] = source.requirements
    .filter((r) => r.evidence?.quote && (!opts.essayOnly || r.kind === "essay"))
    .map((r) => ({
      kind: "program_page" as const,
      title: `${program.name}: ${r.label}`.slice(0, 200),
      url: r.evidence!.url,
      programSlug: program.slug,
      text: r.evidence!.quote!,
      retrievedOn: r.evidence!.retrievedOn,
    }));
  return [record, ...excerpts];
}
