import { useMemo, useState } from "react";
import { draftTips, templateDraft, type DraftSeed } from "./draft";
import { buildIcs, isValidLocalDate, isValidLocalTime, suggestSlot } from "./ics";
import { RECOMMENDER_ROLES, askBy, askEmail, mailtoHref, type RecommenderPick } from "./letters";
import type { PrivateAnswers, PrivateField, ReadinessView } from "./readiness-view";
import { draftFileName, type SavedReminder } from "./storage";
import { Chip, Note, StatusTag, Toggle } from "./ui";
import { shortDate } from "./wording";

/**
 * Inline panels for the first-door screen: readiness in four parts with the private
 * eligibility questions, the practice draft, recommenders and the reminder. Private answers,
 * draft text and recommender names are props from React memory; none of them is autosaved.
 */

/* ---------- readiness, four parts ---------- */

const CITIZENSHIP_OPTIONS = [
  { value: "us_citizen", label: "U.S. citizen" },
  { value: "us_national", label: "U.S. national" },
  { value: "permanent_resident", label: "Permanent resident" },
  { value: "daca", label: "DACA recipient" },
  { value: "tps", label: "Temporary Protected Status" },
  { value: "refugee_asylee", label: "Refugee or asylee" },
  { value: "f1", label: "F-1 student visa" },
  { value: "j1", label: "J-1 visa" },
  { value: "other_visa", label: "Another visa" },
  { value: "none_of_these", label: "None of these" },
  { value: "prefer_not", label: "Prefer not to say" },
];
const PELL_OPTIONS = [
  { value: "recipient", label: "I receive a Pell Grant" },
  { value: "eligible_not_receiving", label: "Eligible, not receiving" },
  { value: "not_recipient", label: "No" },
  { value: "prefer_not", label: "Prefer not to say" },
];
const STATUS_OPTIONS = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "not_sure", label: "Not sure" },
  { value: "prefer_not", label: "Prefer not to say" },
];
const PRIVATE_QUESTIONS: Record<PrivateField, { label: string; options: Array<{ value: string; label: string }> }> = {
  citizenship: { label: "Citizenship or immigration status", options: CITIZENSHIP_OPTIONS },
  pell: { label: "Federal Pell Grant", options: PELL_OPTIONS },
  firstGeneration: { label: "First in your family to go to college", options: STATUS_OPTIONS },
};

