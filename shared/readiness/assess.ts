import { bandLevelsFromProfile, type BandModel } from "./bands";
import { blackoutDaySet, defaultBlackouts, epochDayOf, isoFromEpochDay, maxDate, minDate, subtractAvailableDays, type BlackoutPeriod, type IsoDate } from "./calendar";
import { assessCompetitiveness } from "./competitiveness";
import { READINESS_ALGO_VERSION, READINESS_CONFIG } from "./config";
import { openPlanningDate, planDeadline, resolveEffectiveDeadline, type CampusLead, type DeadlineLike, type EffectiveDeadline } from "./deadline";
import { missingEligibilityResult, summarizeEligibility, type EligibilitySummary } from "./eligibility";
import { buildNextActionsDetailed, type NextActionReason, type OverloadSignal, type PlannedItem } from "./next-actions";
import { buildFunnel, type Funnel } from "./odds";
import {
  analyzeRequirement,
  progressMap,
  scheduleTasks,
  toChecklistItem,
  type AnalyzeContext,
  type ProgressEntry,
  type RequirementAnalysis,
  type RequirementLike,
} from "./requirements";
import { backwardFill, demandBoundCheck, levelledLoad, weeklyCapacity, type ScheduleTask } from "./schedule";
import { PRODUCT } from "../config/product";
import type { EligibilityResult, NominationProcess } from "../contracts/eligibility";
import type { ReadinessReport } from "../contracts/readiness";
import type { StageOdds } from "../contracts/registry";
import type { CountStage } from "../taxonomy";
import { parseIsoInstant, toIsoInstant } from "../time/iso";
import { isValidTimeZone, localDateIn } from "../time/zones";

/**
 * assessReadiness: the four parts, computed on read and never stored.
 *   1. eligibility     the evaluator's result, unchanged, plus a summary for copy
 *   2. requirements    gap analysis with start-by dates counted back from the effective deadline,
 *                      capacity-aware across every application the student is preparing
 *   3. competitiveness official counts, then a band only where an approved model passes its gates
 *   4. nextActions     dated steps linked to Roadmap items
 * Pure and deterministic: the clock is an input, nothing is fetched or stored, and the student
 * profile is read through an allowlist of non-sensitive fields (SensitiveAnswers never arrive here).
 */

export interface ReadinessProgramInput {
  readonly id: string;
  readonly slug: string;
  readonly sensitiveAudience?: boolean;
  /** Programs that do not select among applicants (first come, first served). */
  readonly nonCompetitive?: boolean;
  /** The program has no earlier cycles. */
  readonly newProgram?: boolean;
}

export interface ReadinessCycleInput {
  readonly id: string;
  readonly cycleKey: string;
  readonly opensOn?: IsoDate | null;
  readonly predictedOpensOn?: IsoDate | null;
}

/** The profile fields readiness may read; anything else on the object is ignored. */
export interface ReadinessProfileInput {
  readonly timeZone?: string | null;
  readonly institutionId?: string | null;
  readonly weeklyPrepHours?: number | null;
  readonly classYear?: string | null;
  readonly gpaBand?: string | null;
  readonly priorExperience?: readonly string[] | null;
}

/** Another application the student is preparing, so start-by dates account for shared hours. */
export interface TrackedWorkload {
  readonly id: string;
  readonly requirements: readonly RequirementLike[];
  /** Its effective deadline date for this student, when the caller already has it. */
  readonly deadlineDate?: IsoDate | null;
  /** Otherwise its deadlines, resolved here with the same rules. */
  readonly deadlines?: readonly DeadlineLike[];
  readonly ownCampusDeadline?: IsoDate | null;
  readonly nominationGated?: boolean;
}

