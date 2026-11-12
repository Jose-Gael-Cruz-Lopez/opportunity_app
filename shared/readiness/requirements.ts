import { LEAD_TIME_TABLE, READINESS_CONFIG } from "./config";
import { epochDayOf, isoFromEpochDay, minDate, type IsoDate } from "./calendar";
import type { ScheduleTask } from "./schedule";
import type { EligibilityResult } from "../contracts/eligibility";
import type { EvidenceQuote } from "../contracts/evidence";
import type { ChecklistItem, RequirementState, StartSeverity } from "../contracts/readiness";
import type { RequirementKind } from "../taxonomy";

/**
 * Part 2, the requirements checklist: what the program asks for, what the student already has,
 * and the latest date to start each open item.
 *
 *   taskDue(r)      = min(effective deadline, r's own deadline) − leadDays(r)
 *   isolated(r)     = taskDue(r) − ceil(effortHours(r) / hoursPerDay)            (plan 7.4.2)
 *   startBy(r)      = min(isolated(r), capacity-aware latest start from backwardFill)
 *   severity(r)     = late if today > startBy; soon if startBy − today ≤ 14 d; else planned
 *   prepDays(cycle) = max over curated r of leadDays(r) + ceil(effortHours(r) / hoursPerDay)
 */

export interface RequirementLike {
  readonly id: string;
  readonly kind: RequirementKind;
  /** The official wording, short. */
  readonly label: string;
  readonly detail?: string | null;
  readonly quantity?: number;
  /** Curator override of the total student hours for this requirement. */
  readonly effortHours?: number | null;
  /** Curator override of the lead days. */
  readonly leadTimeDays?: number | null;
  /** The requirement's own deadline (for example, letters due before the application). */
  readonly deadlineId?: string | null;
  readonly evidence?: EvidenceQuote | null;
}

export type ProgressState = "in_progress" | "met" | "not_applicable";

export interface ProgressEntry {
  /** `req:{requirementId}` or `kind:{requirementKind}` for items reused across programs. */
  readonly subjectKey: string;
  readonly state: ProgressState;
}

/** Kinds whose progress carries across programs (one résumé serves every application). */
export const REUSABLE_KINDS: ReadonlySet<RequirementKind> = new Set<RequirementKind>(["resume", "transcript"]);

export function progressMap(entries: readonly ProgressEntry[] | undefined): Map<string, ProgressState> {
  const map = new Map<string, ProgressState>();
  for (const e of entries ?? []) map.set(e.subjectKey, e.state);
  return map;
}

export function requirementQuantity(r: RequirementLike): number {
  const q = r.quantity ?? 1;
  return Number.isFinite(q) ? Math.max(1, Math.round(q)) : 1;
}

/** Total student hours for a requirement (count included); null for informational kinds. */
export function effortHoursFor(r: RequirementLike): number | null {
  if (r.effortHours !== null && r.effortHours !== undefined && Number.isFinite(r.effortHours)) return Math.max(0, r.effortHours);
  const perUnit = LEAD_TIME_TABLE[r.kind].effortHoursPerUnit;
  return perUnit === null ? null : perUnit * requirementQuantity(r);
}

export interface LeadContext {
  /** True when the effective deadline is already the campus one. */
  readonly campusScoped: boolean;
  readonly nominationGated: boolean;
}

/** Third-party lead days; campus nomination runs to the campus deadline. */
export function leadDaysFor(r: RequirementLike, ctx: LeadContext = { campusScoped: true, nominationGated: false }): number | null {
  if (r.leadTimeDays !== null && r.leadTimeDays !== undefined && Number.isFinite(r.leadTimeDays)) return Math.max(0, Math.round(r.leadTimeDays));
  if (r.kind === "campus_nomination") return ctx.campusScoped ? 0 : READINESS_CONFIG.campus.l80Days;
  return LEAD_TIME_TABLE[r.kind].leadDays;
}

/** The comfortable lead used for suggested dates (never shorter than the hard lead). */
export function targetLeadDaysFor(r: RequirementLike, ctx: LeadContext): number | null {
  const hard = leadDaysFor(r, ctx);
  if (hard === null) return null;
  let target = LEAD_TIME_TABLE[r.kind].targetLeadDays ?? hard;
  if (r.kind === "essay" && ctx.nominationGated) target = Math.max(target, READINESS_CONFIG.campus.reviewedEssayTargetLeadDays);
  if (r.kind === "campus_nomination") target = hard;
  return Math.max(hard, target);
}

