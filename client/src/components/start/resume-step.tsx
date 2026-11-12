import { useEffect, useMemo, useRef, useState } from "react";
import { postResumeExtract } from "./api";
import { canonicalSkills, outgoingText, parseResume, signalsOf, type ParseHints, type ParsedResume, type ResumeLine } from "./resume-engine";
import { focusFirstHeading } from "./nav";
import { READER_MESSAGES, readResumeFile, readersAvailable, suggestsBuilder, type ReaderErrorCode } from "./readers";
import {
  EXPERIENCE_KIND_OPTIONS,
  applyReviewEdits,
  builderIsEmpty,
  builderToText,
  dedupe,
  editsFromReview,
  gradYearOf,
  mergeSignals,
  normalizeSignals,
  removalSummary,
  removedForReview,
  reviewFromParsed,
  signalChips,
  splitPlaceholders,
  splitTerms,
  yearInSchool,
  type BuilderAnswers,
  type ExperienceKindLabel,
  type ReviewEdits,
  type SignalsView,
} from "./resume-view";
import type { ResumeSource } from "./storage";
import { Chip, focusAfterChipRemoval, Glass, Kicker, Note, Toggle } from "./ui";
import { yearLabel } from "./wording";

/**
 * Screen 3: the resume, read and parsed on this device. The file, its text and the parsed
 * fields live only in this component's memory. The only thing that can leave the device is
 * the redacted text shown on the preview, and only after the student turns on AI reading and
 * presses "Send this text".
 */

type Phase = "choose" | "builder" | "review" | "preview";

export interface ResumeOutcome {
  source: ResumeSource;
  signals: SignalsView | null;
}

const MAX_PASTE = 20_000;