export interface ReadinessInput {
  readonly program: ReadinessProgramInput;
  readonly cycle: ReadinessCycleInput;
  readonly deadlines: readonly DeadlineLike[];
  readonly requirements: readonly RequirementLike[];
  /** False shows "Requirements not yet checked by Novus: see the official page". */
  readonly requirementsChecked: boolean;
  /** shared/eligibility's result (status-agnostic on the server; may include on-device answers in the browser). */
  readonly eligibility: EligibilityResult | null;
  readonly nomination?: NominationProcess | null;
  readonly profile: ReadinessProfileInput | null;
  /** The student's private campus date from their TrackerItem. */
  readonly ownCampusDeadline?: IsoDate | null;
  readonly progress?: readonly ProgressEntry[];
  /** Official stage odds (official_publication rows only). */
  readonly stageOdds?: readonly StageOdds[];
  /** Banded verified-report count from shared/disclosure's release(). */
  readonly reportsBanded?: string | null;
  /** The approved band model for this program's type and stage (Phase 4). */
  readonly bandModel?: BandModel | null;
  readonly studentStage?: CountStage | null;
  readonly otherTracked?: readonly TrackedWorkload[];
  readonly campusLead?: CampusLead | null;
  /** s06's effectiveDeadline result, when the caller has it; otherwise it is resolved here. */
  readonly effectiveDeadline?: EffectiveDeadline | null;
  /** Epoch milliseconds or an ISO instant. */
  readonly now: number | string;
  /** The browser's zone, used when the profile has none. */
  readonly browserTimeZone?: string | null;
  readonly options?: {
    readonly maxNextActions?: number;
    readonly blackouts?: readonly BlackoutPeriod[];
    readonly methodologyUrl?: string | null;
  };
}

export interface ReadinessDetail {
  readonly report: ReadinessReport;
  readonly today: IsoDate;
  readonly timeZone: string;
  readonly effectiveDeadline: EffectiveDeadline | null;
  readonly eligibilitySummary: EligibilitySummary;
  /** Reason code per next-action id (copy and the AI explainer key on these). */
  readonly actionReasons: Readonly<Record<string, NextActionReason>>;
  /** The latest year's official funnel, stage by stage (program-level, for display and explainers). */
  readonly funnel: Funnel;
  readonly plan: {
    readonly weeklyHours: number;
    /** The smallest steady weekly load that fits every tracked deadline (a plan metric). */
    readonly neededWeeklyHours: number;
    readonly overload: OverloadSignal | null;
    /** Suggested (leveled, padded) start per checklist key. */
    readonly suggestedStart: Readonly<Record<string, IsoDate | null>>;
  };
}

function toEpochMs(now: number | string): number {
  if (typeof now === "number") return now;
  const ms = parseIsoInstant(now);
  if (ms === null) throw new RangeError("now must be epoch milliseconds or an ISO instant with a zone");
  return ms;
}

function studentZone(profile: ReadinessProfileInput | null, browser: string | null | undefined): string {
  if (profile?.timeZone && isValidTimeZone(profile.timeZone)) return profile.timeZone;
  if (browser && isValidTimeZone(browser)) return browser;
  return PRODUCT.fallbackTimeZone;
}

function weeklyHoursFor(profile: ReadinessProfileInput | null): number {
  const set = profile?.weeklyPrepHours;
  // Zero or unset means "not told"; planning against zero hours would make every date impossible.
  return set !== null && set !== undefined && set > 0 ? set : READINESS_CONFIG.capacity.defaultWeeklyHours;
}

function ownDeadlineDates(deadlines: readonly DeadlineLike[], zone: string, now: number, today: IsoDate): Map<string, IsoDate> {
  const map = new Map<string, IsoDate>();
  for (const d of deadlines) {
    const planned = planDeadline(d, zone, now);
    if (planned) map.set(d.id, openPlanningDate(planned, today));
  }
  return map;
}

/**
 * Planning dates never fall before today for a deadline that is still open. An approximate
 * deadline whose earliest plausible day has passed plans to its latest plausible day (the end of
 * the month or window) and keeps the passed bound in `earliestLikelyPassed`, so the report never
 * shows today as a deadline it does not know to be today.
 */
function openDate(effective: EffectiveDeadline | null, today: IsoDate): EffectiveDeadline | null {
  if (!effective) return null;
  const date = openPlanningDate(effective, today);
  if (date === effective.date) return effective;
  if (effective.approximate && date !== today) {
    return {
      ...effective,
      date,
      earliestLikelyPassed: effective.date,
      label: `${effective.label}: exact day not published; planning to the last likely day`,
    };
  }
  return { ...effective, date };
}

