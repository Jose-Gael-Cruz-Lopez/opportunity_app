import { READINESS_CONFIG } from "./config";
import { epochDayOf, isoFromEpochDay, maxDate, minDate, type IsoDate } from "./calendar";
import type { EffectiveDeadline } from "./deadline";
import type { EligibilitySummary } from "./eligibility";
import { gapText, severityFor, type RequirementAnalysis } from "./requirements";
import type { ChecklistItem, NextAction, StartSeverity } from "../contracts/readiness";

/**
 * Part 4: next actions. Dated steps built from campus-deadline steps, eligibility items the
 * student resolves, checklist gaps and the deadline itself, linked to the Roadmap.
 *
 * Dates: a gap action shows the suggested (leveled, padded) start, while its severity comes from
 * the hard latest start, so the two never disagree about urgency. Every date is clamped to
 * [today, deadline].
 *
 * Order (deterministic): the date shown, then severity (late, soon, planned), then source
 * (nomination steps first, because every other date rests on the campus deadline), then slack
 * (the hard latest start, plan 7.4.2), then the item's own deadline, then the id. Late items all
 * show today, so among them slack decides, which is the plan's "sorted by slack" rule.
 */

/** Why an action exists; copy and the AI explainer key on these, never on the label text. */
export const NEXT_ACTION_REASONS = [
  "NEXT_CYCLE",
  "CAMPUS_PASSED",
  "CAMPUS_ESTIMATE",
  "ELIGIBILITY_PRIVATE",
  "ELIGIBILITY_CONFIRM",
  "ELIGIBILITY_OFFICIAL",
  "REQUIREMENTS_OFFICIAL",
  "ASK_RECOMMENDER",
  "CHECK_RECOMMENDER",
  "REQUEST_TRANSCRIPT",
  "START_BY",
  "FINISH_STARTED",
  "OVERLOAD",
  "SUBMIT",
] as const;
export type NextActionReason = (typeof NEXT_ACTION_REASONS)[number];

/** Roadmap item keys allow 110 characters after the prefix (shared/contracts/roadmap ItemKeySchema). */
const ITEM_KEY_BODY_MAX = 110;

/** `apply:{programId}:{cycleKey}`, the Roadmap's Apply item for this cycle. */
export function applyItemKey(programId: string, cycleKey: string): string {
  return `apply:${`${programId}:${cycleKey}`.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, ITEM_KEY_BODY_MAX)}`;
}

/** `prep:{programId}:{cycleKey}:{subject}`, a Prepare item derived from a checklist entry. */
export function prepItemKey(programId: string, cycleKey: string, subject: string): string {
  return `prep:${`${programId}:${cycleKey}:${subject}`.replace(/[^A-Za-z0-9_.:-]/g, "-").slice(0, ITEM_KEY_BODY_MAX)}`;
}

export interface PlannedItem {
  readonly analysis: RequirementAnalysis;
  readonly item: ChecklistItem;
  /** The suggested start from the leveled, padded plan; null when not schedulable. */
  readonly suggested: IsoDate | null;
}

export interface OverloadSignal {
  /** Hours short at the first binding due date. */
  readonly gapHours: number;
  readonly due: IsoDate;
  /** The smallest steady weekly load that fits everything (YDS), rounded up to half hours. */
  readonly neededWeeklyHours: number;
  readonly weeklyHours: number;
}

export interface NextActionContext {
  readonly programId: string;
  readonly cycleKey: string;
  readonly today: IsoDate;
  readonly effective: EffectiveDeadline | null;
  readonly nominationGated: boolean;
  readonly requirementsChecked: boolean;
  readonly planned: readonly PlannedItem[];
  readonly eligibility: EligibilitySummary;
  readonly overload: OverloadSignal | null;
  readonly max?: number;
}

export interface NextActionsResult {
  readonly actions: NextAction[];
  /** Reason code per action id. */
  readonly reasons: Readonly<Record<string, NextActionReason>>;
}

