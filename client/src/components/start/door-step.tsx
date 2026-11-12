import { useEffect, useMemo, useRef, useState } from "react";
import type { ProgramBundle } from "./catalog";
import { applicationDate } from "./catalog";
import { reminderTarget as pickReminderTarget, widgetFor, type StepWidget } from "./door-logic";
import { DraftPanel, LettersPanel, ReadinessPanel, ReminderPanel } from "./door-panels";
import type { DraftSeed } from "./draft";
import type { RecommenderPick } from "./letters";
import { MatchCard } from "./matches-step";
import type { DoorOptionView, MatchView, PlanStepView } from "./normalize";
import { buildReadinessView, type PrivateAnswers } from "./readiness-view";
import type { SavedReminder } from "./storage";
import { Glass, Kicker, Note } from "./ui";
import { WayForward } from "./way-forward";
import { shortDate } from "./wording";

/**
 * Screen 5: pick one program (the student chooses; Novus never auto-picks), see its
 * readiness in four parts, and finish the quick plan steps right here.
 */

export interface DoorMemory {
  privateAnswers: PrivateAnswers;
  draft: string;
  recommenders: RecommenderPick[];
  /** The student opted in to keeping the draft in this browser (storage.ts DRAFT_KEY). */
  keepDraft: boolean;
}