/** Suggested-plan tasks: padded effort and comfortable leads counted in available days. */
function suggestedTasks(items: readonly RequirementAnalysis[], scope: string, blackout: ReadonlySet<number>): ScheduleTask[] {
  const padding = READINESS_CONFIG.capacity.suggestedEffortPadding;
  return items
    .filter((a) => a.open && a.taskDue !== null && a.baseDate !== null && (a.effortHours ?? 0) > 0)
    .map((a) => {
      const lead = a.targetLeadDays ?? a.leadDays ?? 0;
      const due = a.thirdParty ? subtractAvailableDays(a.baseDate!, lead, blackout) : isoFromEpochDay(epochDayOf(a.baseDate!) - lead);
      return { id: `${scope}::${a.key}`, effortHours: a.effortHours! * padding, due: minDate(due, a.taskDue!) };
    });
}

/**
 * Tasks for the capacity metrics (demand bound and levelled load). An item whose comfortable
 * lead has already passed is still work the student must finish before the deadline itself, so
 * it counts against that date instead of dropping out (it already reads "late" on the checklist).
 */
function loadTasks(items: readonly RequirementAnalysis[], scope: string, today: IsoDate): ScheduleTask[] {
  const out: ScheduleTask[] = [];
  for (const a of items) {
    if (!a.open || a.taskDue === null || a.baseDate === null || !((a.effortHours ?? 0) > 0)) continue;
    const due = a.taskDue > today ? a.taskDue : a.baseDate;
    if (due > today) out.push({ id: `${scope}::${a.key}`, effortHours: a.effortHours!, due });
  }
  return out;
}

function analyzeAll(
  requirements: readonly RequirementLike[],
  ctx: AnalyzeContext,
): RequirementAnalysis[] {
  return requirements
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => analyzeRequirement(r, ctx));
}

