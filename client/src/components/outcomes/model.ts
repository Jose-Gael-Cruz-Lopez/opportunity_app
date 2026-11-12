/**
 * The Tracker's decision step: when the one "How did it go?" prompt shows, the form's state, and
 * the request body it sends. Pure, so every rule here is unit-tested.
 *
 * Rules (plans 7.8 and 9.5):
 * - Status-defined programs collect no Outcomes: no prompt, no form, ever.
 * - The prompt opens when the student moves a card to Decided, or once, 3 days after the
 *   program's expected decision date, while the card sits in Submitted.
 * - The form asks only what happened and when: no free text, no names, no scores, no status or
 *   identity answer. The server adds the non-sensitive snapshot itself.
 * - What a student reports never changes what they can see (give-to-get is about contributing,
 *   never about the answer).
 */
import type { OutcomeReport, OutcomeReportCreate } from "@shared/contracts/advisor";
import type { ProgramCard } from "@shared/contracts/registry";
import type { TrackerItem } from "@shared/contracts/student";
import {
  outcomeEditable,
  outcomePromptDueOn,
  structuralIssues,
  type DecisionWindowCycle,
  type OutcomeDecisionCode,
  type OutcomeIssue,
  type OutcomeStageCode,
} from "@shared/readiness/outcomes";

export type PromptMode = "hidden" | "ask" | "edit" | "locked";

export interface PromptState {
  readonly mode: PromptMode;
  /** Why it is hidden or locked (for tests and the screen-reader note). */
  readonly reason: "unknown_program" | "sensitive_program" | "not_applied" | "not_due" | "decided" | "due" | "reported" | "edit_closed";
}

export interface PromptInput {
  readonly item: Pick<TrackerItem, "status" | "programCycleId">;
  /** The program's flags; missing (still loading, or failed to load) means hidden, never "not sensitive". */
  readonly flags?: Pick<ProgramCard["flags"], "sensitiveAudience" | "nominationRequired"> | null;
  /** Curated decision window of the cycle, when the client has it (program detail). */
  readonly window?: DecisionWindowCycle | null;
  readonly existing?: Pick<OutcomeReport, "decidedOn"> | null;
  readonly today: string;
}

export function outcomePromptState(input: PromptInput): PromptState {
  // Until the program is known, it might be status-defined: ask nothing.
  if (!input.flags) return { mode: "hidden", reason: "unknown_program" };
  if (input.flags.sensitiveAudience) return { mode: "hidden", reason: "sensitive_program" };
  if (input.existing) {
    return outcomeEditable(input.existing.decidedOn, input.today) ? { mode: "edit", reason: "reported" } : { mode: "locked", reason: "edit_closed" };
  }
  if (input.item.status === "decided") return { mode: "ask", reason: "decided" };
  if (input.item.status === "submitted") {
    const due = input.window ? outcomePromptDueOn(input.window) : null;
    return due !== null && input.today >= due ? { mode: "ask", reason: "due" } : { mode: "hidden", reason: "not_due" };
  }
  return { mode: "hidden", reason: "not_applied" };
}

export type CampusAnswer = "nominated" | "not_nominated" | "skip";
export type InterviewAnswer = "none" | "invited" | "interviewed";
export type ResultAnswer = "waiting" | "admitted" | "admitted_declined" | "not_selected" | "withdrew" | "no_response";

export interface OutcomeFormState {
  readonly submittedOn: string;
  readonly campus: CampusAnswer;
  readonly campusOn: string;
  readonly interview: InterviewAnswer;
  readonly interviewOn: string;
  readonly waitlisted: boolean;
  readonly result: ResultAnswer;
  readonly decidedOn: string;
  /** Asked only for programs with curated feeders; null = not asked or not answered. */
  readonly priorFeeder: "yes" | "no" | null;
}

export const RESULT_LABELS: Readonly<Record<ResultAnswer, string>> = {
  waiting: "Still waiting to hear",
  admitted: "Admitted",
  admitted_declined: "Admitted, and I declined",
  not_selected: "Not selected",
  withdrew: "I withdrew",
  no_response: "I never heard back",
};

export const INTERVIEW_LABELS: Readonly<Record<InterviewAnswer, string>> = {
  none: "No interview",
  invited: "Invited to interview",
  interviewed: "Interviewed",
};

export const CAMPUS_LABELS: Readonly<Record<CampusAnswer, string>> = {
  nominated: "My campus nominated me",
  not_nominated: "My campus did not nominate me",
  skip: "Not sure",
};

const RESULT_TO_DECISION: Readonly<Record<ResultAnswer, OutcomeDecisionCode | null>> = {
  waiting: null,
  admitted: "accepted",
  admitted_declined: "declined_offer",
  not_selected: "rejected",
  withdrew: "withdrew",
  no_response: "no_response",
};