export function ReadinessPanel({
  view,
  privateAnswers,
  setPrivateAnswers,
}: {
  view: ReadinessView;
  privateAnswers: PrivateAnswers;
  setPrivateAnswers: (p: PrivateAnswers) => void;
}) {
  const needs = Array.from(new Set(view.eligibility.rows.flatMap((r) => r.needs)));
  const eligTone = view.eligibility.status === "eligible" ? undefined : view.eligibility.status === "not_eligible" ? "bad" : "warn";
  const eligText = view.eligibility.status === "eligible" ? "Looks eligible" : view.eligibility.status === "not_eligible" ? "Not eligible as listed" : "Check one thing";

  return (
    <div className="st-four" aria-label="Readiness in four parts">
      <div className="st-panel-sub">
        <h4>1 · Eligibility</h4>
        <StatusTag tone={eligTone}>{eligText}</StatusTag>
        <ul className="st-rows" style={{ marginTop: 10 }}>
          {view.eligibility.rows.map((r) => (
            <li key={r.id}>
              <span aria-hidden="true">{r.verdict === "met" ? "✓" : r.verdict === "not_met" ? "×" : "?"}</span>
              <span>
                <span className="st-sr">{r.verdict === "met" ? "Met: " : r.verdict === "not_met" ? "Not met: " : "Need to check: "}</span>
                {r.text}
                {r.private && <span className="st-meta"> · checked only in this browser</span>}
              </span>
            </li>
          ))}
          {!view.eligibility.rows.length && <li className="st-muted">Novus hasn't checked this program's rules yet. See the official page.</li>}
        </ul>
        {needs.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <p className="st-small">Answer privately to check:</p>
            {needs.map((f) => (
              <div className="st-field" key={f} style={{ marginTop: 8 }}>
                <label className="st-label" htmlFor={`st-priv-${f}`}>
                  {PRIVATE_QUESTIONS[f].label}
                </label>
                <select
                  id={`st-priv-${f}`}
                  className="st-select"
                  value={privateAnswers[f] ?? ""}
                  onChange={(e) => setPrivateAnswers({ ...privateAnswers, [f]: e.target.value || undefined })}
                >
                  <option value="">Choose…</option>
                  {PRIVATE_QUESTIONS[f].options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            <p className="st-meta" style={{ marginTop: 8 }}>
              Your answer stays in this browser tab. It isn't saved, sent or used for anything else, and it's gone when you close the tab.
            </p>
          </div>
        )}
      </div>

      <div className="st-panel-sub">
        <h4>2 · Requirements</h4>
        <p className="st-small">
          {view.requirements.total ? `${view.requirements.met} of ${view.requirements.total} materials ready` : "No materials listed yet"}
        </p>
        <ul className="st-rows" style={{ marginTop: 10 }}>
          {view.requirements.rows.map((r) => (
            <li key={r.id}>
              <span aria-hidden="true">{r.state === "met" ? "✓" : "○"}</span>
              <span>
                <span className="st-sr">{r.state === "met" ? "Ready: " : "To do: "}</span>
                {r.label}
                {r.startBy && (
                  <span className="st-meta">
                    {" "}
                    · {r.severity === "late" ? "start now" : `start by ${shortDate(r.startBy)}`}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="st-panel-sub">
        <h4>3 · Competitiveness</h4>
        <StatusTag tone="off">Not enough data yet</StatusTag>
        <p className="st-small st-muted" style={{ marginTop: 10 }}>
          {view.competitiveness.text}
        </p>
      </div>

      <div className="st-panel-sub">
        <h4>4 · Next actions</h4>
        <ul className="st-rows">
          {view.nextActions.map((a) => (
            <li key={a.id}>
              <span aria-hidden="true">→</span>
              <span>
                {a.title}
                {a.due && <span className="st-meta"> · by {shortDate(a.due)}</span>}
              </span>
            </li>
          ))}
          {!view.nextActions.length && <li>All the quick steps are done.</li>}
        </ul>
      </div>
    </div>
  );
}

/* ---------- practice rep: two opening sentences ---------- */

export function DraftPanel({
  seed,
  text,
  setText,
  onDone,
  aiEnabled,
  keepOnDevice,
  setKeepOnDevice,
}: {
  seed: DraftSeed;
  text: string;
  setText: (t: string) => void;
  onDone: () => void;
  aiEnabled: boolean | null;
  keepOnDevice: boolean;
  setKeepOnDevice: (v: boolean) => void;
}) {
  const tips = useMemo(() => draftTips(text, seed.programName), [text, seed.programName]);
  const allOk = tips.every((t) => t.ok);
  return (
    <div className="st-stack">
      <div className="st-field">
        <label className="st-label" htmlFor="st-draft">
          Why this program? Two sentences.
        </label>
        <textarea id="st-draft" className="st-textarea" maxLength={800} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="st-row">
        <button type="button" className="st-btn" onClick={() => setText(templateDraft(seed))}>
          Start from a template
        </button>
        <span className="st-meta">Fill in the [blanks] in your own words.</span>
      </div>
      <ul className="st-rows st-small" aria-label="Novus checks">
        {tips.map((t) => (
          <li key={t.id}>
            <span aria-hidden="true">{t.ok ? "✓" : "○"}</span>
            <span className={t.ok ? "st-muted" : undefined}>
              <span className="st-sr">{t.ok ? "Done: " : "To do: "}</span>
              {t.text}
            </span>
          </li>
        ))}
      </ul>
      <p className="st-meta">
        {aiEnabled
          ? "AI feedback on drafts arrives in a later update. These checks run on your device."
          : "AI feedback is off. These checks run on your device and never grade you."}
      </p>
      <DraftKeep programName={seed.programName} text={text} keepOnDevice={keepOnDevice} setKeepOnDevice={setKeepOnDevice} />
      <div>
        <button type="button" className="st-btn st-btn-cream" disabled={!text.trim()} onClick={onDone}>
          {allOk ? "I'm happy with this" : "Good enough for now"}
        </button>
      </div>
    </div>
  );
}

/**
 * Where the draft lives, and the ways to keep it. Novus never sends or saves the draft text to an
 * account, so without Copy, Download or the opt-in device copy a reload would lose it.
 */
export function DraftKeep({
  programName,
  text,
  keepOnDevice,
  setKeepOnDevice,
}: {
  programName: string;
  text: string;
  keepOnDevice: boolean;
  setKeepOnDevice: (v: boolean) => void;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied("copied");
    } catch {
      setCopied("failed");
    }
  };
  const download = () => {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = draftFileName(programName);
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setCopied("failed");
    }
  };
  const empty = !text.trim();
  return (
    <div className="st-stack">
      <div className="st-row">
        <button type="button" className="st-btn" disabled={empty} onClick={() => void copy()}>
          Copy text
        </button>
        <button type="button" className="st-btn" disabled={empty} onClick={download}>
          Download .txt
        </button>
        <span className="st-meta" aria-live="polite">
          {copied === "copied" ? "Copied." : copied === "failed" ? "Couldn't do that here. Select the text and copy it instead." : ""}
        </span>
      </div>
      <Toggle checked={keepOnDevice} onChange={setKeepOnDevice}>
        Keep my draft on this device
      </Toggle>
      <p className="st-meta">
        {keepOnDevice
          ? "Your draft is saved in this browser only, until you turn this off or choose \"Forget this on my device\". It is never sent to Novus."
          : "Your draft lives only in this tab. It is never sent to Novus, so copy or download it before you leave."}
      </p>
    </div>
  );
}

/* ---------- recommenders ---------- */

export function LettersPanel({
  programName,
  deadline,
  picks,
  setPicks,
  onDone,
}: {
  programName: string;
  deadline: string | null;
  picks: RecommenderPick[];
  setPicks: (p: RecommenderPick[]) => void;
  onDone: () => void;
}) {
  const [focus, setFocus] = useState("");
  const first = picks[0];
  const email = askEmail({ programName, deadline, recommenderName: first?.name, focus });
  const by = askBy(deadline);
  return (
    <div className="st-stack">
      <p className="st-small">
        Who knows your work? Pick one or two. {by ? `Ask by ${shortDate(by)} so they have three weeks.` : "Ask soon so they have time."}
      </p>
      <div className="st-chips">
        {RECOMMENDER_ROLES.map((r) => {
          const on = picks.some((p) => p.role === r.id);
          return (
            <Chip key={r.id} pressed={on} onClick={() => setPicks(on ? picks.filter((p) => p.role !== r.id) : [...picks, { role: r.id }].slice(0, 3))}>
              {r.label}
            </Chip>
          );
        })}
      </div>
      {first && (
        <>
          <div className="st-grid2">
            <div className="st-field">
              <label className="st-label" htmlFor="st-rec-name">
                Their name (optional, stays on this device)
              </label>
              <input id="st-rec-name" className="st-input" maxLength={60} value={first.name ?? ""} onChange={(e) => setPicks([{ ...first, name: e.target.value }, ...picks.slice(1)])} />
            </div>
            <div className="st-field">
              <label className="st-label" htmlFor="st-rec-focus">
                What they could speak to
              </label>
              <input id="st-rec-focus" className="st-input" maxLength={120} placeholder="my work in Intro to Data Science" value={focus} onChange={(e) => setFocus(e.target.value)} />
            </div>
          </div>
          <details className="st-details">
            <summary>See the ask email</summary>
            <pre className="st-pre" style={{ marginTop: 8 }}>{`Subject: ${email.subject}\n\n${email.body}`}</pre>
          </details>
          <div className="st-row">
            <a className="st-btn" href={mailtoHref(email.subject, email.body)}>
              Open in my email app
            </a>
            <button type="button" className="st-btn st-btn-cream" onClick={onDone}>
              Done: I know who to ask
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------- implementation intention: when, where, and a calendar file ---------- */

export function ReminderPanel({
  now,
  targetTitle,
  programName,
  reminder,
  setReminder,
  onDone,
}: {
  now: Date;
  targetTitle: string;
  programName: string;
  reminder: SavedReminder | null;
  setReminder: (r: SavedReminder) => void;
  onDone: () => void;
}) {
  const initial = reminder ?? { ...suggestSlot(now), place: "" };
  const [form, setForm] = useState<SavedReminder>(initial);
  const valid = isValidLocalDate(form.date) && isValidLocalTime(form.time);
  const sentence = `I'll work on "${targetTitle}" on ${shortDate(form.date) || "[day]"} at ${form.time || "[time]"}${form.place ? ` at ${form.place}` : ""}.`;

  const download = () => {
    if (!valid) return;
    const ics = buildIcs({
      uid: `novus-start-${form.date}-${form.time.replace(":", "")}@novus.local`,
      date: form.date,
      time: form.time,
      durationMinutes: 45,
      summary: `Novus: ${targetTitle}`,
      description: `Your plan for ${programName}. Open Novus to see the next step.`,
      location: form.place || undefined,
      alarmMinutesBefore: 15,
      now,
    });
    const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "novus-next-step.ics";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <div className="st-stack">
      <p className="st-small">Deciding when and where makes the next step easier to actually do. Pick a slot that's real for you.</p>
      <div className="st-grid2">
        <div className="st-field">
          <label className="st-label" htmlFor="st-rem-date">
            Day
          </label>
          <input id="st-rem-date" type="date" className="st-input" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
        </div>
        <div className="st-field">
          <label className="st-label" htmlFor="st-rem-time">
            Time
          </label>
          <input id="st-rem-time" type="time" className="st-input" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
        </div>
      </div>
      <div className="st-field">
        <label className="st-label" htmlFor="st-rem-place">
          Where (optional)
        </label>
        <input id="st-rem-place" className="st-input" maxLength={60} placeholder="Library, second floor" value={form.place} onChange={(e) => setForm({ ...form, place: e.target.value })} />
      </div>
      <Note>{sentence}</Note>
      <div className="st-row">
        <button type="button" className="st-btn" disabled={!valid} onClick={download}>
          Add to my calendar
        </button>
        <button
          type="button"
          className="st-btn st-btn-cream"
          disabled={!valid}
          onClick={() => {
            setReminder(form);
            onDone();
          }}
        >
          Set my reminder
        </button>
      </div>
    </div>
  );
}
