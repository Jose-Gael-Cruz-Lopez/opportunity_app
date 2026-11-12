import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { QuestionView } from "./normalize";
import { arrowTarget, canContinue, exclusiveValues, initialDraft, keyToIndex, rovingTabStop, toggleMulti, toggleMultiExclusive } from "./quiz-logic";
import type { QuizAnswerValue } from "./storage";
import { Glass, Kicker } from "./ui";

/**
 * Screen 2: one question per screen. Every question can be skipped.
 *
 * Keyboard (WCAG 2.1.4): shortcuts work only while focus is in the answer list, never page-wide,
 * so a stray key elsewhere cannot answer or erase anything. In the list, arrow keys, Home and End
 * move between answers and 1-9 pick one; Enter continues a multi, slider or text question. There
 * is no Backspace shortcut: Back is a button. Single-choice answers are a radio group with one
 * tab stop; arrows check an answer without submitting it (choosing submits, so moving must not),
 * and Space, Enter or a tap submits.
 */
export function QuizStep({
  question,
  number,
  total,
  previous,
  canGoBack,
  onAnswer,
  onSkip,
  onBack,
}: {
  question: QuestionView;
  number: number;
  total: number;
  previous: QuizAnswerValue | undefined;
  canGoBack: boolean;
  onAnswer: (value: QuizAnswerValue) => void;
  onSkip: () => void;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<QuizAnswerValue | undefined>(() => initialDraft(question, previous));
  const headingRef = useRef<HTMLHeadingElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const exclusive = useMemo(() => exclusiveValues(question), [question]);

  // New question: reset the draft and move focus to its heading for screen-reader users.
  useEffect(() => {
    setDraft(initialDraft(question, previous));
    headingRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [question.id]);

  const ready = canContinue(question, draft);
  const submit = () => {
    if (ready && draft !== undefined) onAnswer(draft);
  };

  const pick = (value: string) => {
    if (question.kind === "multi") {
      const cur = Array.isArray(draft) ? draft : [];
      setDraft(exclusive.size ? toggleMultiExclusive(cur, value, exclusive, question.max) : toggleMulti(cur, value, question.max));
    } else {
      // Single choice answers immediately: one tap per question keeps the quiz fast.
      setDraft(value);
      onAnswer(value);
    }
  };

  const isMultiLike = question.kind === "multi" || question.kind === "slider";
  const isMulti = question.kind === "multi";
  const values = question.options.map((o) => o.value);
  const tabStop = rovingTabStop(values, draft);

  // Enter continues, but only from inside this question's panel and never from a button (the
  // multi-choice answer list handles its own Enter in onOptionsKeyDown).
  const onPanelKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Enter" || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!(isMultiLike || question.kind === "text")) return;
    if ((e.target as HTMLElement).tagName === "BUTTON") return;
    e.preventDefault();
    submit();
  };

  // Shortcuts scoped to the answer list (focus is on one of its options).
  const onOptionsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // In a multi-choice list Space toggles the focused answer and Enter continues, as the tip
    // says. Without this, Enter would activate the focused button and toggle it instead.
    if (e.key === "Enter" && isMulti) {
      e.preventDefault();
      e.stopPropagation();
      submit();
      return;
    }
    const digit = keyToIndex(e.key);
    if (digit !== null && question.options[digit]) {
      e.preventDefault();
      optionRefs.current[digit]?.focus();
      pick(question.options[digit].value);
      return;
    }
    const current = optionRefs.current.findIndex((el) => el === document.activeElement);
    const next = arrowTarget(e.key, current, question.options.length);
    if (next === null) return;
    e.preventDefault();
    optionRefs.current[next]?.focus();
    // Radio pattern: moving checks the answer. It does not submit; Space, Enter or a tap does.
    const option = question.options[next];
    if (!isMulti && option) setDraft(option.value);
  };

  const selected = (v: string) => (Array.isArray(draft) ? draft.includes(v) : draft === v);

  return (
    <Glass key={question.id} className="st-enter" aria-labelledby="st-q-title" onKeyDown={onPanelKeyDown}>
      <Kicker>
        Question {number} of about {total}
        {question.private ? " · private, stays on this device" : ""}
      </Kicker>
      <h2 id="st-q-title" className="st-h2" tabIndex={-1} ref={headingRef}>
        {question.prompt}
      </h2>
      {question.help && <p className="st-lede st-small">{question.help}</p>}
      {isMulti && question.max && !question.help && <p className="st-meta" style={{ marginTop: 8 }}>Pick up to {question.max}.</p>}

      {question.kind === "slider" && question.slider ? (
        <div className="st-field" style={{ marginTop: 22 }}>
          <p aria-hidden="true">
            <span className="st-dot st-num">
              {typeof draft === "number" && draft >= question.slider.max && question.slider.maxLabel ? question.slider.maxLabel : String(draft ?? question.slider.defaultValue)}
            </span>{" "}
            <span className="st-muted">{question.slider.unit}</span>
          </p>
          <label className="st-sr" htmlFor="st-q-slider">
            {question.prompt}
          </label>
          <input
            id="st-q-slider"
            type="range"
            min={question.slider.min}
            max={question.slider.max}
            step={question.slider.step}
            value={typeof draft === "number" ? draft : question.slider.defaultValue}
            aria-valuetext={`${typeof draft === "number" ? draft : question.slider.defaultValue} ${question.slider.unit}`}
            onChange={(e) => setDraft(Number(e.target.value))}
            style={{ width: "100%", accentColor: "var(--leaf)" }}
          />
        </div>
      ) : question.kind === "text" ? (
        <div className="st-field" style={{ marginTop: 18 }}>
          <label className="st-sr" htmlFor="st-q-input">
            {question.prompt}
          </label>
          <input
            id="st-q-input"
            className="st-input"
            value={typeof draft === "string" ? draft : ""}
            placeholder={question.placeholder}
            onChange={(e) => setDraft(e.target.value.slice(0, question.maxLength ?? 120))}
            autoComplete="off"
            maxLength={question.maxLength ?? 120}
          />
          {question.private && <p className="st-meta">Stays on this device. Leave out names and contact details.</p>}
        </div>
      ) : (
        <div
          className={question.kind === "pair" ? "st-pair" : "st-options"}
          role={isMulti ? "group" : "radiogroup"}
          aria-labelledby="st-q-title"
          onKeyDown={onOptionsKeyDown}
        >
          {question.options.map((o, i) => (
            <button
              key={o.value}
              ref={(el) => {
                optionRefs.current[i] = el;
              }}
              type="button"
              className="st-option"
              role={isMulti ? undefined : "radio"}
              tabIndex={isMulti || i === tabStop ? 0 : -1}
              aria-checked={isMulti ? undefined : selected(o.value)}
              aria-pressed={isMulti ? selected(o.value) : undefined}
              onClick={() => pick(o.value)}
            >
              <span className="st-key" aria-hidden="true">
                {i < 9 ? i + 1 : ""}
              </span>
              <span>
                {o.label}
                {o.hint && <span className="st-hint">{o.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}

      {question.prefill !== undefined && previous === undefined && (
        <p className="st-meta" style={{ marginTop: 12 }}>
          {question.kind === "single" ? "From your resume: is this right? Tap it to confirm, or pick another." : "Filled in from your resume. Is this right? Change anything that's off."}
        </p>
      )}

      <div className="st-actions">
        {(isMulti || question.kind === "text" || question.kind === "slider") && (
          <button type="button" className="st-btn st-btn-go" onClick={submit} disabled={!ready}>
            Continue
          </button>
        )}
        <button type="button" className="st-btn st-btn-ghost" onClick={onSkip}>
          {question.optional ? "Skip" : "Not sure, skip"}
        </button>
        <span className="st-spacer" />
        {canGoBack && (
          <button type="button" className="st-btn st-btn-ghost" onClick={onBack}>
            Back
          </button>
        )}
      </div>
      <p className="st-meta" style={{ marginTop: 10 }}>
        {question.options.length > 0
          ? `Tip: in the answers, arrow keys move and 1 to ${Math.min(9, question.options.length)} choose${isMulti ? "; Enter continues" : ""}.`
          : "Tip: press Enter to continue."}
      </p>
    </Glass>
  );
}
