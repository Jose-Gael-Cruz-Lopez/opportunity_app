import { useId, useMemo, useRef, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { ArrowUp, Award, CalendarDays, ExternalLink, ListChecks, Lock, Power, Sparkles, Users } from "lucide-react";
import type { AiMeta, AskResponse } from "@shared/contracts";
import { PRODUCT } from "@shared/config/product";
import { GlassPanel, PageShell, SampleNotice } from "@/components/forms/surfaces";
import { usePrefs } from "@/components/forms/prefs";
import { appHref, programHref } from "@/components/forms/links";
import { todayIso } from "@/components/forms/dates";
import { isUnauthenticated } from "@/components/forms/request";
import { cn } from "@/lib/utils";
import { useAsk, useDisplayName } from "./data";
import {
  ANSWER_TYPE_WORDS,
  assistantState,
  checkQuestion,
  degradedMessage,
  programFromSearch,
  splitAnswer,
  suggestions,
  type AssistantState,
  type SuggestionIcon,
} from "./model";

/**
 * Ask Novus: questions about programs, answered only from Novus records and official program
 * pages, each claim cited. With no Gemini key the server answers with a plain search, and the
 * page says so. The student can switch the assistant off on this device in Settings.
 */

interface Turn {
  readonly id: number;
  readonly question: string;
  readonly result: { response: AskResponse; sample: boolean } | null;
  readonly error: string | null;
}

const ICONS: Record<SuggestionIcon, typeof CalendarDays> = {
  calendar: CalendarDays,
  users: Users,
  list: ListChecks,
  award: Award,
};

export default function AskPage() {
  const today = todayIso();
  const [prefs, setPrefs] = usePrefs();
  const name = useDisplayName();
  const askM = useAsk();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);
  const nextId = useRef(1);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const programSlug = useMemo(() => (typeof window === "undefined" ? null : programFromSearch(window.location.search)), []);

  const lastMeta: AiMeta | null = [...turns].reverse().find((t) => t.result)?.result?.response.meta ?? null;
  const state = assistantState(prefs.aiAssistant, lastMeta);
  const off = state === "off_by_you";
  const anySample = turns.some((t) => t.result?.sample);

  const send = (raw: string) => {
    if (off || askM.isPending) return;
    const check = checkQuestion(raw);
    if (!check.ok) {
      setInputError(
        check.reason === "personal_status"
          ? `This question shares your ${check.topic}. Novus never sends that to a server or an AI. Ask about the program's rule instead (for example, "Who is eligible?"), then use the private check on the program's page, which runs on this device.`
          : check.reason === "too_long"
            ? `Questions can be up to ${PRODUCT.ai.maxQuestionChars} characters.`
            : "Type a question of at least a few words.",
      );
      inputRef.current?.focus();
      return;
    }
    setInputError(null);
    setDraft("");
    const id = nextId.current++;
    setTurns((t) => [...t, { id, question: check.question, result: null, error: null }]);
    askM.mutate(
      { question: check.question, programSlug },
      {
        onSuccess: (result) => setTurns((t) => t.map((x) => (x.id === id ? { ...x, result } : x))),
        onError: (err) =>
          setTurns((t) =>
            t.map((x) =>
              x.id === id
                ? { ...x, error: isUnauthenticated(err) ? "Sign in to ask Novus. Answers use your saved programs." : "Novus could not answer just now. Try again in a moment." }
                : x,
            ),
          ),
      },
    );
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    send(draft);
  };

  return (
    <PageShell labelledBy="ask-title">
      <div className="mx-auto flex max-w-[820px] flex-col items-center pt-2 text-center">
        <div className="nvp-orb" data-off={off || state === "off_on_server" ? "" : undefined} aria-hidden="true">
          <Sparkles size={34} fill="currentColor" strokeWidth={0} />
        </div>
        <h1 id="ask-title" className="mt-8 text-[clamp(32px,4vw,50px)] font-bold leading-[1.08] tracking-[-0.025em]">
          Hello{name ? ` ${name}` : ""},
          <br />
          <span className="nvp-soft">I'm Novus.</span>
        </h1>
        <p className="mt-3 max-w-[46ch] text-[17px] text-[color:var(--nvp-ink-3)]">
          Ask about any program. Every answer cites the program's own pages, and I never apply for you.
        </p>
        <StatusPill state={state} />
        {programSlug ? <p className="nvp-meta mt-2">Questions are about: {programSlug}</p> : null}
        {anySample ? <SampleNotice>Sample answers: the Novus API is not connected, so these use made-up programs.</SampleNotice> : null}

        {off ? (
          <AiOffPanel onTurnOn={() => setPrefs({ aiAssistant: true })} />
        ) : (
          <>
            {turns.length === 0 ? (
              <div className="mt-8 grid w-full grid-cols-1 gap-3 sm:grid-cols-2" role="group" aria-label="Suggested questions">
                {suggestions(today).map((s) => {
                  const Icon = ICONS[s.icon];
                  return (
                    <button key={s.id} type="button" className="nvp-tile" onClick={() => send(s.question)} disabled={askM.isPending}>
                      <Icon size={22} strokeWidth={1.6} aria-hidden="true" />
                      {s.question}
                    </button>
                  );
                })}
              </div>
            ) : null}

            <ol className="mt-6 flex w-full flex-col gap-3 text-left" aria-label="Conversation" aria-live="polite" aria-relevant="additions">
              {turns.map((t) => (
                <TurnView key={t.id} turn={t} onFollowUp={send} />
              ))}
            </ol>

            <form className="nvp-composer mt-6" onSubmit={onSubmit} aria-describedby={`${inputId}-note`}>
              <div className="nvp-composer-field">
                <label htmlFor={inputId} className="sr-only">
                  Your question
                </label>
                <input
                  id={inputId}
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    if (inputError) setInputError(null);
                  }}
                  placeholder="Type a question"
                  autoComplete="off"
                  maxLength={PRODUCT.ai.maxQuestionChars}
                  aria-invalid={inputError ? true : undefined}
                  aria-describedby={inputError ? `${inputId}-err` : undefined}
                />
              </div>
              <button type="submit" className="nvp-round nvp-round-go" aria-label="Send question" disabled={askM.isPending || draft.trim().length === 0}>
                <ArrowUp size={20} aria-hidden="true" />
              </button>
            </form>
            {inputError ? (
              <p id={`${inputId}-err`} className="nvp-error mt-3 max-w-[60ch] text-left" role="alert">
                {inputError}
              </p>
            ) : null}
            <p id={`${inputId}-note`} className="nvp-meta mt-3 flex max-w-[60ch] items-start gap-2 text-left">
              <Lock size={14} className="mt-0.5 flex-none" aria-hidden="true" />
              Do not share citizenship, income or identity here. Questions about those are answered by the private check on each program's page, on your
              device.
            </p>
          </>
        )}
      </div>
    </PageShell>
  );
}

