/**
 * OutcomePrompt: the Tracker decision step's "How did it go?" form. Mount it inside a Tracker
 * card (client/src/pages/tracker/index.tsx, TrackerCard) below the "Move to" row:
 *
 *   <OutcomePrompt item={item} card={programCard} window={decisionWindow} today={viewer.today} />
 *
 * It renders nothing (and loads nothing) until the program card is known, for status-defined
 * programs, for cards not yet submitted, or before the prompt is due (3 days after the cycle's
 * expected decision date, from `window`). Reports are the student's own; other people's outcomes only ever appear as
 * banded totals (OutcomeSummaryPanel).
 */
import { useId, useState, type FormEvent } from "react";
import type { OutcomeReport, OutcomeReportUpdate } from "@shared/contracts/advisor";
import type { ProgramCard } from "@shared/contracts/registry";
import type { TrackerItem } from "@shared/contracts/student";
import type { DecisionWindowCycle } from "@shared/readiness/outcomes";
import { ApiError } from "@/lib/api";
import { useMyOutcomes, useSaveOutcome } from "./api";
import {
  CAMPUS_LABELS,
  INTERVIEW_LABELS,
  PROMPT_COPY,
  RESULT_LABELS,
  fieldForPath,
  formIssues,
  formToFacts,
  initialFormState,
  outcomePromptState,
  toCreateBody,
  type CampusAnswer,
  type InterviewAnswer,
  type OutcomeFormState,
  type ResultAnswer,
} from "./model";

export interface OutcomePromptProps {
  readonly item: TrackerItem;
  /** The program card; null or undefined while unknown, and then nothing renders. */
  readonly card?: Pick<ProgramCard, "name" | "isSample" | "flags"> | null;
  readonly window?: DecisionWindowCycle | null;
  /** The viewer's local date (YYYY-MM-DD). */
  readonly today: string;
}

type Errors = Partial<Record<keyof OutcomeFormState | "form", string>>;

function toErrors(issues: readonly { path: string; message: string }[], state: OutcomeFormState): Errors {
  const out: Errors = {};
  for (const i of issues) {
    const field = fieldForPath(i.path, state);
    if (!out[field]) out[field] = i.message;
  }
  return out;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <span id={id} className="nvr-meta" style={{ color: "var(--nv-bad)", display: "block" }}>
      {message}
    </span>
  );
}