interface Candidate {
  readonly action: NextAction;
  readonly reason: NextActionReason;
  /** The hard latest start behind the action (gap items), else its date. */
  readonly slack: IsoDate | null;
  /** The deadline the action serves. */
  readonly deadline: IsoDate | null;
}

const SOURCE_RANK: Record<NextAction["source"], number> = { nomination: 0, eligibility_unknown: 1, gap: 2, roadmap: 3, deadline: 4 };
const SEVERITY_RANK: Record<StartSeverity, number> = { late: 0, soon: 1, planned: 2 };

function compareNullableDates(a: IsoDate | null, b: IsoDate | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    compareNullableDates(a.action.dueOn, b.action.dueOn) ||
    (a.action.severity === null ? 3 : SEVERITY_RANK[a.action.severity]) - (b.action.severity === null ? 3 : SEVERITY_RANK[b.action.severity]) ||
    SOURCE_RANK[a.action.source] - SOURCE_RANK[b.action.source] ||
    compareNullableDates(a.slack, b.slack) ||
    compareNullableDates(a.deadline, b.deadline) ||
    (a.action.id < b.action.id ? -1 : a.action.id > b.action.id ? 1 : 0)
  );
}

function inProgressLabel(a: RequirementAnalysis): string {
  switch (a.requirement.kind) {
    case "recommendation":
      return a.quantity > 1 ? "Check that your recommenders have sent their letters" : "Check that your recommender has sent the letter";
    case "essay":
      return a.quantity > 1 ? "Finish your essay drafts" : "Finish the essay draft";
    case "resume":
      return "Finish your résumé";
    case "transcript":
      return "Confirm your transcript request went through";
    case "campus_nomination":
      return "Finish your campus nomination application";
    case "portfolio":
      return "Finish your portfolio";
    case "test_score":
      return "Send your test scores";
    default:
      return `Finish: ${a.requirement.label}`.slice(0, 200);
  }
}

const LEAD_WHO: Partial<Record<RequirementAnalysis["requirement"]["kind"], string>> = {
  recommendation: "Recommenders usually need",
  transcript: "Registrars usually need",
  essay: "Leave time for feedback:",
  campus_nomination: "Campus reviews usually need",
};

function gapDetail(a: RequirementAnalysis): string | null {
  const parts: string[] = [];
  if (a.leadDays !== null && a.leadDays > 0) {
    const who = LEAD_WHO[a.requirement.kind];
    parts.push(who ? `${who} about ${a.leadDays} days.` : `Allow about ${a.leadDays} days after your part.`);
  }
  if (a.effortHours !== null && a.effortHours >= 1) parts.push(`About ${Math.round(a.effortHours)} ${Math.round(a.effortHours) === 1 ? "hour" : "hours"} of your time.`);
  return parts.length > 0 ? parts.join(" ").slice(0, 400) : null;
}

function gapReason(a: RequirementAnalysis, state: ChecklistItem["state"]): NextActionReason {
  if (state === "in_progress") return a.requirement.kind === "recommendation" ? "CHECK_RECOMMENDER" : "FINISH_STARTED";
  if (a.requirement.kind === "recommendation") return "ASK_RECOMMENDER";
  if (a.requirement.kind === "transcript") return "REQUEST_TRANSCRIPT";
  return "START_BY";
}

/** Deadline-bounded date: never before today, never after the plan's deadline. */
function boundedDate(date: IsoDate, today: IsoDate, deadline: IsoDate | null): IsoDate {
  const atLeastToday = maxDate(date, today);
  return deadline ? minDate(atLeastToday, maxDate(deadline, today)) : atLeastToday;
}

/** Letters that are already requested get one check-in a week before they are due (study: D−7). */
const RECOMMENDER_CHECK_DAYS = 7;

