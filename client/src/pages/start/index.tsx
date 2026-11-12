import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "@/components/start/start.css";
import { browserTimeZone, getState, postFirstDoor, postQuiz } from "@/components/start/api";
import { applicationDate, loadCatalog, type Catalog, type ProgramBundle } from "@/components/start/catalog";
import { DoneStep, hasSaveIntent, withoutSaveIntent, type SaveState } from "@/components/start/done-step";
import { doneCount, fallbackDoors, fallbackPlan, nextOpenStep, reminderTarget, serverStepIds } from "@/components/start/door-logic";
import { DoorStep, type DoorMemory } from "@/components/start/door-step";
import type { DraftSeed } from "@/components/start/draft";
import {
  answer,
  firstDoors,
  interestLabel,
  nextQuestionView,
  planFor,
  preferencesOf,
  quizQuestions,
  replayQuiz,
  runMatches,
  serverPreferencesOf,
  serverSignalsOf,
} from "@/components/start/engine";
import { deviceEligibilityAdapter } from "@/components/start/device-eligibility";
import { buildSamplePrograms } from "@/components/start/fixtures";
import { nextStage, type Stage } from "@/components/start/flow";
import { MatchesStep } from "@/components/start/matches-step";
import { STAGE_TITLES, backAction, focusFirstHeading, markStage, pushStage, stageFromHistoryState } from "@/components/start/nav";
import type { DoorOptionView, MatchView, PlanStepView, QuestionView } from "@/components/start/normalize";
import { QuizStep } from "@/components/start/quiz-step";
import { ResumeStep, type ResumeOutcome } from "@/components/start/resume-step";
import type { SignalsView } from "@/components/start/resume-view";
import {
  EMPTY_FILTERS,
  browserStore,
  clearDraft,
  clearProgress,
  emptyProgress,
  loadDraft,
  loadProgress,
  saveDraft,
  saveProgress,
  type QuizAnswerValue,
  type SavedProgress,
} from "@/components/start/storage";
import { Glass, Note, ProgressHeader, SampleBadge } from "@/components/start/ui";
import { WayForward } from "@/components/start/way-forward";
import { WelcomeStep } from "@/components/start/welcome-step";
import { experiencePhrase, lowerFirst } from "@/components/start/wording";
import { trackOnboarding } from "@/lib/telemetry";
import type { PlanStepKind } from "@shared/onboarding/types";

/**
 * /app/start: Duolingo-style onboarding. In about five minutes the student answers a short
 * quiz, adds a resume (parsed on this device), sees their strongest matches with plain
 * reasons, picks one program and finishes the first steps of applying.
 *
 * Privacy by construction:
 * - Autosave (localStorage) holds only the stage, non-private quiz answers, the chosen program,
 *   finished steps, filters and the reminder slot (storage.ts sanitizes on every write).
 * - Resume text, parsed fields, private eligibility answers and recommender names live in React
 *   memory only. The "Why this program?" draft does too, unless the student turns on "Keep my
 *   draft on this device" (its own storage key, cleared by "Forget this on my device").
 * - The only network calls with student input are: quiz preferences (signed in), the redacted
 *   resume text after explicit consent, and the first-door save (signed in, on request).
 * - Funnel analytics (`onboarding_step`, built by shared/onboarding's `onboardingEvent()`) carry
 *   counts, closed codes and flags only: never an answer, a program, resume content or a
 *   private answer. They follow the app's telemetry consent (off under GPC and in minor mode).
 *   The funnel actor is the telemetry session id, so a journey that spans two browsing
 *   sessions starts a new funnel at `started` when the student picks up again.
 */

const EMPTY_MEMORY: DoorMemory = { privateAnswers: {}, draft: "", recommenders: [], keepDraft: false };

/** The strict preferences "Widen my search" drops (answers become skips). */
const STRICT_QUESTIONS = ["pay", "location", "timing"] as const;