export function OutcomeForm({ item, card, existing, today }: { item: TrackerItem; card?: OutcomePromptProps["card"]; existing: OutcomeReport | null; today: string }) {
  const base = useId();
  const ids = {
    submitted: `${base}-submitted`,
    campusOn: `${base}-campus-on`,
    interview: `${base}-interview`,
    interviewOn: `${base}-interview-on`,
    result: `${base}-result`,
    decidedOn: `${base}-decided`,
    waitlisted: `${base}-waitlisted`,
  };
  const [state, setState] = useState<OutcomeFormState>(() => initialFormState(item, existing));
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState("");
  const save = useSaveOutcome();
  const sample = Boolean(card?.isSample);
  const set = <K extends keyof OutcomeFormState>(key: K, value: OutcomeFormState[K]) => setState((s) => ({ ...s, [key]: value }));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const issues = formIssues(state, today);
    setErrors(toErrors(issues, state));
    if (issues.length > 0) {
      setNotice("Check the highlighted answers.");
      return;
    }
    const facts = formToFacts(state);
    const input = existing
      ? { sample, update: { publicId: existing.publicId, patch: { ...facts, priorFeeder: state.priorFeeder } satisfies OutcomeReportUpdate } }
      : { sample, create: toCreateBody(state, item.programCycleId) };
    save.mutate(input, {
      onSuccess: () => {
        setErrors({});
        setNotice(sample ? PROMPT_COPY.sample : PROMPT_COPY.saved);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === "validation_failed" && err.problem?.errors) {
          setErrors(toErrors(err.problem.errors, state));
          setNotice("Check the highlighted answers.");
        } else if (err instanceof ApiError && err.code === "consent_required") {
          setNotice(PROMPT_COPY.consent);
        } else if (err instanceof ApiError && err.problem?.detail) {
          setNotice(err.problem.detail);
        } else {
          setNotice("Your report could not be saved. Try again.");
        }
      },
    });
  };

  const describedBy = (field: keyof OutcomeFormState, id: string) => (errors[field] ? `${id}-err` : undefined);

  return (
    <form onSubmit={onSubmit} noValidate style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
      <p className="nvr-meta">{PROMPT_COPY.intro}</p>

      <label htmlFor={ids.submitted} className="nvr-label">
        When did you apply?
      </label>
      <input
        id={ids.submitted}
        type="date"
        className="nvr-input"
        max={today}
        value={state.submittedOn}
        aria-invalid={errors.submittedOn ? true : undefined}
        aria-describedby={describedBy("submittedOn", ids.submitted)}
        onChange={(e) => set("submittedOn", e.currentTarget.value)}
      />
      <FieldError id={`${ids.submitted}-err`} message={errors.submittedOn} />

      {card?.flags.nominationRequired ? (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="nvr-label">Campus nomination</legend>
          <div className="nvr-opts" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {(Object.keys(CAMPUS_LABELS) as CampusAnswer[]).map((k) => (
              <label key={k} className="nvr-choice" data-checked={state.campus === k ? "" : undefined}>
                <input type="radio" name={`${base}-campus`} value={k} checked={state.campus === k} onChange={() => set("campus", k)} />
                {CAMPUS_LABELS[k]}
              </label>
            ))}
          </div>
          {state.campus !== "skip" ? (
            <>
              <label htmlFor={ids.campusOn} className="nvr-meta">
                When did you hear from your campus? (optional)
              </label>
              <input id={ids.campusOn} type="date" className="nvr-input" max={today} value={state.campusOn} aria-describedby={describedBy("campusOn", ids.campusOn)} onChange={(e) => set("campusOn", e.currentTarget.value)} />
              <FieldError id={`${ids.campusOn}-err`} message={errors.campusOn} />
            </>
          ) : null}
        </fieldset>
      ) : null}

      <label htmlFor={ids.interview} className="nvr-label">
        Interview
      </label>
      <select id={ids.interview} className="nvr-select" value={state.interview} onChange={(e) => set("interview", e.currentTarget.value as InterviewAnswer)}>
        {(Object.keys(INTERVIEW_LABELS) as InterviewAnswer[]).map((k) => (
          <option key={k} value={k}>
            {INTERVIEW_LABELS[k]}
          </option>
        ))}
      </select>
      {state.interview !== "none" ? (
        <>
          <label htmlFor={ids.interviewOn} className="nvr-meta">
            Date (optional)
          </label>
          <input id={ids.interviewOn} type="date" className="nvr-input" max={today} value={state.interviewOn} aria-describedby={describedBy("interviewOn", ids.interviewOn)} onChange={(e) => set("interviewOn", e.currentTarget.value)} />
          <FieldError id={`${ids.interviewOn}-err`} message={errors.interviewOn} />
        </>
      ) : null}

      <label className="nvr-check" htmlFor={ids.waitlisted} style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input id={ids.waitlisted} type="checkbox" checked={state.waitlisted} onChange={(e) => set("waitlisted", e.currentTarget.checked)} />
        I was put on a waitlist
      </label>

      <label htmlFor={ids.result} className="nvr-label">
        Result
      </label>
      <select id={ids.result} className="nvr-select" value={state.result} onChange={(e) => set("result", e.currentTarget.value as ResultAnswer)}>
        {(Object.keys(RESULT_LABELS) as ResultAnswer[]).map((k) => (
          <option key={k} value={k}>
            {RESULT_LABELS[k]}
          </option>
        ))}
      </select>
      {state.result !== "waiting" ? (
        <>
          <label htmlFor={ids.decidedOn} className="nvr-meta">
            {state.result === "no_response" ? "When did you stop waiting? (optional)" : "When did you hear?"}
          </label>
          <input
            id={ids.decidedOn}
            type="date"
            className="nvr-input"
            max={today}
            value={state.decidedOn}
            aria-invalid={errors.decidedOn ? true : undefined}
            aria-describedby={describedBy("decidedOn", ids.decidedOn)}
            onChange={(e) => set("decidedOn", e.currentTarget.value)}
          />
          <FieldError id={`${ids.decidedOn}-err`} message={errors.decidedOn} />
        </>
      ) : null}

      <FieldError id={`${base}-form-err`} message={errors.form} />
      <p className="nvr-meta">{PROMPT_COPY.privacy}</p>
      <div>
        <button type="submit" className="nvr-btn-go" disabled={save.isPending}>
          {save.isPending ? "Saving" : existing ? "Update report" : "Save report"}
        </button>
      </div>
      <p className="nvr-meta" role="status" aria-live="polite">
        {notice}
      </p>
    </form>
  );
}

export function OutcomePrompt({ item, card, window, today }: OutcomePromptProps) {
  const headingId = useId();
  // Status-defined programs never ask, and never even load the student's reports. Neither does
  // a program whose card has not loaded: it might be status-defined.
  const askable = Boolean(card) && !card?.flags.sensitiveAudience;
  const mine = useMyOutcomes(askable && (item.status === "submitted" || item.status === "decided"));
  const existing = mine.data?.find((r) => r.programCycleId === item.programCycleId) ?? null;
  const prompt = outcomePromptState({ item, flags: card?.flags ?? null, window: window ?? null, existing, today });

  // Wait for the student's own reports, so a reported decision is not asked about again.
  if (prompt.mode === "hidden" || mine.isLoading) return null;
  if (prompt.mode === "locked") {
    return <p className="nvr-meta">{PROMPT_COPY.locked}</p>;
  }
  return (
    <details open={prompt.mode === "ask"} aria-labelledby={headingId}>
      <summary className="nvr-meta" style={{ cursor: "pointer" }} id={headingId}>
        {prompt.mode === "edit" ? "Edit how it went" : PROMPT_COPY.heading}
      </summary>
      <OutcomeForm item={item} card={card} existing={existing} today={today} />
    </details>
  );
}