function StatusPill({ state }: { state: AssistantState }) {
  const words: Record<AssistantState, string> = {
    on: "AI answers on · cited sources only",
    unknown: "Answers cite program sources",
    degraded: "AI answer unavailable for the last question",
    off_on_server: "AI is off · answers are plain searches of Novus records",
    off_by_you: "AI is off on this device",
  };
  const dim = state === "off_by_you" || state === "off_on_server" || state === "degraded";
  return (
    <p className="mt-5 inline-flex items-center gap-2 rounded-full border border-[color:var(--nvp-line)] px-3.5 py-1.5 text-[13px]" role="status">
      <span
        aria-hidden="true"
        className={cn("inline-block h-2 w-2 rounded-full", dim ? "bg-[color:var(--nvp-ink-3)]" : "bg-[color:var(--nvp-good)]")}
      />
      {words[state]}
    </p>
  );
}

function AiOffPanel({ onTurnOn }: { onTurnOn: () => void }) {
  return (
    <GlassPanel className="mt-8 w-full rounded-[28px] p-6 text-left" aria-labelledby="ai-off-title">
      <div className="flex items-start gap-3">
        <Power size={22} className="mt-1 flex-none" aria-hidden="true" />
        <div>
          <h2 id="ai-off-title" className="text-[19px] font-semibold">
            AI is off
          </h2>
          <p className="mt-1 text-[15px] text-[color:var(--nvp-ink-2)]">
            You switched the assistant off on this device, so nothing is sent to it. Everything else still works: program pages, eligibility checks,
            readiness and your roadmap do not use AI to decide anything.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="nvp-btn nvp-btn-cream" onClick={onTurnOn}>
              Turn the assistant on
            </button>
            <Link href={appHref("/settings")} className="nvp-btn">
              Privacy settings
            </Link>
            <Link href={appHref("/explore")} className="nvp-btn">
              Search programs
            </Link>
          </div>
        </div>
      </div>
    </GlassPanel>
  );
}