export function buildNextActionsDetailed(ctx: NextActionContext): NextActionsResult {
  const max = Math.min(10, Math.max(1, ctx.max ?? READINESS_CONFIG.nextActions.detail));
  const applyKey = applyItemKey(ctx.programId, ctx.cycleKey);
  const deadline = ctx.effective?.date ?? null;
  const out: Candidate[] = [];
  const push = (action: NextAction, reason: NextActionReason, slack: IsoDate | null = action.dueOn, itemDeadline: IsoDate | null = deadline): void => {
    out.push({ action, reason, slack, deadline: itemDeadline });
  };

  if (ctx.effective?.closed) {
    push(
      {
        id: "next-cycle",
        label: "This cycle's deadline has passed: follow the program for its next cycle",
        detail: null,
        dueOn: null,
        severity: null,
        source: "roadmap",
        roadmapItemKey: applyKey,
        relatesTo: null,
      },
      "NEXT_CYCLE",
    );
    return finish(out, max);
  }
  // Effort on a program the student cannot apply to helps nobody; the eligibility part says why.
  if (ctx.eligibility.status === "not_eligible") return { actions: [], reasons: {} };

  const effective = ctx.effective;
  if (effective && ctx.nominationGated) {
    if (effective.step === "national_after_campus") {
      push(
        {
          id: "campus-passed",
          label: "Your campus deadline may have passed: contact your fellowship office today",
          detail: effective.campusDatePassed ? "Your recorded campus deadline has passed." : "Novus estimated your campus deadline from other campuses.",
          dueOn: ctx.today,
          severity: "late",
          source: "nomination",
          roadmapItemKey: applyKey,
          relatesTo: null,
        },
        "CAMPUS_PASSED",
      );
    } else if (effective.step === "campus_estimate_e1" || effective.step === "campus_estimate_e2") {
      // Every date in the plan rests on this estimate, so confirming it comes first: today when
      // anything is already late or soon (or E1 has passed), else within the week.
      const urgent = effective.step === "campus_estimate_e2" || ctx.planned.some((p) => p.item.severity === "late" || p.item.severity === "soon");
      const anyLate = ctx.planned.some((p) => p.item.severity === "late");
      const dueOn = urgent
        ? ctx.today
        : boundedDate(isoFromEpochDay(epochDayOf(ctx.today) + READINESS_CONFIG.campus.confirmWithinDays), ctx.today, effective.date);
      push(
        {
          id: "campus-confirm",
          label: "Confirm your campus deadline with your fellowship office",
          detail: effective.label.slice(0, 400),
          dueOn,
          severity: anyLate ? "late" : urgent ? "soon" : severityFor(dueOn, ctx.today),
          source: "nomination",
          roadmapItemKey: applyKey,
          relatesTo: null,
        },
        "CAMPUS_ESTIMATE",
      );
    }
  }

  // Eligibility questions are due when the first piece of work is suggested to start: there is no
  // point asking recommenders for a program the student turns out not to qualify for. They are
  // overdue once the hard start of that work has passed.
  const hardStarts = ctx.planned.map((p) => p.item.startBy).filter((d): d is IsoDate => d !== null).sort();
  const suggestedStarts = ctx.planned
    .map((p) => (p.item.startBy === null ? null : p.suggested === null ? p.item.startBy : minDate(p.suggested, p.item.startBy)))
    .filter((d): d is IsoDate => d !== null)
    .sort();
  const firstStart = hardStarts[0] ?? deadline ?? ctx.today;
  const resolveBy = boundedDate(suggestedStarts[0] ?? firstStart, ctx.today, deadline);
  const resolveSeverity = severityFor(firstStart, ctx.today);
  const sensitivePending = ctx.eligibility.studentToResolve.filter((p) => p.sensitive);
  if (sensitivePending.length > 0) {
    push(
      {
        id: "eligibility-private",
        label: "Answer the private eligibility questions on this device",
        detail: "These answers stay in your browser; Novus never sends or stores them.",
        dueOn: resolveBy,
        severity: resolveSeverity,
        source: "eligibility_unknown",
        roadmapItemKey: applyKey,
        relatesTo: null,
      },
      "ELIGIBILITY_PRIVATE",
    );
  }
  for (const pending of ctx.eligibility.studentToResolve.filter((p) => !p.sensitive)) {
    push(
      {
        id: `eligibility:${pending.id}`.slice(0, 80),
        label: "Confirm you meet this eligibility rule",
        detail: pending.selfCheckText.slice(0, 400),
        dueOn: resolveBy,
        severity: resolveSeverity,
        source: "eligibility_unknown",
        roadmapItemKey: applyKey,
        relatesTo: pending.id.slice(0, 80),
      },
      "ELIGIBILITY_CONFIRM",
    );
  }
  if (ctx.eligibility.novusToResolve.length > 0) {
    push(
      {
        id: "eligibility-official",
        label: "Read the official eligibility rules",
        detail: "Novus has not checked every rule for this program yet.",
        dueOn: resolveBy,
        severity: resolveSeverity,
        source: "eligibility_unknown",
        roadmapItemKey: applyKey,
        relatesTo: null,
      },
      "ELIGIBILITY_OFFICIAL",
    );
  }

  if (!ctx.requirementsChecked) {
    push(
      {
        id: "requirements-official",
        label: "See the official page for what to submit",
        detail: "Novus has not checked this program's requirements yet.",
        dueOn: null,
        severity: null,
        source: "gap",
        roadmapItemKey: applyKey,
        relatesTo: null,
      },
      "REQUIREMENTS_OFFICIAL",
    );
  }

  for (const { analysis, item, suggested } of ctx.planned) {
    if (item.startBy === null || (item.state !== "gap" && item.state !== "in_progress")) continue;
    const itemDeadline = analysis.baseDate ?? deadline;
    const reason = gapReason(analysis, item.state);
    let dueOn: IsoDate;
    let severity = item.severity;
    if (reason === "CHECK_RECOMMENDER" && analysis.baseDate !== null) {
      // The ask is done; what is left is making sure the letters arrive.
      dueOn = boundedDate(isoFromEpochDay(epochDayOf(analysis.baseDate) - RECOMMENDER_CHECK_DAYS), ctx.today, itemDeadline);
      severity = severityFor(dueOn, ctx.today);
    } else {
      dueOn = boundedDate(suggested !== null ? minDate(suggested, item.startBy) : item.startBy, ctx.today, itemDeadline);
    }
    push(
      {
        id: `gap:${item.key}`.slice(0, 80),
        label: (item.state === "in_progress" ? inProgressLabel(analysis) : gapText(analysis.requirement, item.state)).slice(0, 200),
        detail: gapDetail(analysis),
        dueOn,
        severity,
        source: "gap",
        roadmapItemKey: prepItemKey(ctx.programId, ctx.cycleKey, item.key),
        relatesTo: item.key,
      },
      reason,
      item.startBy,
      itemDeadline,
    );
  }

  if (ctx.overload) {
    push(
      {
        id: "capacity",
        label: `Your applications need about ${ctx.overload.neededWeeklyHours} hours a week; you planned ${ctx.overload.weeklyHours}`.slice(0, 200),
        detail: "Raise your weekly hours, start earlier, or move one application to its next cycle.",
        dueOn: ctx.today,
        severity: "soon",
        source: "roadmap",
        roadmapItemKey: applyKey,
        relatesTo: null,
      },
      "OVERLOAD",
    );
  }

  if (effective && deadline) {
    const dueOn = maxDate(deadline, ctx.today);
    push(
      {
        id: "submit",
        label: effective.scope === "campus" ? "Submit your campus application" : "Submit your application",
        detail: effective.label.slice(0, 400),
        dueOn,
        severity: severityFor(dueOn, ctx.today),
        source: "deadline",
        roadmapItemKey: applyKey,
        relatesTo: effective.deadlineId,
      },
      "SUBMIT",
    );
  }

  return finish(out, max);
}

function finish(candidates: Candidate[], max: number): NextActionsResult {
  const kept = candidates.slice().sort(compareCandidates).slice(0, max);
  const reasons: Record<string, NextActionReason> = {};
  for (const c of kept) reasons[c.action.id] = c.reason;
  return { actions: kept.map((c) => c.action), reasons };
}

/** The ordered next actions (at most `max`, default 5 for the Tracker detail; cards show 3). */
export function buildNextActions(ctx: NextActionContext): NextAction[] {
  return buildNextActionsDetailed(ctx).actions;
}