/** Days needed for `effort` hours at `hoursPerDay`; a quarter-hour item still takes a day. */
export function effortDays(effortHours: number, hoursPerDay: number = READINESS_CONFIG.hoursPerDay): number {
  if (effortHours <= 0) return 0;
  return Math.ceil(effortHours / Math.max(1e-6, hoursPerDay) - 1e-9);
}

export function isolatedLatestStart(taskDue: IsoDate, effortHours: number, hoursPerDay: number = READINESS_CONFIG.hoursPerDay): IsoDate {
  return isoFromEpochDay(epochDayOf(taskDue) - effortDays(effortHours, hoursPerDay));
}

/**
 * Days before the deadline that the cycle's curated requirements need, prepared in parallel
 * (the plan's prepDays, which s06's start-by uses). Null, never zero, when nothing is curated.
 */
export function prepDays(
  requirements: readonly RequirementLike[],
  opts: { hoursPerDay?: number; campusScoped?: boolean; nominationGated?: boolean } = {},
): number | null {
  const hoursPerDay = opts.hoursPerDay ?? READINESS_CONFIG.hoursPerDay;
  const ctx: LeadContext = { campusScoped: opts.campusScoped ?? true, nominationGated: opts.nominationGated ?? false };
  let best: number | null = null;
  for (const r of requirements) {
    const effort = effortHoursFor(r);
    const lead = leadDaysFor(r, ctx);
    if (effort === null || lead === null) continue;
    const days = lead + effortDays(effort, hoursPerDay);
    best = best === null ? days : Math.max(best, days);
  }
  return best;
}

export function severityFor(startBy: IsoDate, today: IsoDate, soonWithinDays: number = READINESS_CONFIG.soonWithinDays): StartSeverity {
  if (today > startBy) return "late";
  return epochDayOf(startBy) - epochDayOf(today) <= soonWithinDays ? "soon" : "planned";
}

function progressFor(r: RequirementLike, progress: ReadonlyMap<string, ProgressState>): ProgressState | null {
  const own = progress.get(`req:${r.id}`);
  if (own) return own;
  if (REUSABLE_KINDS.has(r.kind)) return progress.get(`kind:${r.kind}`) ?? null;
  return null;
}

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
function countWord(n: number): string {
  return COUNT_WORDS[n] ?? String(n);
}

/** Plain words for a gap, as the checklist and next actions show it. */
export function gapText(r: RequirementLike, state: RequirementState): string {
  const n = requirementQuantity(r);
  switch (r.kind) {
    case "recommendation":
      return n === 1 ? "Ask a recommender for a letter" : `Ask ${countWord(n)} recommenders for letters`;
    case "essay":
      return n === 1 ? "Write the essay" : `Write ${countWord(n)} essays`;
    case "campus_nomination":
      return "Apply for your campus nomination through your fellowship office";
    case "test_score":
      return "Take the test and send your scores";
    case "portfolio":
      return "Put together your portfolio";
    case "resume":
      return "Update your résumé";
    case "transcript":
      return n === 1 ? "Request your transcript" : `Request ${countWord(n)} transcripts`;
    case "interview":
      return "If you are invited, prepare for the interview";
    case "fee":
      return "Pay the application fee or ask about a fee waiver";
    case "coursework":
      return `Check that your coursework meets this requirement: ${r.label}`.slice(0, 300);
    case "gpa_floor":
      return state === "gap" ? "Your GPA band is below this requirement" : "Check this GPA requirement against your transcript";
    case "other":
      return `Complete: ${r.label}`.slice(0, 300);
  }
}

/** gpa_floor items read the eligibility result's GPA rules instead of re-deriving them. */
function gpaStateFromEligibility(eligibility: EligibilityResult | null): RequirementState {
  const rules = eligibility?.rules.filter((rule) => rule.dimension === "gpa") ?? [];
  if (rules.length === 0) return "unknown";
  if (rules.some((rule) => rule.verdict === "not_met")) return "gap";
  return rules.every((rule) => rule.verdict === "met") ? "met" : "unknown";
}

