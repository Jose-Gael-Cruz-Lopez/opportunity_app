/**
 * Pure view logic for the four readiness parts: checklist progress keys and toggles, the
 * "n of m ready" line, and which next actions to show. Kept apart from the components so the
 * rules are unit-tested.
 */
import type { EligibilityResult } from "@shared/contracts/eligibility";
import type { ChecklistItem, NextAction, ReadinessReport, RequirementState, StartSeverity } from "@shared/contracts/readiness";
import type { RequirementProgressUpdate } from "@shared/contracts/student";
import { PRODUCT } from "@shared/config/product";
import { personalDisclosure } from "@/lib/personal-disclosure";
import { daysBetween } from "@shared/time";
import { SEVERITY_LABELS, formatShortDate } from "./format";

/** The progress key the API stores: `req:{requirementId}` or a reusable `kind:{kind}` item. */
export function subjectKeyFor(item: ChecklistItem): string {
  if (item.requirementId) return `req:${item.requirementId}`;
  return item.key.startsWith("kind:") ? item.key : `kind:${item.kind}`;
}

/** Ticking an item marks it ready; unticking a ready item sends it back to in progress. */
export function toggledState(state: RequirementState): "met" | "in_progress" {
  return state === "met" ? "in_progress" : "met";
}

export function progressUpdate(item: ChecklistItem, next: "met" | "in_progress"): RequirementProgressUpdate {
  return { subjectKey: subjectKeyFor(item), state: next };
}

/** Applies on-screen ticks over the server's states (the server recomputes on its next answer). */
export function withOverrides(items: readonly ChecklistItem[], overrides: ReadonlyMap<string, RequirementState>): ChecklistItem[] {
  return items.map((i) => {
    const o = overrides.get(i.key);
    return o ? { ...i, state: o, gap: o === "met" ? null : i.gap } : i;
  });
}

/** "2 of 4 ready" over the items that apply. */
export function readyLine(items: readonly ChecklistItem[]): string {
  const applicable = items.filter((i) => i.state !== "not_applicable");
  const ready = applicable.filter((i) => i.state === "met").length;
  return `${ready} of ${applicable.length} ready`;
}

/**
 * Severity of a start-by date seen today. The server sends its own, but it was computed when the
 * report was generated; recomputing keeps a page left open overnight honest.
 */
export function severityOn(startBy: string | null, today: string): StartSeverity | null {
  if (!startBy) return null;
  const slack = daysBetween(today, startBy);
  if (slack < 0) return "late";
  return slack <= PRODUCT.readiness.soonWithinDays ? "soon" : "planned";
}

/** The right-hand note on a checklist row: "Ready", or "Start soon · by Tue 5 Jan". */
export function checklistSideNote(item: ChecklistItem, today: string): { text: string; severity: StartSeverity | null } {
  if (item.state === "met") return { text: "Ready", severity: null };
  if (item.state === "not_applicable") return { text: "Not needed", severity: null };
  const severity = severityOn(item.startBy, today) ?? item.severity;
  if (!item.startBy) return { text: item.state === "in_progress" ? "In progress" : "No start date", severity };
  const lead = severity ? `${SEVERITY_LABELS[severity]} · ` : "";
  return { text: `${lead}by ${formatShortDate(item.startBy)}`, severity };
}

/**
 * Next actions to show: drops "check this rule" actions the student has now answered on the
 * device, keeps the server's slack order, and caps the list (3 on cards, 5 in the detail view).
 */
export function visibleNextActions(actions: readonly NextAction[], eligibility: EligibilityResult, limit: number): NextAction[] {
  const decided = new Set(eligibility.rules.filter((r) => r.verdict !== "unknown").map((r) => r.ruleId));
  return actions.filter((a) => !(a.source === "eligibility_unknown" && a.relatesTo !== null && decided.has(a.relatesTo))).slice(0, limit);
}

export function nextActionLimit(variant: "card" | "detail"): number {
  return variant === "card" ? PRODUCT.readiness.nextActionsCard : PRODUCT.readiness.nextActionsDetail;
}

/** Where start-by dates count back from, in words. */
export function effectiveDeadlineLine(report: ReadinessReport): string | null {
  const d = report.requirements.effectiveDeadline;
  if (!d) return null;
  const basis =
    d.basis === "estimated"
      ? " (estimated: confirm with your campus representative)"
      : d.basis === "predicted"
        ? " (expected date, may change)"
        : d.basis === "student_entered"
          ? " (the date you entered)"
          : "";
  return `Start-by dates count back from ${d.label.toLowerCase()}, ${formatShortDate(d.date, { year: true })}${basis}.`;
}

/** The eligibility rows in display order: open private rules first, then failures, then the rest. */
export function orderedRules(result: EligibilityResult): EligibilityResult["rules"] {
  const rank = (r: EligibilityResult["rules"][number]) => (r.verdict === "not_met" ? 0 : r.verdict === "unknown" ? 1 : 2);
  return [...result.rules].sort((a, b) => rank(a) - rank(b));
}

/**
 * True when a free-text question to the assistant discloses a status or identity detail about
 * the student, so the screen can ask them to leave it out before anything is sent. Uses the same
 * sentence-level check as Ask Novus: a property-name matcher missed "I'm Black" and "my parents
 * never went to college" and blocked harmless questions like "Can I start my essay on race?".
 * The server redacts too; this is the first line.
 */
export function questionLooksPrivate(question: string): boolean {
  return personalDisclosure(question) !== null;
}