const DECISION_TO_RESULT: Readonly<Record<OutcomeDecisionCode, ResultAnswer>> = {
  accepted: "admitted",
  declined_offer: "admitted_declined",
  rejected: "not_selected",
  withdrew: "withdrew",
  no_response: "no_response",
};

export function initialFormState(item: Pick<TrackerItem, "submittedOn">, existing?: OutcomeReport | null): OutcomeFormState {
  if (!existing) {
    return { submittedOn: item.submittedOn ?? "", campus: "skip", campusOn: "", interview: "none", interviewOn: "", waitlisted: false, result: "waiting", decidedOn: "", priorFeeder: null };
  }
  const on = (stage: OutcomeStageCode) => existing.stages.find((s) => s.stage === stage);
  const interview: InterviewAnswer = on("interviewed") ? "interviewed" : on("interview_invited") ? "invited" : "none";
  return {
    submittedOn: on("submitted")?.on ?? "",
    campus: on("campus_nominated") ? "nominated" : on("not_nominated") ? "not_nominated" : "skip",
    campusOn: on("campus_nominated")?.on ?? on("not_nominated")?.on ?? "",
    interview,
    interviewOn: (interview === "interviewed" ? on("interviewed")?.on : on("interview_invited")?.on) ?? "",
    waitlisted: Boolean(on("waitlisted")),
    result: existing.decision ? DECISION_TO_RESULT[existing.decision] : "waiting",
    decidedOn: existing.decidedOn ?? "",
    priorFeeder: existing.snapshot.priorFeeder,
  };
}

const orNull = (v: string): string | null => (v.trim() === "" ? null : v);

/** The stages, decision and date the form describes (dates the student left empty are null). */
export function formToFacts(state: OutcomeFormState): Pick<OutcomeReportCreate, "stages" | "decision" | "decidedOn"> {
  const stages: OutcomeReportCreate["stages"] = [{ stage: "submitted", on: orNull(state.submittedOn) }];
  if (state.campus === "nominated") stages.push({ stage: "campus_nominated", on: orNull(state.campusOn) });
  if (state.campus === "not_nominated") stages.push({ stage: "not_nominated", on: orNull(state.campusOn) });
  if (state.interview === "invited") stages.push({ stage: "interview_invited", on: orNull(state.interviewOn) });
  if (state.interview === "interviewed") stages.push({ stage: "interview_invited", on: null }, { stage: "interviewed", on: orNull(state.interviewOn) });
  if (state.waitlisted) stages.push({ stage: "waitlisted", on: null });
  const decision = RESULT_TO_DECISION[state.result];
  return { stages, decision, decidedOn: decision === null ? null : orNull(state.decidedOn) };
}

export function toCreateBody(state: OutcomeFormState, programCycleId: string): OutcomeReportCreate {
  return { programCycleId, ...formToFacts(state), priorFeeder: state.priorFeeder };
}

/** Checks the browser runs before sending: the same rules and messages as the server. */
export function formIssues(state: OutcomeFormState, today: string): OutcomeIssue[] {
  return structuralIssues(formToFacts(state), today);
}

/** Maps a server or browser issue path to the form field that shows it. */
export function fieldForPath(path: string, state: OutcomeFormState): keyof OutcomeFormState | "form" {
  if (path === "decidedOn") return "decidedOn";
  const m = /^stages\.(\d+)/.exec(path);
  if (!m) return "form";
  const stage = formToFacts(state).stages[Number(m[1])]?.stage;
  if (stage === "submitted") return "submittedOn";
  if (stage === "campus_nominated" || stage === "not_nominated") return "campusOn";
  if (stage === "interview_invited" || stage === "interviewed") return "interviewOn";
  return "form";
}

export const PROMPT_COPY = {
  heading: "How did it go?",
  intro: "Tell Novus what happened. Only totals of five or more reports are ever shown, and never a single report.",
  privacy: "We save what happened and when. We never ask for names, scores or private answers.",
  sample: "Sample data: nothing was saved.",
  saved: "Thanks. Your report is saved, and you can edit it for 60 days after the decision.",
  locked: "Reports can be edited until 60 days after the decision.",
  consent: "Students under 18 turn on outcome sharing in Settings first.",
} as const;

/**
 * The curated decision window for a tracked cycle, from the program detail. Only the detail's
 * current cycle carries these dates; for any other cycle the window is unknown (null), so the
 * timed prompt waits for the student to mark the card decided.
 */
export function decisionWindowFor(
  cycle: (DecisionWindowCycle & { readonly id: string }) | null | undefined,
  programCycleId: string,
): DecisionWindowCycle | null {
  if (!cycle || cycle.id !== programCycleId) return null;
  return { decisionWindowStart: cycle.decisionWindowStart, decisionWindowEnd: cycle.decisionWindowEnd };
}