/** The full computation, with the plan details the UI and the AI explainer can cite. */
export function assessReadinessDetailed(input: ReadinessInput): ReadinessDetail {
  const now = toEpochMs(input.now);
  const zone = studentZone(input.profile, input.browserTimeZone);
  const today = localDateIn(now, zone);
  const nomination = input.nomination ?? input.eligibility?.nomination ?? null;
  const nominationGated = nomination !== null || input.requirements.some((r) => r.kind === "campus_nomination");

  const resolved =
    input.effectiveDeadline ??
    resolveEffectiveDeadline({
      deadlines: input.deadlines,
      now,
      studentTimeZone: zone,
      studentInstitutionId: input.profile?.institutionId ?? null,
      ownCampusDeadline: input.ownCampusDeadline ?? null,
      nominationGated,
      campusLead: input.campusLead ?? null,
    });
  const effective = openDate(resolved, today);

  const eligibility = input.eligibility ?? missingEligibilityResult(today);
  const eligibilitySummary = summarizeEligibility(eligibility);
  const progress = progressMap(input.progress);
  const hoursPerDay = READINESS_CONFIG.hoursPerDay;

  const analyses = input.requirementsChecked
    ? analyzeAll(input.requirements, {
        dueDate: effective?.date ?? null,
        campusScoped: effective?.scope === "campus",
        nominationGated,
        ownDeadlineDates: ownDeadlineDates(input.deadlines, zone, now, today),
        progress,
        eligibility,
        hoursPerDay,
      })
    : [];

  // Other tracked applications share the same weekly hours.
  const others = (input.otherTracked ?? [])
    .filter((w) => w.id !== input.cycle.id)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((w) => {
      const gated = w.nominationGated ?? w.requirements.some((r) => r.kind === "campus_nomination");
      const other = w.deadlineDate
        ? { date: w.deadlineDate, scope: "national" as const }
        : resolveEffectiveDeadline({
            deadlines: w.deadlines ?? [],
            now,
            studentTimeZone: zone,
            studentInstitutionId: input.profile?.institutionId ?? null,
            ownCampusDeadline: w.ownCampusDeadline ?? null,
            nominationGated: gated,
          });
      if (!other || ("closed" in other ? other.closed : other.date < today)) return { id: w.id, analyses: [] as RequirementAnalysis[] };
      return {
        id: w.id,
        analyses: analyzeAll(w.requirements, {
          dueDate: "closed" in other ? openPlanningDate(other, today) : maxDate(other.date, today),
          campusScoped: other.scope === "campus",
          nominationGated: gated,
          ownDeadlineDates: new Map(),
          progress,
          eligibility: null,
          hoursPerDay,
        }),
      };
    });

  const weeklyHours = weeklyHoursFor(input.profile);
  const capacity = weeklyCapacity(weeklyHours);
  const scope = input.cycle.id;
  const hardTasks = [...scheduleTasks(analyses, scope), ...others.flatMap((o) => scheduleTasks(o.analyses, o.id))];
  const filled = backwardFill(hardTasks, { today, capacity });

  const firstYear = Number(today.slice(0, 4));
  const blackout = blackoutDaySet(input.options?.blackouts ?? defaultBlackouts(firstYear, firstYear + 3));
  const softTasks = [...suggestedTasks(analyses, scope, blackout), ...others.flatMap((o) => suggestedTasks(o.analyses, o.id, blackout))];
  const suggestedFill = backwardFill(softTasks, { today, capacity });

  const futureTasks = [...loadTasks(analyses, scope, today), ...others.flatMap((o) => loadTasks(o.analyses, o.id, today))];
  const demand = demandBoundCheck(futureTasks, { today, capacity });
  const load = levelledLoad(futureTasks, { today });
  const overload: OverloadSignal | null = demand.firstViolation
    ? { gapHours: demand.firstViolation.gapHours, due: demand.firstViolation.due, neededWeeklyHours: load.weeklyHoursRounded, weeklyHours }
    : null;

  const closed = effective?.closed ?? false;
  const opening = input.cycle.opensOn ?? input.cycle.predictedOpensOn ?? null;
  const suggestedStart: Record<string, IsoDate | null> = {};
  const planned: PlannedItem[] = analyses.map((analysis) => {
    const taskId = `${scope}::${analysis.key}`;
    const item = toChecklistItem(analysis, { today, filledLatestStart: filled.latestStart.get(taskId) ?? null, closed });
    let suggested = suggestedFill.latestStart.get(taskId) ?? null;
    if (suggested !== null && item.startBy !== null) {
      suggested = minDate(suggested, item.startBy);
      // Suggest no start before the cycle opens, unless waiting would pass the hard start-by date
      // (letters and drafts can begin before an application opens; urgency always wins).
      if (opening && opening > suggested && opening <= item.startBy) suggested = opening;
      suggested = maxDate(suggested, today);
      suggested = minDate(suggested, maxDate(item.startBy, today));
    }
    suggestedStart[item.key] = suggested;
    return { analysis, item, suggested };
  });

  const competitiveness = assessCompetitiveness({
    stageOdds: input.stageOdds ?? [],
    nominationGated,
    studentStage: input.studentStage ?? null,
    sensitiveAudience: input.program.sensitiveAudience ?? false,
    reportsBanded: input.reportsBanded ?? null,
    newProgram: input.program.newProgram ?? false,
    nonCompetitive: input.program.nonCompetitive ?? false,
    band: input.bandModel ? { model: input.bandModel, programId: input.program.id, levels: bandLevelsFromProfile(input.profile ?? {}) } : null,
    methodologyUrl: input.options?.methodologyUrl ?? null,
  });

  const next = buildNextActionsDetailed({
    programId: input.program.id,
    cycleKey: input.cycle.cycleKey,
    today,
    effective,
    nominationGated,
    requirementsChecked: input.requirementsChecked,
    planned,
    eligibility: eligibilitySummary,
    overload,
    max: input.options?.maxNextActions,
  });
  const nextActions = next.actions;

  const report: ReadinessReport = {
    programCycleId: input.cycle.id,
    programSlug: input.program.slug,
    cycleKey: input.cycle.cycleKey,
    algoVersion: READINESS_ALGO_VERSION,
    generatedAt: toIsoInstant(now),
    eligibility,
    requirements: {
      checked: input.requirementsChecked,
      items: planned.map((p) => p.item),
      effectiveDeadline: effective ? { date: effective.date, basis: effective.basis, scope: effective.scope, label: effective.label.slice(0, 200) } : null,
    },
    competitiveness,
    nextActions,
  };

  return {
    report,
    today,
    timeZone: zone,
    effectiveDeadline: effective,
    eligibilitySummary,
    actionReasons: next.reasons,
    funnel: buildFunnel(input.stageOdds ?? [], { nominationGated }),
    plan: { weeklyHours, neededWeeklyHours: load.weeklyHoursRounded, overload, suggestedStart },
  };
}

/** The ReadinessReport for one program cycle (see assessReadinessDetailed for the plan details). */
export function assessReadiness(input: ReadinessInput): ReadinessReport {
  return assessReadinessDetailed(input).report;
}