export function ResumeStep({
  now,
  aiEnabled,
  onDone,
  onBack,
  questionsLeft,
}: {
  now: Date;
  aiEnabled: boolean | null;
  onDone: (r: ResumeOutcome) => void;
  /** Back to the previous quiz question. */
  onBack: () => void;
  /** Questions still to come after the resume, for the final button's label. */
  questionsLeft: number;
}) {
  const [phase, setPhase] = useState<Phase>("choose");
  const [source, setSource] = useState<ResumeSource>("paste");
  const [parsed, setParsed] = useState<ParsedResume | null>(null);
  const [edits, setEdits] = useState<ReviewEdits | null>(null);
  const [error, setError] = useState<{ text: string; code?: ReaderErrorCode } | null>(null);
  // null while probing; false until pdfjs-dist / mammoth are installed and wired.
  const [filesOk, setFilesOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState("");
  const [over, setOver] = useState(false);
  const [builder, setBuilder] = useState<BuilderAnswers>({ project: "", activity: "", skills: "" });
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void readersAvailable().then((a) => live && setFilesOk(a.pdf || a.docx));
    return () => {
      live = false;
    };
  }, []);

  // Each phase swap unmounts the focused button; move focus to the new heading so screen
  // readers announce it. The first render is handled by the page.
  const firstPhase = useRef(true);
  useEffect(() => {
    if (firstPhase.current) {
      firstPhase.current = false;
      return;
    }
    if (typeof document !== "undefined") focusFirstHeading(document.getElementById("main"));
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }, [phase]);

  const startReview = (text: string, lines: ResumeLine[] | undefined, src: ResumeSource, hints?: ParseHints) => {
    try {
      const p = parseResume(text, lines, now, hints);
      setParsed(p);
      setEdits(editsFromReview(reviewFromParsed(p)));
      setSource(src);
      setError(null);
      setPhase("review");
    } catch {
      setError({ text: "We couldn't read that text. Try pasting it again, or use the three quick questions." });
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    const r = await readResumeFile(file);
    setBusy(false);
    if (fileRef.current) fileRef.current.value = "";
    if (!r.ok) {
      setError({ text: READER_MESSAGES[r.code], code: r.code });
      return;
    }
    startReview(r.text, r.lines as ResumeLine[], r.source, r.hints);
  };

  if (phase === "review" && parsed && edits) {
    return (
      <ReviewPanel
        parsed={parsed}
        edits={edits}
        setEdits={setEdits}
        now={now}
        onBack={() => setPhase("choose")}
        onNext={() => setPhase("preview")}
      />
    );
  }

  if (phase === "preview" && parsed && edits) {
    return (
      <PreviewPanel
        edited={applyReviewEdits(parsed, edits)}
        aiEnabled={aiEnabled}
        onBack={() => setPhase("review")}
        onDone={(signals) => onDone({ source, signals })}
        doneLabel={questionsLeft > 0 ? `Next: ${questionsLeft === 1 ? "one more question" : `${questionsLeft} more questions`}` : "Continue"}
      />
    );
  }

  if (phase === "builder") {
    return (
      <Glass className="st-enter" aria-labelledby="st-builder-title">
        <Kicker>No resume? No problem</Kicker>
        <h2 id="st-builder-title" className="st-h2">
          Three quick questions instead
        </h2>
        <p className="st-lede st-small">A sentence each is plenty. This becomes the start of your first resume, too.</p>
        <div className="st-stack" style={{ marginTop: 18 }}>
          <div className="st-field">
            <label className="st-label" htmlFor="st-b-project">
              One project you're proud of (class or personal)
            </label>
            <input id="st-b-project" className="st-input" maxLength={240} placeholder="Built a budget tracker in Python for my dorm" value={builder.project} onChange={(e) => setBuilder({ ...builder, project: e.target.value })} />
          </div>
          <div className="st-field">
            <label className="st-label" htmlFor="st-b-activity">
              One activity, club, team or job
            </label>
            <input id="st-b-activity" className="st-input" maxLength={240} placeholder="Tutor at the campus writing center" value={builder.activity} onChange={(e) => setBuilder({ ...builder, activity: e.target.value })} />
          </div>
          <div className="st-field">
            <label className="st-label" htmlFor="st-b-skills">
              Your top skills, separated by commas
            </label>
            <input id="st-b-skills" className="st-input" maxLength={240} placeholder="Python, Excel, public speaking" value={builder.skills} onChange={(e) => setBuilder({ ...builder, skills: e.target.value })} />
          </div>
        </div>
        <div className="st-actions">
          <button type="button" className="st-btn st-btn-go" disabled={builderIsEmpty(builder)} onClick={() => startReview(builderToText(builder), undefined, "builder")}>
            Continue
          </button>
          <button type="button" className="st-btn st-btn-ghost" onClick={() => setPhase("choose")}>
            Back
          </button>
        </div>
      </Glass>
    );
  }

  const pasteField = (
    <div className="st-field" style={{ marginTop: 18 }}>
      <label className="st-label" htmlFor="st-paste">
        {filesOk === false ? "Paste your resume text" : "Or paste your resume text"}
      </label>
      <textarea id="st-paste" className="st-textarea" value={paste} maxLength={MAX_PASTE} placeholder="Paste everything from your resume. Headings like Education, Experience and Skills help." onChange={(e) => setPaste(e.target.value)} />
    </div>
  );

  // Until the readers are installed, the drop zone says so up front instead of inviting a file
  // it would only refuse after the student picked one.
  const dropZone =
    filesOk === false ? (
      <div className="st-drop" data-off="true" style={{ marginTop: 18 }}>
        <p className="st-h3">File upload isn't switched on yet</p>
        <p className="st-meta">Paste the text above for now. It is read the same way, on this device.</p>
      </div>
    ) : (
      <div
        className="st-drop"
        data-over={over}
        style={{ marginTop: 18 }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!busy) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (busy) return;
          void onFile(e.dataTransfer.files?.[0]);
        }}
      >
        <p className="st-h3">{busy ? "Reading on your device…" : "Drop a PDF or Word file here"}</p>
        <p className="st-meta">PDF or .docx, up to 5 MB</p>
        <label className="st-btn st-btn-cream" style={{ marginTop: 6 }} aria-disabled={busy || filesOk === null}>
          Choose a file
          <input
            ref={fileRef}
            type="file"
            className="st-sr"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => void onFile(e.target.files?.[0])}
            disabled={busy}
          />
        </label>
      </div>
    );

  return (
    <Glass className="st-enter" aria-labelledby="st-resume-title">
      <Kicker>Your resume · read on this device</Kicker>
      <h2 id="st-resume-title" className="st-h2">
        Add your resume to skip some questions
      </h2>
      <p className="st-lede st-small">
        Novus reads it right here in your browser to suggest answers and sharpen your matches. The file is never uploaded, and you'll see exactly what, if
        anything, would be shared before it is.
      </p>

      {filesOk === false && pasteField}
      {dropZone}

      {error && (
        <div style={{ marginTop: 12 }} role="alert">
          <Note tone="warn">{error.text}</Note>
          {error.code && suggestsBuilder(error.code) && (
            <div className="st-actions" style={{ marginTop: 10 }}>
              <button type="button" className="st-btn st-btn-cream" onClick={() => setPhase("builder")}>
                Answer three quick questions
              </button>
            </div>
          )}
        </div>
      )}

      <details className="st-details" style={{ marginTop: 16 }}>
        <summary>How do I export my resume as a PDF?</summary>
        <ul className="st-rows st-small" style={{ marginTop: 10 }}>
          <li>Google Docs: File, then Download, then PDF Document.</li>
          <li>Microsoft Word: File, then Save As (or Export), then PDF.</li>
          <li>Pages: File, then Export To, then PDF.</li>
          <li>Canva: Share, then Download, then PDF Standard.</li>
          <li>
            Only have a photo or scan? It has no text to read. Export the original document as a PDF again, or{" "}
            <button type="button" className="st-link" onClick={() => setPhase("builder")}>
              answer three quick questions
            </button>{" "}
            instead.
          </li>
        </ul>
      </details>

      {filesOk !== false && pasteField}

      <div className="st-actions">
        <button type="button" className="st-btn st-btn-go" disabled={!paste.trim() || busy} onClick={() => startReview(paste, undefined, "paste")}>
          Read my resume
        </button>
        <button type="button" className="st-btn" onClick={() => setPhase("builder")}>
          I don't have one
        </button>
        <button type="button" className="st-btn st-btn-ghost" onClick={() => onDone({ source: "none", signals: null })}>
          Skip for now
        </button>
        <button type="button" className="st-btn st-btn-ghost" onClick={onBack}>
          Back
        </button>
      </div>
    </Glass>
  );
}