export interface RequirementAnalysis {
  readonly requirement: RequirementLike;
  readonly key: string;
  readonly state: RequirementState;
  readonly gap: string | null;
  readonly quantity: number;
  readonly effortHours: number | null;
  readonly leadDays: number | null;
  readonly targetLeadDays: number | null;
  readonly thirdParty: boolean;
  /** The day the student's own part must be done (deadline − lead); null when not schedulable. */
  readonly taskDue: IsoDate | null;
  /** The base date the lead counts back from (the effective or the requirement's own deadline). */
  readonly baseDate: IsoDate | null;
  readonly isolatedLatestStart: IsoDate | null;
  /** True when the student still has work to schedule for this item. */
  readonly open: boolean;
}

export interface AnalyzeContext extends LeadContext {
  readonly dueDate: IsoDate | null;
  /** Dates of requirement-specific deadlines, by deadline id. */
  readonly ownDeadlineDates: ReadonlyMap<string, IsoDate>;
  readonly progress: ReadonlyMap<string, ProgressState>;
  readonly eligibility: EligibilityResult | null;
  readonly hoursPerDay: number;
}

/** Gap analysis for one requirement: state, plain-words gap and the dates it counts back from. */
export function analyzeRequirement(r: RequirementLike, ctx: AnalyzeContext): RequirementAnalysis {
  const progress = progressFor(r, ctx.progress);
  let state: RequirementState;
  if (progress) state = progress;
  else if (r.kind === "gpa_floor") state = gpaStateFromEligibility(ctx.eligibility);
  else if (r.kind === "coursework" || r.kind === "interview") state = "unknown";
  else state = "gap";

  const effortHours = effortHoursFor(r);
  const leadDays = leadDaysFor(r, ctx);
  const targetLeadDays = targetLeadDaysFor(r, ctx);
  const ownDate = r.deadlineId ? ctx.ownDeadlineDates.get(r.deadlineId) ?? null : null;
  const baseDate = ctx.dueDate && ownDate ? minDate(ctx.dueDate, ownDate) : ctx.dueDate ?? ownDate;
  // Interviews come after selection, so they are not scheduled before the application deadline.
  const schedulable = r.kind !== "interview" && effortHours !== null && leadDays !== null && baseDate !== null;
  const open = state === "gap" || state === "in_progress";
  const taskDue = schedulable ? isoFromEpochDay(epochDayOf(baseDate!) - leadDays!) : null;
  return {
    requirement: r,
    key: r.id,
    state,
    gap: state === "gap" || state === "unknown" ? gapText(r, state) : null,
    quantity: requirementQuantity(r),
    effortHours,
    leadDays,
    targetLeadDays,
    thirdParty: LEAD_TIME_TABLE[r.kind].thirdParty,
    taskDue,
    baseDate,
    isolatedLatestStart: taskDue !== null && effortHours !== null ? isolatedLatestStart(taskDue, effortHours, ctx.hoursPerDay) : null,
    open,
  };
}

/** Scheduling tasks for the open, schedulable items of one program. */
export function scheduleTasks(items: readonly RequirementAnalysis[], scope: string): ScheduleTask[] {
  return items
    .filter((a) => a.open && a.taskDue !== null && (a.effortHours ?? 0) > 0)
    .map((a) => ({ id: `${scope}::${a.key}`, effortHours: a.effortHours!, due: a.taskDue! }));
}

/** The contract checklist item, with startBy = min(isolated, capacity-aware) for open items. */
export function toChecklistItem(
  a: RequirementAnalysis,
  opts: { today: IsoDate; filledLatestStart: IsoDate | null; closed: boolean },
): ChecklistItem {
  let startBy: IsoDate | null = null;
  if (a.open && a.isolatedLatestStart !== null) {
    startBy = opts.filledLatestStart !== null ? minDate(a.isolatedLatestStart, opts.filledLatestStart) : a.isolatedLatestStart;
  }
  return {
    key: a.key.slice(0, 80),
    requirementId: a.requirement.id,
    kind: a.requirement.kind,
    label: a.requirement.label.slice(0, 200),
    quantity: a.quantity,
    state: a.state,
    gap: a.gap,
    startBy,
    severity: startBy !== null && !opts.closed ? severityFor(startBy, opts.today) : null,
    effortHours: a.effortHours,
    leadDays: a.leadDays,
    evidence: a.requirement.evidence ?? null,
  };
}