function localToday(now: Date): string {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function attempt<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

type Prefs = ReturnType<typeof preferencesOf>;

export default function StartPage() {
  const now = useMemo(() => new Date(), []);
  const today = useMemo(() => localToday(now), [now]);
  const store = useMemo(() => browserStore(), []);
  const questions = useMemo<QuestionView[]>(() => attempt(quizQuestions, []), []);
  const privateIds = useMemo(() => new Set(questions.filter((q) => q.private).map((q) => q.id)), [questions]);

  // A saved session opens on the welcome screen with "Pick up where you left off", except when
  // the student comes back from sign-in to save the plan (?save=1): then straight to Done.
  const [initial] = useState(() => loadProgress(store, privateIds));
  const [saveIntent, setSaveIntent] = useState(
    () => typeof window !== "undefined" && hasSaveIntent(window.location.search) && Boolean(initial?.chosenProgramId),
  );
  const [progress, setProgress] = useState<SavedProgress>(() =>
    initial ? { ...initial, stage: saveIntent ? "done" : "welcome" } : emptyProgress(now),
  );
  const [resumeTo, setResumeTo] = useState<Stage | null>(() => (initial && !saveIntent && initial.stage !== "welcome" ? initial.stage : null));
  const [privateQuiz, setPrivateQuiz] = useState<Record<string, QuizAnswerValue>>({});
  const [signals, setSignals] = useState<SignalsView | null>(null);
  const [catalog, setCatalog] = useState<Catalog>(() => ({ bundles: buildSamplePrograms(now), sample: true, source: "fixtures" }));
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [catalogReady, setCatalogReady] = useState(false);
  const [memory, setMemory] = useState<DoorMemory>(EMPTY_MEMORY);
  const [saveState, setSaveState] = useState<SaveState>("idle");

  const [retry, setRetry] = useState(0);
  const mainRef = useRef<HTMLDivElement>(null);

  const stage = progress.stage;
  const update = useCallback((patch: Partial<SavedProgress>) => setProgress((p) => ({ ...p, ...patch })), []);
  // Every stage is a history entry, so the browser and Android back buttons step back inside
  // onboarding (see the popstate handler below) instead of leaving /app/start.
  const goTo = useCallback((s: Stage) => {
    update({ stage: s });
    pushStage(s);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, [update]);

  // Title and focus follow the stage. QuizStep focuses its own question heading.
  const firstStage = useRef(true);
  useEffect(() => {
    document.title = STAGE_TITLES[stage];
    if (firstStage.current) {
      firstStage.current = false;
      return;
    }
    if (stage !== "quiz") focusFirstHeading(mainRef.current);
  }, [stage]);

  // Autosave after every change; storage.ts drops anything not on its allowlist.
  useEffect(() => {
    // While the resume prompt is showing, keep the saved stage so a reload still resumes.
    const savedStage = progress.stage === "welcome" && resumeTo ? resumeTo : progress.stage;
    saveProgress(store, { ...progress, stage: savedStage, savedAt: new Date().toISOString() }, privateIds);
  }, [progress, store, privateIds, resumeTo]);

  // Session and AI availability, then the catalogue. Both fail soft to device-only + samples.
  useEffect(() => {
    let live = true;
    void getState().then((r) => {
      if (!live) return;
      setSignedIn(r.ok);
      setAiEnabled(r.ok ? r.data.ai?.enabled === true : null);
      setSessionChecked(true);
    });
    void loadCatalog(now).then((c) => {
      if (!live) return;
      setCatalog(c);
      setCatalogReady(true);
    });
    return () => {
      live = false;
    };
  }, [now]);

  /* ---------- quiz ---------- */

  const allAnswers = useMemo(() => ({ ...progress.quizAnswers, ...privateQuiz }), [progress.quizAnswers, privateQuiz]);
  const timeZone = useMemo(() => browserTimeZone(), []);
  const quizState = useMemo(
    () => attempt(() => replayQuiz(allAnswers, progress.quizOrder, { bundles: catalog.bundles, signals, timeZone, now }), null),
    [allAnswers, progress.quizOrder, catalog, signals, timeZone, now],
  );
  const askable = useMemo(() => questions.filter((q) => q.kind !== "resume"), [questions]);

  // The quiz decides what comes next (adaptive pairs, resume prefill). If it is unavailable,
  // fall back to the spec order so the student is never stuck.
  const current: QuestionView | null = useMemo(() => {
    if (quizState) return attempt(() => nextQuestionView(quizState), null);
    return questions.find((q) => !(q.id in allAnswers)) ?? null;
  }, [quizState, questions, allAnswers]);

  const preferences: Prefs | null = useMemo(() => (quizState ? attempt(() => preferencesOf(quizState), null) : null), [quizState]);

  const recordAnswer = (q: QuestionView, value: QuizAnswerValue) => {
    if (quizState) {
      // Validate through the engine first so an answer it rejects is not saved.
      const ok = attempt(() => (answer(quizState, q.id, value), true), false);
      if (!ok) value = null;
    }
    const order = progress.quizOrder.filter((id) => id !== q.id).concat(q.id);
    if (q.private) {
      setPrivateQuiz((p) => ({ ...p, [q.id]: value }));
      update({ quizOrder: order });
    } else {
      update({ quizAnswers: { ...progress.quizAnswers, [q.id]: value }, quizOrder: order });
    }
  };

  /**
   * Takes back the last answer so the quiz reopens that question. `skipResume` steps over the
   * resume entry (going back from the resume screen means the question before it).
   */
  const popLastAnswer = (skipResume = false): boolean => {
    const order = skipResume ? progress.quizOrder.filter((id) => id !== "resume") : [...progress.quizOrder];
    const last = order[order.length - 1];
    if (!last) return false;
    const answers = { ...progress.quizAnswers };
    delete answers[last];
    setPrivateQuiz((p) => {
      const n = { ...p };
      delete n[last];
      return n;
    });
    update({ quizAnswers: answers, quizOrder: progress.quizOrder.filter((id) => id !== last) });
    return true;
  };

  const goBackInQuiz = () => {
    if (!popLastAnswer()) goTo("welcome");
  };

  /** "Change my answers" and Back from the resume screen: reopen the previous question. */
  const editAnswers = (fromResume = false) => {
    if (!popLastAnswer(fromResume)) return goTo("welcome");
    goTo("quiz");
  };

  /** "Widen my search": skip the strict questions and clear the match filters. */
  const widen = () => {
    const answers = { ...progress.quizAnswers };
    const order = [...progress.quizOrder];
    for (const id of STRICT_QUESTIONS) {
      answers[id] = null;
      if (!order.includes(id)) order.push(id);
    }
    update({ quizAnswers: answers, quizOrder: order, filters: EMPTY_FILTERS });
    if (stage !== "matches") goTo("matches");
  };

  // System back/forward: show the entry's stage; back to the quiz reopens the last answer,
  // because a fully answered quiz would otherwise forward straight back to matches.
  const onHistory = useRef<(target: Stage) => void>(() => undefined);
  onHistory.current = (target: Stage) => {
    if (backAction(stage, target) === "pop_answer") popLastAnswer(stage === "resume");
    update({ stage: target });
  };
  useEffect(() => {
    markStage(progress.stage);
    const onPop = (e: PopStateEvent) => {
      const target = stageFromHistoryState(e.state);
      if (target) onHistory.current(target);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // Mount only: the handler reads the latest state through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastPosted = useRef<string | null>(null);

  // The resume is a step inside the quiz (third, so it can prefill later questions). When the
  // quiz has nothing left, move on to matches and keep a server copy if signed in.
  useEffect(() => {
    if (stage !== "quiz") return;
    if (current?.kind === "resume") {
      goTo("resume");
      return;
    }
    if (current) return;
    const asked = progress.quizOrder.filter((id) => id !== "resume");
    trackOnboarding({ step: "quiz_completed", asked: asked.length, skipped: asked.filter((id) => allAnswers[id] === null || allAnswers[id] === undefined).length });
    if (signedIn && preferences) {
      const server = attempt(() => serverPreferencesOf(preferences), null);
      // The resume chips the student confirmed, as closed-vocabulary signals (never resume text).
      const serverSignals = attempt(() => serverSignalsOf(signals), null);
      // Post once per distinct set of answers: coming back to the quiz and leaving it unchanged
      // must not send the same preferences again.
      const key = server ? JSON.stringify([server, serverSignals]) : null;
      if (server && key !== lastPosted.current) {
        lastPosted.current = key;
        void postQuiz({ preferences: server, signals: serverSignals, step: "quiz", completed: true });
      }
    }
    goTo("matches");
    // Fires when the quiz runs out of questions; the answer maps are read, not watched.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, current, signedIn, preferences, signals, goTo]);

  /* ---------- matching ---------- */

  const bundleMap = useMemo(() => new Map<string, ProgramBundle>(catalog.bundles.map((b) => [b.card.programId, b])), [catalog]);

  // Private answers (memory only) refine eligibility on this device; they are never sent.
  const eligibility = useMemo(() => deviceEligibilityAdapter(memory.privateAnswers), [memory.privateAnswers]);
  const run = useMemo(() => {
    if (!preferences || (stage !== "matches" && stage !== "door" && stage !== "done")) return null;
    return attempt(() => runMatches(preferences, signals, catalog.bundles, now, 10, eligibility), null);
    // `retry` re-runs matching after "Try again".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences, signals, catalog, now, stage, retry, eligibility]);

  const shownRun = useRef<unknown>(null);
  useEffect(() => {
    if (stage !== "matches" || !run || shownRun.current === run.raw) return;
    shownRun.current = run.raw;
    trackOnboarding({ step: "matches_shown", matches: run.raw });
  }, [stage, run]);

  const matches: MatchView[] = useMemo(() => (run ? run.views.filter((m) => bundleMap.has(m.programId)) : []), [run, bundleMap]);
  const matchMap = useMemo(() => new Map(matches.map((m) => [m.programId, m])), [matches]);

  const doors: DoorOptionView[] = useMemo(() => {
    if (!run || !preferences) return [];
    const picked = attempt(() => firstDoors(run.raw, preferences, now), []).filter((d) => matchMap.has(d.programId));
    return picked.length ? picked : fallbackDoors(matches);
  }, [run, preferences, now, matches, matchMap]);

  const chosen = progress.chosenProgramId ? bundleMap.get(progress.chosenProgramId) : undefined;
  const plan = useMemo(() => {
    if (!chosen) return null;
    const planned = attempt(() => planFor(chosen, signals, now, preferences, aiEnabled === true), null);
    if (planned && planned.steps.length) return planned;
    return { steps: fallbackPlan(chosen.requirements, applicationDate(chosen.card), today), meta: { draftTemplate: null, missingKeywords: [] } };
  }, [chosen, signals, now, today, preferences, aiEnabled]);
  const steps: PlanStepView[] = useMemo(() => plan?.steps ?? [], [plan]);

  const done = useMemo(() => new Set(progress.doneStepIds), [progress.doneStepIds]);

  // Choosing (or changing) the program: back to the top, focus on the chosen card's heading.
  const lastChosen = useRef(progress.chosenProgramId);
  useEffect(() => {
    if (lastChosen.current === progress.chosenProgramId) return;
    lastChosen.current = progress.chosenProgramId;
    if (stage !== "door") return;
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    focusFirstHeading(mainRef.current);
  }, [progress.chosenProgramId, stage]);

  // A draft the student chose to keep on this device comes back with its program.
  const [keptDraft] = useState(() => loadDraft(store));
  useEffect(() => {
    if (keptDraft && progress.chosenProgramId === keptDraft.programId) {
      setMemory((m) => (m.draft ? m : { ...m, draft: keptDraft.text, keepDraft: true }));
    }
  }, [keptDraft, progress.chosenProgramId]);

  /** Door memory setter that also keeps (or forgets) the opt-in device copy of the draft. */
  const setDoorMemory = (next: DoorMemory) => {
    setMemory((prev) => {
      if (chosen && next.keepDraft) saveDraft(store, { programId: chosen.card.programId, text: next.draft });
      else if (prev.keepDraft && !next.keepDraft) clearDraft(store);
      return next;
    });
  };
  const markDone = (id: string, value = true) => {
    const next = new Set(progress.doneStepIds);
    if (value && !next.has(id)) {
      const kind = steps.find((st) => st.id === id)?.kind;
      // onboardingEvent refuses a kind outside PLAN_STEP_KINDS, so nothing is sent for one.
      if (kind) trackOnboarding({ step: "first_step_done", kind: kind as PlanStepKind });
    }
    if (value) next.add(id);
    else next.delete(id);
    update({ doneStepIds: [...next] });
  };

  const prefRecord = (preferences ?? {}) as Record<string, unknown>;
  const classYear = typeof prefRecord.classYear === "string" ? prefRecord.classYear : null;
  const interests = Array.isArray(prefRecord.interests) ? (prefRecord.interests as string[]) : [];

  const draftSeed: DraftSeed | null = chosen
    ? {
        programName: chosen.card.name,
        organizationName: chosen.card.organizationName,
        skills: signals?.skills ?? [],
        interest: (() => {
          const label = interestLabel(interests[0]);
          return label ? lowerFirst(label) : signals?.fields[0] ?? null;
        })(),
        experience: experiencePhrase(signals?.experienceKinds ?? []),
        template: plan?.meta.draftTemplate ?? null,
      }
    : null;

  /* ---------- save, forget ---------- */

  const savePlan = async () => {
    if (!chosen) return;
    setSaveState("saving");
    const target = reminderTarget(steps, done);
    const r = await postFirstDoor({
      programId: chosen.program.id,
      programCycleId: chosen.cycle.id,
      completedStepIds: serverStepIds(done),
      intention: progress.reminder && target ? { stepId: target.id, on: progress.reminder.date, at: progress.reminder.time } : null,
      timeZone: browserTimeZone(),
    });
    if (r.ok) {
      setSaveState("saved");
      trackOnboarding({ step: "tracker_created", deviceOnly: false });
    }
    else if (r.reason === "signed_out") {
      setSignedIn(false);
      setSaveState("device");
    } else if (r.reason === "consent_required") setSaveState("device");
    else setSaveState("failed");
  };

  // Back from sign-in with ?save=1: save the plan once the session and the catalogue are known,
  // then drop the intent from the URL so a reload does not save again.
  useEffect(() => {
    if (!saveIntent || !sessionChecked || !catalogReady) return;
    setSaveIntent(false);
    try {
      const { pathname, search, hash } = window.location;
      window.history.replaceState(window.history.state, "", `${pathname}${withoutSaveIntent(search)}${hash}`);
    } catch {
      /* the URL is cosmetic; the intent is already cleared in state */
    }
    if (signedIn && chosen && saveState === "idle") void savePlan();
    // savePlan reads the latest render; this runs once when the intent can be acted on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveIntent, sessionChecked, catalogReady, signedIn, chosen, saveState]);

  const forget = () => {
    clearProgress(store);
    clearDraft(store);
    setPrivateQuiz({});
    setSignals(null);
    setMemory(EMPTY_MEMORY);
    setSaveState("idle");
    setResumeTo(null);
    setProgress(emptyProgress(new Date()));
  };

  /* ---------- progress within a stage ---------- */

  const quick = steps.filter((s) => s.doneDuringOnboarding);
  // Questions still to come after the resume, for the resume screen's last button.
  const questionsLeft = current?.kind === "resume" && current.progress
    ? Math.max(0, current.progress.of - current.progress.step)
    : askable.filter((q) => !(q.id in allAnswers)).length;
  const quizWithin = current?.progress
    ? Math.min(1, Math.max(0, (current.progress.step - 1) / current.progress.of))
    : askable.length
      ? Math.min(1, progress.quizOrder.length / askable.length)
      : 0;
  const within =
    stage === "quiz" || stage === "resume"
      ? quizWithin
      : stage === "door"
        ? steps.length
          ? doneCount(quick, done) / Math.max(1, quick.length)
          : 0
        : 0;

  const onResumeDone = (r: ResumeOutcome) => {
    setSignals(r.signals);
    trackOnboarding({ step: "resume_parsed", source: r.source, ok: r.source !== "none" && r.signals !== null });
    // "none" and a skip both count as a skipped resume question; the builder counts as pasted text.
    const value: QuizAnswerValue = r.source === "none" ? null : r.source;
    const order = progress.quizOrder.filter((id) => id !== "resume").concat("resume");
    update({ resumeSource: r.source, quizAnswers: { ...progress.quizAnswers, resume: value }, quizOrder: order });
    goTo("quiz");
  };

  return (
    <div className="nv-start">
      <div className="st-scene" aria-hidden="true">
        <div className="st-orb" />
      </div>
      <div className="st-wrap">
        <header className="st-top">
          <a className="st-brand" href="/" aria-label="Novus home">
            NOVUS
          </a>
          <span className="st-spacer" />
          {catalog.sample && stage !== "welcome" && <SampleBadge />}
        </header>

        {stage !== "welcome" && stage !== "done" && (
          <ProgressHeader stage={stage === "resume" ? "quiz" : stage} label={stage === "resume" ? "Your resume" : undefined} within={within} />
        )}

        {/* The app shell already renders <main id="main">; a second one would nest landmarks. */}
        <div ref={mainRef} className="st-main">
          {stage === "welcome" && (
            <WelcomeStep
              resumable={resumeTo !== null}
              onStart={() => {
                trackOnboarding({ step: "started" });
                const to = resumeTo ?? nextStage("welcome");
                setResumeTo(null);
                goTo(to);
              }}
              onRestart={forget}
            />
          )}

          {stage === "quiz" && current && (
            <QuizStep
              // A fresh draft per question: without the key, the first render of a new question
              // still held the last answer (a slider showed Continue disabled for one frame).
              key={current.id}
              question={current}
              number={current.progress ? Math.max(1, current.progress.step - 1) : Math.min(progress.quizOrder.length + 1, Math.max(askable.length, 1))}
              total={current.progress ? Math.max(1, current.progress.of - 1) : Math.max(askable.length, progress.quizOrder.length + 1)}
              previous={allAnswers[current.id]}
              canGoBack={progress.quizOrder.length > 0}
              onAnswer={(v) => recordAnswer(current, v)}
              onSkip={() => recordAnswer(current, null)}
              onBack={goBackInQuiz}
            />
          )}

          {stage === "resume" && (
            <ResumeStep now={now} aiEnabled={aiEnabled} onDone={onResumeDone} onBack={() => editAnswers(true)} questionsLeft={questionsLeft} />
          )}

          {stage === "matches" &&
            (run ? (
              <MatchesStep
                matches={matches}
                bundles={bundleMap}
                sample={catalog.sample}
                sampleSource={catalog.source}
                filters={progress.filters}
                setFilters={(f) => update({ filters: f })}
                hadResume={signals !== null}
                onNext={() => goTo("door")}
                onBack={() => editAnswers()}
                onWiden={widen}
              />
            ) : (
              <Glass aria-labelledby="st-nomatch-title">
                <h2 id="st-nomatch-title" className="st-h2">
                  Matching isn't available right now
                </h2>
                <div style={{ marginTop: 12 }}>
                  <Note tone="warn">There's nothing to show yet. Your answers are saved on this device, so trying again keeps them.</Note>
                </div>
                <WayForward
                  onRetry={() => {
                    setRetry((n) => n + 1);
                    void loadCatalog(now).then(setCatalog);
                  }}
                  onEditAnswers={() => editAnswers()}
                />
              </Glass>
            ))}

          {stage === "door" && (
            <DoorStep
              doors={doors}
              matches={matchMap}
              bundles={bundleMap}
              chosenId={progress.chosenProgramId}
              onChoose={(id) => {
                const tier = id ? matchMap.get(id)?.tier : undefined;
                if (tier && id !== progress.chosenProgramId) trackOnboarding({ step: "first_door_chosen", tier });
                update({ chosenProgramId: id, doneStepIds: id === progress.chosenProgramId ? progress.doneStepIds : [] });
              }}
              steps={steps}
              done={done}
              markDone={markDone}
              memory={memory}
              setMemory={setDoorMemory}
              reminder={progress.reminder}
              setReminder={(r) => update({ reminder: r })}
              draftSeed={draftSeed}
              classYear={classYear}
              haveResume={signals !== null}
              aiEnabled={aiEnabled}
              now={now}
              today={today}
              onFinish={() => goTo("done")}
              onBack={() => goTo("matches")}
              onEditAnswers={() => editAnswers()}
              onWiden={widen}
            />
          )}

          {stage === "done" && chosen && (
            <DoneStep
              programName={chosen.card.name}
              applyUrl={chosen.card.applicationUrl ?? chosen.card.officialUrl}
              doneCount={doneCount(steps, done)}
              total={steps.length}
              next={nextOpenStep(steps, done)}
              saveState={saveState}
              signedIn={signedIn}
              onSave={() => void savePlan()}
              onForget={forget}
              draft={memory.draft}
              keepDraft={memory.keepDraft}
              setKeepDraft={(v) => setDoorMemory({ ...memory, keepDraft: v })}
            />
          )}
          {stage === "done" && !chosen && (
            <Glass>
              <p>Pick a program to finish your first steps.</p>
              <div className="st-actions">
                <button type="button" className="st-btn st-btn-go" onClick={() => goTo("door")}>
                  Choose my first door
                </button>
              </div>
            </Glass>
          )}
        </div>
      </div>
    </div>
  );
}