/* ---------- review: the student corrects what the parser found ---------- */

function ReviewPanel({
  parsed,
  edits,
  setEdits,
  now,
  onBack,
  onNext,
}: {
  parsed: ParsedResume;
  edits: ReviewEdits;
  setEdits: (e: ReviewEdits) => void;
  now: Date;
  onBack: () => void;
  onNext: () => void;
}) {
  const view = useMemo(() => reviewFromParsed(parsed), [parsed]);
  const [newSkill, setNewSkill] = useState("");
  const [newCourse, setNewCourse] = useState("");
  const [removed, setRemoved] = useState("");
  const gradYear = gradYearOf(edits.gradDate);

  const addSkills = () => {
    const add = splitTerms(newSkill);
    if (!add.length) return;
    let canon = add;
    try {
      canon = canonicalSkills(add);
    } catch {
      canon = add;
    }
    setEdits({ ...edits, skills: dedupe([...edits.skills, ...canon]) });
    setNewSkill("");
  };

  return (
    <Glass className="st-enter" aria-labelledby="st-review-title">
      <Kicker>Check what we found</Kicker>
      <h2 id="st-review-title" className="st-h2">
        Here's what Novus read. Fix anything that's off.
      </h2>

      {view.contactFound.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Note>
            <strong>Stays on this device:</strong> {view.contactFound.join(", ")}. Contact details and names are never sent anywhere.
          </Note>
        </div>
      )}
      {view.warnings.length > 0 && (
        <p className="st-meta" style={{ marginTop: 10 }}>
          Heads up: some parts were hard to read, so check the fields below.
        </p>
      )}

      <p className="st-sr" role="status" aria-live="polite">
        {removed}
      </p>

      <div className="st-stack" style={{ marginTop: 18 }}>
        <div className="st-panel-sub">
          <h3 className="st-h3">Education</h3>
          <div className="st-grid2" style={{ marginTop: 10 }}>
            <div className="st-field">
              <label className="st-label" htmlFor="st-major">
                Major or intended major
              </label>
              <input id="st-major" className="st-input" maxLength={80} value={edits.major ?? ""} placeholder="Undeclared is fine" onChange={(e) => setEdits({ ...edits, major: e.target.value || null })} />
            </div>
            <div className="st-field">
              <label className="st-label" htmlFor="st-grad">
                Expected graduation
              </label>
              <input id="st-grad" className="st-input" maxLength={20} value={edits.gradDate ?? ""} placeholder="2030-05" onChange={(e) => setEdits({ ...edits, gradDate: e.target.value || null })} />
            </div>
          </div>
          {gradYear && (
            <p className="st-meta" style={{ marginTop: 8 }}>
              That makes you {yearLabel(yearInSchool(gradYear, now))} student this year (inferred from your graduation date).
            </p>
          )}
        </div>

        {view.experience.length > 0 && (
          <div className="st-panel-sub">
            <h3 className="st-h3">Experience</h3>
            <ul className="st-rows" style={{ marginTop: 10 }}>
              {view.experience
                .filter((x) => !edits.removedExperience.includes(x.index))
                .map((x) => (
                  <li key={x.index} style={{ display: "grid", gap: 6 }}>
                    <span>
                      <strong>{x.title ?? "Role"}</strong>
                      {x.organization ? ` · ${x.organization}` : ""}
                      {x.dates ? <span className="st-meta"> · {x.dates}</span> : null}
                    </span>
                    <span className="st-row">
                      <label className="st-sr" htmlFor={`st-kind-${x.index}`}>
                        Kind of experience
                      </label>
                      <select
                        id={`st-kind-${x.index}`}
                        className="st-select"
                        style={{ width: "auto" }}
                        value={edits.kinds[x.index] ?? x.kind}
                        onChange={(e) => setEdits({ ...edits, kinds: { ...edits.kinds, [x.index]: e.target.value as ExperienceKindLabel } })}
                      >
                        {EXPERIENCE_KIND_OPTIONS.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                      <button type="button" className="st-link" onClick={() => setEdits({ ...edits, removedExperience: [...edits.removedExperience, x.index] })}>
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        )}

        <div className="st-panel-sub">
          <h3 className="st-h3">Skills</h3>
          <p className="st-meta" style={{ margin: "4px 0 10px" }}>
            Matching uses these. Remove any that aren't really yours.
          </p>
          <div className="st-chips">
            {edits.skills.map((s) => (
              <Chip
                key={s}
                label={`Remove ${s}`}
                onClick={(e) => {
                  focusAfterChipRemoval(e.currentTarget, "st-add-skill");
                  setEdits({ ...edits, skills: edits.skills.filter((x) => x !== s) });
                  setRemoved(`Removed ${s}.`);
                }}
              >
                {s} <span className="st-x">×</span>
              </Chip>
            ))}
            {!edits.skills.length && <span className="st-muted st-small">No skills found yet. Add a few below.</span>}
          </div>
          <div className="st-row" style={{ marginTop: 10 }}>
            <label className="st-sr" htmlFor="st-add-skill">
              Add skills
            </label>
            <input
              id="st-add-skill"
              className="st-input"
              style={{ flex: 1, minWidth: 0 }}
              placeholder="Add skills, separated by commas"
              value={newSkill}
              maxLength={200}
              onChange={(e) => setNewSkill(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addSkills();
                }
              }}
            />
            <button type="button" className="st-btn" onClick={addSkills}>
              Add
            </button>
          </div>
        </div>

        <div className="st-panel-sub">
          <h3 className="st-h3">Coursework</h3>
          <div className="st-chips" style={{ marginTop: 10 }}>
            {edits.coursework.map((s) => (
              <Chip
                key={s}
                label={`Remove ${s}`}
                onClick={(e) => {
                  focusAfterChipRemoval(e.currentTarget, "st-add-course");
                  setEdits({ ...edits, coursework: edits.coursework.filter((x) => x !== s) });
                  setRemoved(`Removed ${s}.`);
                }}
              >
                {s} <span className="st-x">×</span>
              </Chip>
            ))}
          </div>
          <div className="st-row" style={{ marginTop: 10 }}>
            <label className="st-sr" htmlFor="st-add-course">
              Add courses
            </label>
            <input
              id="st-add-course"
              className="st-input"
              style={{ flex: 1, minWidth: 0 }}
              placeholder="Add courses, separated by commas"
              value={newCourse}
              maxLength={200}
              onChange={(e) => setNewCourse(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setEdits({ ...edits, coursework: dedupe([...edits.coursework, ...splitTerms(newCourse)]) });
                  setNewCourse("");
                }
              }}
            />
          </div>
        </div>
      </div>

      <div className="st-actions">
        <button type="button" className="st-btn st-btn-go" onClick={onNext}>
          Looks right
        </button>
        <button type="button" className="st-btn st-btn-ghost" onClick={onBack}>
          Use a different resume
        </button>
      </div>
    </Glass>
  );
}

/* ---------- preview: exactly what AI would read, consent off by default ---------- */

type SendState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "message"; text: string; tone?: "warn" }
  | { kind: "suggestions"; extra: SignalsView };