function TurnView({ turn, onFollowUp }: { turn: Turn; onFollowUp: (q: string) => void }) {
  return (
    <li className="flex flex-col gap-3">
      <p className="nvp-bub nvp-bub-me">
        <span className="sr-only">You asked: </span>
        {turn.question}
      </p>
      {turn.error ? (
        <div className="nvp-glass nvp-bub nvp-bub-ai" role="alert">
          {turn.error}
        </div>
      ) : turn.result ? (
        <AnswerView response={turn.result.response} onFollowUp={onFollowUp} />
      ) : (
        <div className="nvp-glass nvp-bub nvp-bub-ai" aria-busy="true">
          <span className="nvp-meta">Checking Novus sources…</span>
        </div>
      )}
    </li>
  );
}

function AnswerView({ response, onFollowUp }: { response: AskResponse; onFollowUp: (q: string) => void }) {
  const segments = splitAnswer(response.answer, response.citations);
  const note = degradedMessage(response.meta);
  return (
    <div className="nvp-glass nvp-bub nvp-bub-ai">
      <span className="sr-only">Novus answered: </span>
      <p className="nvp-label mb-2">{ANSWER_TYPE_WORDS[response.answerType]}</p>
      <p>
        {segments.map((s, i) =>
          s.kind === "text" ? (
            <span key={i}>{s.text}</span>
          ) : (
            <a key={i} href={`#cite-${s.sourceId}`} className="ml-0.5 align-super text-[11px] font-semibold text-[color:var(--nvp-wheat)]" aria-label={`Source ${s.number}`}>
              [{s.number}]
            </a>
          ),
        )}
      </p>
      {note ? (
        <p className="nvp-meta mt-3" role="note">
          {note}
        </p>
      ) : null}
      {response.answerType === "declined_sensitive" ? (
        <p className="mt-3 text-[14px] text-[color:var(--nvp-ink-2)]">Use the private check on the program's page. Your answers there stay on this device.</p>
      ) : null}

      {response.citations.length > 0 ? (
        <section className="mt-4" aria-label="Sources">
          <h3 className="nvp-label mb-2">Sources</h3>
          <ol className="flex flex-col gap-2">
            {response.citations.map((c, i) => (
              <li key={c.sourceId} id={`cite-${c.sourceId}`} className="nvp-cite">
                <span className="nvp-cite-num" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold hover:underline">
                      {c.title}
                      <ExternalLink size={13} aria-hidden="true" />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  ) : (
                    <b className="font-semibold">{c.title}</b>
                  )}
                  {c.quote ? <q className="mt-1 block text-[13.5px] text-[color:var(--nvp-ink-3)]">{c.quote}</q> : null}
                  <span className="nvp-meta block">{c.kind === "program_page" ? "Official program page" : c.kind === "novus_record" ? "Novus record" : "Novus method"}</span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {response.programRefs.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Programs in this answer">
          {response.programRefs.map((p) => (
            <Link key={p.slug} href={programHref(p.slug)} className="nvp-chip">
              {p.name}
            </Link>
          ))}
        </div>
      ) : null}

      {response.followUps.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Follow-up questions">
          {response.followUps.map((f) => (
            <button key={f} type="button" className="rounded-full border border-[color:var(--nvp-line)] px-3 py-1.5 text-[13.5px] text-[color:var(--nvp-ink-2)] hover:bg-white/10" onClick={() => onFollowUp(f)}>
              {f}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