export function DoorStep({
  doors,
  matches,
  bundles,
  chosenId,
  onChoose,
  steps,
  done,
  markDone,
  memory,
  setMemory,
  reminder,
  setReminder,
  draftSeed,
  classYear,
  haveResume,
  aiEnabled,
  now,
  today,
  onFinish,
  onBack,
  onEditAnswers,
  onWiden,
}: {
  doors: DoorOptionView[];
  matches: ReadonlyMap<string, MatchView>;
  bundles: ReadonlyMap<string, ProgramBundle>;
  chosenId: string | null;
  onChoose: (id: string | null) => void;
  steps: PlanStepView[];
  done: ReadonlySet<string>;
  markDone: (id: string, value?: boolean) => void;
  memory: DoorMemory;
  setMemory: (m: DoorMemory) => void;
  reminder: SavedReminder | null;
  setReminder: (r: SavedReminder) => void;
  draftSeed: DraftSeed | null;
  classYear: string | null;
  haveResume: boolean;
  aiEnabled: boolean | null;
  now: Date;
  today: string;
  onFinish: () => void;
  onBack: () => void;
  onEditAnswers: () => void;
  onWiden: () => void;
}) {
  const chosen = chosenId ? bundles.get(chosenId) : undefined;

  if (!chosen) {
    return (
      <div className="st-stack">
        <Glass className="st-enter" aria-labelledby="st-door-title">
          <Kicker>Your first door</Kicker>
          <h2 id="st-door-title" className="st-h2">
            Pick one to start today
          </h2>
          <p className="st-lede st-small">Starting one application makes the next ones much easier. You can add more any time.</p>
        </Glass>
        <div className="st-cards st-reveal">
          {doors.map((d) => {
            const m = matches.get(d.programId);
            if (!m) return null;
            return (
              <MatchCard key={d.programId} match={m} bundle={bundles.get(d.programId)}>
                <p className="st-kicker" style={{ marginTop: 14, marginBottom: 0 }}>
                  {d.rationale}
                </p>
                <div className="st-actions" style={{ marginTop: 12 }}>
                  <button type="button" className="st-btn st-btn-go" onClick={() => onChoose(d.programId)}>
                    Start this one
                  </button>
                </div>
              </MatchCard>
            );
          })}
          {!doors.length && (
            <Glass>
              <p>
                None of your matches has enough time left to start well right now. Widening your search drops paid-only, remote, timing and
                location limits; changing your answers reopens the last question.
              </p>
              <WayForward onWiden={onWiden} onEditAnswers={onEditAnswers} onSeeAll={onBack} />
            </Glass>
          )}
        </div>
        {doors.length > 0 && (
          <div className="st-actions">
            <button type="button" className="st-btn st-btn-ghost" onClick={onBack}>
              Back to all matches
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <ChosenDoor
      bundle={chosen}
      match={matches.get(chosen.card.programId) ?? null}
      steps={steps}
      done={done}
      markDone={markDone}
      memory={memory}
      setMemory={setMemory}
      reminder={reminder}
      setReminder={setReminder}
      draftSeed={draftSeed}
      classYear={classYear}
      haveResume={haveResume}
      aiEnabled={aiEnabled}
      now={now}
      today={today}
      onChange={() => onChoose(null)}
      onFinish={onFinish}
    />
  );
}

function ChosenDoor({
  bundle,
  match,
  steps,
  done,
  markDone,
  memory,
  setMemory,
  reminder,
  setReminder,
  draftSeed,
  classYear,
  haveResume,
  aiEnabled,
  now,
  today,
  onChange,
  onFinish,
}: {
  bundle: ProgramBundle;
  match: MatchView | null;
  steps: PlanStepView[];
  done: ReadonlySet<string>;
  markDone: (id: string, value?: boolean) => void;
  memory: DoorMemory;
  setMemory: (m: DoorMemory) => void;
  reminder: SavedReminder | null;
  setReminder: (r: SavedReminder) => void;
  draftSeed: DraftSeed | null;
  classYear: string | null;
  haveResume: boolean;
  aiEnabled: boolean | null;
  now: Date;
  today: string;
  onChange: () => void;
  onFinish: () => void;
}) {
  const deadline = applicationDate(bundle.card);
  const view = useMemo(
    () =>
      buildReadinessView({
        rules: bundle.card.rules,
        requirements: bundle.requirements,
        deadline,
        today,
        classYear,
        privateAnswers: memory.privateAnswers,
        haveResume,
        steps,
        doneStepIds: done,
      }),
    [bundle, deadline, today, classYear, memory.privateAnswers, haveResume, steps, done],
  );
  const [open, setOpen] = useState<string | null>(() => steps.find((s) => s.doneDuringOnboarding && !done.has(s.id))?.id ?? null);
  const applyUrl = bundle.card.applicationUrl ?? bundle.card.officialUrl;
  const quickLeft = steps.filter((s) => s.doneDuringOnboarding && !done.has(s.id)).length;
  const reminderTarget = pickReminderTarget(steps, done);
  const eligibilityResolved = view.eligibility.status === "eligible" || (view.eligibility.rows.every((r) => r.needs.length === 0) && view.eligibility.status !== "not_eligible");

  // Finishing a step unmounts its panel (and the button that had focus). Focus moves to the next
  // step's toggle, or back to the finished step's toggle when none is left, and a polite status
  // line says what happened, so a keyboard or screen-reader user keeps their place.
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  const [focusStep, setFocusStep] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  useEffect(() => {
    if (!focusStep) return;
    toggles.current.get(focusStep)?.focus();
    setFocusStep(null);
  }, [focusStep]);

  const finishAndOpenNext = (id: string) => {
    markDone(id, true);
    const next = steps.find((s) => s.id !== id && s.doneDuringOnboarding && !done.has(s.id));
    setOpen(next?.id ?? null);
    setFocusStep(next?.id ?? id);
    const title = steps.find((s) => s.id === id)?.title ?? "Step";
    setStatus(next ? `Done: ${title}. Next: ${next.title}.` : `Done: ${title}. Quick steps done.`);
  };

  const panelFor = (widget: StepWidget, step: PlanStepView) => {
    switch (widget) {
      case "tracker":
        return (
          <div className="st-stack">
            <p className="st-small">Adds {bundle.card.name} to your Tracker with its deadline. Before you create an account, it stays on this device.</p>
            <div>
              <button type="button" className="st-btn st-btn-cream" onClick={() => finishAndOpenNext(step.id)}>
                Save to my Tracker
              </button>
            </div>
          </div>
        );
      case "eligibility":
        return (
          <div className="st-stack">
            <p className="st-small">
              {eligibilityResolved
                ? "Nothing left to check here. If anything above says 'not eligible', pick a different door."
                : "Answer the private question in part 1 above. It's checked here in your browser only."}
            </p>
            <div>
              <button type="button" className="st-btn st-btn-cream" onClick={() => finishAndOpenNext(step.id)}>
                {eligibilityResolved ? "Confirmed" : "I'll check the official page"}
              </button>
            </div>
          </div>
        );
      case "draft":
        return draftSeed ? (
          <DraftPanel
            seed={draftSeed}
            text={memory.draft}
            setText={(t) => setMemory({ ...memory, draft: t })}
            aiEnabled={aiEnabled}
            keepOnDevice={memory.keepDraft}
            setKeepOnDevice={(v) => setMemory({ ...memory, keepDraft: v })}
            onDone={() => finishAndOpenNext(step.id)}
          />
        ) : null;
      case "letters":
        return (
          <LettersPanel
            programName={bundle.card.name}
            deadline={deadline}
            picks={memory.recommenders}
            setPicks={(p) => setMemory({ ...memory, recommenders: p })}
            onDone={() => finishAndOpenNext(step.id)}
          />
        );
      case "reminder":
        return (
          <ReminderPanel
            now={now}
            targetTitle={reminderTarget?.title ?? "my application"}
            programName={bundle.card.name}
            reminder={reminder}
            setReminder={setReminder}
            onDone={() => finishAndOpenNext(step.id)}
          />
        );
      case "open": {
        // Before applications open, the planner points at the official page instead of a form.
        const notOpenYet = /not open yet/i.test(step.detail ?? "") || /^bookmark/i.test(step.title);
        return (
          <div className="st-stack">
            <p className="st-small">
              {notOpenYet
                ? "Bookmark the official page so you can start the day applications open. It opens in a new tab."
                : "Look over the real form so nothing surprises you later. It opens in a new tab."}
            </p>
            <div>
              <a className="st-btn st-btn-cream" href={step.url ?? applyUrl} target="_blank" rel="noopener noreferrer" onClick={() => finishAndOpenNext(step.id)}>
                {notOpenYet ? "Open the official page" : "Open the official application"}
              </a>
            </div>
          </div>
        );
      }
      default:
        return (
          <div>
            <button type="button" className="st-btn" onClick={() => markDone(step.id, !done.has(step.id))}>
              {done.has(step.id) ? "Mark as not done" : "Mark as done"}
            </button>
          </div>
        );
    }
  };

  return (
    <div className="st-stack">
      {match && (
        <MatchCard match={match} bundle={bundle} chosen>
          <div className="st-actions" style={{ marginTop: 12 }}>
            <button type="button" className="st-link" onClick={onChange}>
              Choose a different one
            </button>
          </div>
        </MatchCard>
      )}

      <Glass className="st-enter" aria-labelledby="st-ready-title">
        <Kicker>How ready you are</Kicker>
        <h2 id="st-ready-title" className="st-h2" style={{ marginBottom: 14 }}>
          Four things to know
        </h2>
        <ReadinessPanel view={view} privateAnswers={memory.privateAnswers} setPrivateAnswers={(p) => setMemory({ ...memory, privateAnswers: p })} />
      </Glass>

      <Glass aria-labelledby="st-plan-title">
        <Kicker>{quickLeft ? `${quickLeft} quick step${quickLeft === 1 ? "" : "s"} to do now` : "Quick steps done"}</Kicker>
        <h2 id="st-plan-title" className="st-h2">
          Your plan for this application
        </h2>
        <ol className="st-stack" style={{ listStyle: "none", padding: 0, marginTop: 16 }}>
          {steps.map((s, i) => {
            const isDone = done.has(s.id);
            const widget = widgetFor(s);
            // Every step with something to do can be opened; only the quick ones count toward now.
            const expandable = widget !== "submit" || s.doneDuringOnboarding;
            const isOpen = open === s.id;
            return (
              <li key={s.id}>
                <button
                  type="button"
                  className="st-check"
                  ref={(el) => {
                    if (el) toggles.current.set(s.id, el);
                    else toggles.current.delete(s.id);
                  }}
                  data-done={isDone}
                  aria-expanded={expandable ? isOpen : undefined}
                  onClick={() => (expandable ? setOpen(isOpen ? null : s.id) : undefined)}
                >
                  <span className="st-ring" aria-hidden="true">
                    {isDone ? "✓" : i + 1}
                  </span>
                  <span className="st-body">
                    <span style={{ display: "block", fontWeight: 600 }}>{s.title}</span>
                    <span className="st-meta">
                      {s.doneDuringOnboarding
                        ? `Now · about ${Math.max(1, s.minutes)} min`
                        : s.due
                          ? `${s.late ? "Due today" : `By ${shortDate(s.due)}`} · optional now`
                          : "Later"}
                      {isDone ? " · done" : ""}
                    </span>
                    {s.detail && (
                      <span className="st-small st-muted" style={{ display: "block", marginTop: 4 }}>
                        {s.detail}
                      </span>
                    )}
                  </span>
                </button>
                {isOpen && expandable && <div className="st-step-panel">{panelFor(widget, s)}</div>}
              </li>
            );
          })}
        </ol>
        <p className="st-sr" role="status" aria-live="polite">
          {status}
        </p>
        {bundle.card.isSample && (
          <div style={{ marginTop: 14 }}>
            <Note>This is a sample program, so its official page is an example address.</Note>
          </div>
        )}
        <div className="st-actions">
          <a className="st-btn st-btn-cream" href={applyUrl} target="_blank" rel="noopener noreferrer">
            Open the official application
          </a>
          <button type="button" className="st-btn st-btn-go" onClick={onFinish}>
            {quickLeft ? "Finish for today" : "I'm all set"}
          </button>
        </div>
      </Glass>
    </div>
  );
}