function PreviewPanel({
  edited,
  aiEnabled,
  onBack,
  onDone,
  doneLabel,
}: {
  edited: ParsedResume;
  aiEnabled: boolean | null;
  onBack: () => void;
  onDone: (s: SignalsView) => void;
  /** The resume is question 3 of about 12, so the button says what really comes next. */
  doneLabel: string;
}) {
  const signals = useMemo(() => safeSignals(edited), [edited]);
  const outgoing = useMemo(() => safeOutgoing(edited), [edited]);
  const [consent, setConsent] = useState(false);
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  const [accepted, setAccepted] = useState<string[]>([]);
  const summary = removalSummary(outgoing?.removed ?? []);
  const removedList = removedForReview(outgoing?.removed ?? []);

  const doSend = async () => {
    if (!consent || !outgoing?.text.trim()) return;
    setSend({ kind: "sending" });
    const r = await postResumeExtract(outgoing.text, true);
    if (r.ok) {
      const d = r.data;
      if (d.ai === "on") {
        const extra = normalizeSignals(d.profile);
        const fresh = { ...extra, skills: extra.skills.filter((s) => !signals.skills.some((x) => x.toLowerCase() === s.toLowerCase())) };
        setSend(fresh.skills.length ? { kind: "suggestions", extra: fresh } : { kind: "message", text: "AI read it and found nothing new. Your on-device results stand." });
      } else {
        setSend({ kind: "message", text: "AI reading is switched off right now. Your on-device results already power your matches." });
      }
      return;
    }
    const text =
      r.reason === "signed_out"
        ? "AI reading needs an account, so nothing was sent. Your on-device results already power your matches."
        : r.reason === "unredacted"
          ? "Novus's server spotted a detail it won't accept and stored nothing. Remove it in the previous step, or continue without AI."
          : r.reason === "offline"
            ? "Couldn't reach Novus, so nothing was sent. You can continue without AI."
            : "That didn't go through, and nothing was stored. You can continue without AI.";
    setSend({ kind: "message", text, tone: "warn" });
  };

  const finalSignals = send.kind === "suggestions" ? mergeSignals(signals, { skills: accepted }) : signals;
  const aiOff = aiEnabled === false;

  return (
    <Glass className="st-enter" aria-labelledby="st-preview-title">
      <Kicker>Before anything leaves your device</Kicker>
      <h2 id="st-preview-title" className="st-h2">
        Your matches use these signals
      </h2>
      <p className="st-lede st-small">Worked out on this device. No names, contact details or personal background.</p>
      <div className="st-chips" style={{ marginTop: 12 }}>
        {signalChips(signals).map((s) => (
          <span key={s} className="st-chip" aria-pressed="true">
            {s}
          </span>
        ))}
        {!signals.skills.length && !signals.fields.length && <span className="st-muted st-small">No skills yet; matching will lean on your quiz answers.</span>}
      </div>

      <div className="st-panel-sub" style={{ marginTop: 18 }}>
        <h3 className="st-h3">Optional: let AI suggest more skills</h3>
        <p className="st-small st-muted" style={{ margin: "6px 0 12px" }}>
          Off unless you turn it on. If you do, Novus sends only the text below to its AI provider, once, and doesn't store it.
        </p>
        <Toggle checked={consent} onChange={setConsent}>
          Let AI read this text
        </Toggle>
        {aiOff && <p className="st-meta" style={{ marginTop: 8 }}>AI reading is switched off on this server, so this would not be sent.</p>}

        <p className="st-label" style={{ marginTop: 16 }} id="st-outgoing-label">
          This is exactly what AI would read:
        </p>
        {outgoing ? (
          <pre className="st-pre" aria-labelledby="st-outgoing-label" tabIndex={0}>
            {splitPlaceholders(outgoing.text).map((seg, i) => (seg.placeholder ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>))}
          </pre>
        ) : (
          <Note tone="warn">The redaction step isn't available, so nothing can be sent. Your matches still work.</Note>
        )}
        <p className="st-meta" style={{ marginTop: 8 }}>
          Taken out first: {summary.contact} contact or name detail{summary.contact === 1 ? "" : "s"}
          {summary.sensitive ? `, and ${summary.sensitive} line${summary.sensitive === 1 ? "" : "s"} about personal background` : ""}. Schools, awards and links are never included.
        </p>
        {removedList.length > 0 && (
          <details className="st-details" style={{ marginTop: 8 }}>
            <summary>What was taken out (only you can see this)</summary>
            <ul className="st-rows st-small" style={{ marginTop: 8 }}>
              {removedList.map((r, i) => (
                <li key={i}>
                  <span className="st-meta">{r.placeholder || "left out"}</span>
                  <span>
                    {r.original}
                    {r.reason && <span className="st-meta"> · {r.reason}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div className="st-actions" style={{ marginTop: 14 }}>
          <button type="button" className="st-btn" disabled={!consent || aiOff || !outgoing?.text.trim() || send.kind === "sending"} onClick={() => void doSend()}>
            {send.kind === "sending" ? "Sending…" : "Send this text"}
          </button>
        </div>
        <div aria-live="polite">
          {send.kind === "message" && (
            <div style={{ marginTop: 12 }}>
              <Note tone={send.tone}>{send.text}</Note>
            </div>
          )}
          {send.kind === "suggestions" && (
            <div style={{ marginTop: 12 }}>
              <p className="st-small">AI suggests these. Tap the ones that are really yours:</p>
              <div className="st-chips" style={{ marginTop: 8 }}>
                {send.extra.skills.map((s) => (
                  <Chip key={s} pressed={accepted.includes(s)} onClick={() => setAccepted(accepted.includes(s) ? accepted.filter((x) => x !== s) : [...accepted, s])}>
                    {s}
                  </Chip>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="st-actions">
        <button type="button" className="st-btn st-btn-go" onClick={() => onDone(finalSignals)}>
          {doneLabel}
        </button>
        <button type="button" className="st-btn st-btn-ghost" onClick={onBack}>
          Back
        </button>
      </div>
    </Glass>
  );
}

function safeSignals(p: ParsedResume): SignalsView {
  try {
    return signalsOf(p);
  } catch {
    return normalizeSignals({});
  }
}

/** If redaction throws, nothing can be sent: fail closed rather than show unredacted text. */
function safeOutgoing(p: ParsedResume): { text: string; removed: readonly unknown[] } | null {
  try {
    return outgoingText(p);
  } catch {
    return null;
  }
}
