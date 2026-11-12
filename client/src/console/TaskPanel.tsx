import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Clock, ExternalLink, FileText, RefreshCw, ShieldAlert } from "lucide-react";
import { ConsoleError, REJECT_REASONS, type ConsoleApi, type DeadlineOp, type Edits, type EvidenceEdit, type EvidenceView, type RejectReason, type SnapshotView } from "./api";
import {
  actionForKey,
  ActiveTimer,
  APPROVE_CONFIRM_MS,
  approveKeyStep,
  claimStatus,
  buildDeadlineOp,
  formatCents,
  formChanged,
  formFromDeadline,
  HIGH_IMPACT_LABELS,
  humanize,
  REJECT_LABELS,
  segments,
  selectionQuote,
  type DeadlineForm,
  type KeyAction,
} from "./model";
import { Btn, Chip, DueChip, SampleChip, StateChip } from "./ui";

/**
 * One task, side by side: verified values and proposals on the left, the official Snapshot text
 * with highlighted quotes and the window diff on the right. Keys: C claim (again to extend),
 * O open official, A A approve (twice within 3 s: it publishes and alerts students), E edit,
 * R reject, S snooze, X escalate, L release. After a decision the panel moves to the next task.
 */

type Mode = "view" | "edit" | "reject" | "snooze" | "escalate";

export interface TaskPanelProps {
  api: ConsoleApi;
  taskId: string;
  handle: string;
  now: number;
  onChanged: (message: string) => void;
  onAuthError: (err: ConsoleError) => boolean;
  /** Returns false when there is no other task to move to. */
  onNavigate: (dir: "next" | "previous") => boolean;
}

function useActiveTimer(key: string) {
  const timer = useRef(new ActiveTimer(Date.now()));
  useEffect(() => {
    timer.current = new ActiveTimer(Date.now());
    const input = () => timer.current.input(Date.now());
    const events = ["keydown", "pointerdown", "scroll", "pointermove"] as const;
    for (const e of events) window.addEventListener(e, input, { passive: true });
    const id = window.setInterval(() => timer.current.tick(Date.now(), document.visibilityState === "visible", document.hasFocus()), 1000);
    return () => {
      for (const e of events) window.removeEventListener(e, input);
      window.clearInterval(id);
    };
  }, [key]);
  return () => timer.current.seconds();
}

export function TaskPanel({ api, taskId, handle, now, onChanged, onAuthError, onNavigate }: TaskPanelProps) {
  const [view, setView] = useState<EvidenceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [busy, setBusy] = useState(false);
  const [snapIndex, setSnapIndex] = useState(0);
  const activeSeconds = useActiveTimer(taskId);

  // Form state for edit / reject / snooze / escalate.
  const [note, setNote] = useState("");
  const [rejectReason, setRejectReason] = useState<RejectReason>("no_material_change");
  const [snoozeUntil, setSnoozeUntil] = useState("");
  const [forms, setForms] = useState<DeadlineForm[]>([]);
  const [cycleStatus, setCycleStatus] = useState("");
  const [statusQuote, setStatusQuote] = useState("");
  const [activeQuote, setActiveQuote] = useState<number | "status">(0);
  // The A key arms first; a second A before this time publishes.
  const [armedUntil, setArmedUntil] = useState<number | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const valuesRef = useRef<HTMLDivElement>(null);

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ConsoleError) {
        if (onAuthError(err)) return;
        setError(err.fieldErrors.length ? `${err.detail} (${err.fieldErrors.map((f) => f.path).join(", ")})` : err.detail);
      } else setError("Something went wrong. Reload the task.");
    },
    [onAuthError],
  );

  const load = useCallback(async () => {
    setError(null);
    try {
      const v = await api.evidence(taskId);
      setView(v);
      setForms(v.verified.deadlines.map(formFromDeadline));
      setCycleStatus(v.cycle?.status ?? "");
      setStatusQuote("");
      setMode("view");
      setSnapIndex(0);
    } catch (err) {
      fail(err);
    }
  }, [api, taskId, fail]);

  useEffect(() => {
    void load();
  }, [load]);

  const task = view?.task;
  // A one-second clock while the viewer holds the task, for the claim countdown. `mine` is false
  // once the lease runs out, which disables every action until the task is claimed again.
  const heldByMe = task?.state === "claimed" && task.claimedBy === handle;
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!heldByMe) return;
    setClock(Date.now());
    const id = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [heldByMe]);
  const claim = task ? claimStatus(task, handle, Math.max(clock, now)) : ({ kind: "none" } as const);
  const mine = claim.kind === "held";
  const claimWarn = claim.kind === "held" && claim.warn;
  const claimNotice =
    claim.kind === "expired"
      ? "Your claim ended, so nothing can be approved or changed. Press C (Claim) to take the task again; your edits stay on screen."
      : claimWarn
        ? "Your claim ends in under 2 minutes. Press C or Extend claim to keep working."
        : "";

  useEffect(() => {
    if (armedUntil === null) return;
    const id = window.setTimeout(() => setArmedUntil(null), Math.max(0, armedUntil - Date.now()));
    return () => window.clearTimeout(id);
  }, [armedUntil]);

  // A form that opens takes focus (its first field); closing one returns focus to the heading.
  const lastMode = useRef<Mode>("view");
  useEffect(() => {
    const was = lastMode.current;
    lastMode.current = mode;
    if (mode === "view") {
      if (was !== "view") headingRef.current?.focus();
      return;
    }
    const root = mode === "edit" ? valuesRef.current : formRef.current;
    root?.querySelector<HTMLElement>("select, input, textarea")?.focus();
  }, [mode]);
  const snapshot: SnapshotView | undefined = view?.snapshots[snapIndex];

  /** After a decision, go to the next task (or reload this one when it was the last). */
  async function moveOn() {
    if (!onNavigate("next")) await load();
  }

  async function act(fn: () => Promise<unknown>, message: string, after: "reload" | "next" = "reload") {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged(message);
      if (after === "next") await moveOn();
      else await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  /** Claims, or extends the viewer's own claim. Keeps any open form and its edits. */
  async function claimTask() {
    const extending = claim.kind === "held" || claim.kind === "expired";
    setBusy(true);
    setError(null);
    try {
      const updated = await api.claim(taskId);
      onChanged(claim.kind === "held" ? "Claim extended for 15 minutes" : "Claimed for 15 minutes");
      if (extending || mode !== "view") setView((v) => (v ? { ...v, task: updated } : v));
      else await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  function openOfficial() {
    if (!view) return;
    const target = snapshot?.officialLink ?? view.program?.officialUrl;
    if (!target) return;
    window.open(target, "_blank", "noopener,noreferrer");
    if (mine) void act(() => api.officialOpened(taskId, snapshot?.id ?? null, null), "Official page opened (logged)");
  }

  function takeSelection() {
    const quote = selectionQuote(window.getSelection()?.toString() ?? "");
    if (!quote) return setError("Select the quote in the Snapshot text first.");
    if (activeQuote === "status") setStatusQuote(quote);
    else setForms((fs) => fs.map((f, i) => (i === activeQuote ? { ...f, quote, snapshotId: snapshot?.id ?? null } : f)));
  }

  function buildEdits(): { ok: true; edits: Edits } | { ok: false; message: string } {
    if (!view) return { ok: false, message: "Not loaded." };
    const ops: DeadlineOp[] = [];
    const url = snapshot?.finalUrl ?? view.program?.officialUrl ?? "";
    for (const f of forms) {
      const original = view.verified.deadlines.find((d) => d.id === f.deadlineId);
      if (!formChanged(f, original)) continue;
      const built = buildDeadlineOp(f, url);
      if (!built.ok) return { ok: false, message: `${humanize(f.kind)}: ${built.message}` };
      ops.push(built.op);
    }
    const edits: Edits = { deadlines: ops };
    if (view.cycle && cycleStatus && cycleStatus !== view.cycle.status) {
      if (!statusQuote) return { ok: false, message: "Quote the official page for the status change." };
      const ev: EvidenceEdit = { snapshotId: snapshot?.id ?? null, url, quote: statusQuote, basis: snapshot ? "snapshot" : "manual_note" };
      edits.cycle = { status: cycleStatus };
      edits.cycleEvidence = { status: ev };
    }
    return { ok: true, edits };
  }

  async function approve(withEdits: boolean) {
    if (!view) return;
    let edits: Edits | undefined;
    if (withEdits) {
      const built = buildEdits();
      if (!built.ok) return setError(built.message);
      edits = built.edits;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.resolve(taskId, { decision: "approve", resolution: note, subjectVersion: view.cycle?.version ?? null, edits, activeSeconds: activeSeconds() });
      onChanged(res.outcome === "second_review" ? "Sent to second review" : "Published");
      await moveOn();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  // The latest handler, read by one window listener (so it never sees stale form state).
  const onKeyRef = useRef<(action: KeyAction) => void>(() => undefined);
  const onKey = (action: KeyAction) => onKeyRef.current(action);
  onKeyRef.current = (action: KeyAction) => {
      if (!view || busy) return;
      if (action !== "approve") setArmedUntil(null);
      switch (action) {
        case "claim":
          // Another Curator's live claim cannot be taken; the server would refuse it anyway.
          if (!(claim.kind === "other" && claim.live)) void claimTask();
          break;
        case "open_official":
          openOfficial();
          break;
        case "approve": {
          // One stray keystroke must not publish: the first A arms, a second A within 3 s approves.
          if (!mine) break;
          const at = Date.now();
          if (approveKeyStep(armedUntil, at) === "approve") {
            setArmedUntil(null);
            void approve(mode === "edit");
          } else setArmedUntil(at + APPROVE_CONFIRM_MS);
          break;
        }
        case "edit":
          if (mine) setMode("edit");
          break;
        case "reject":
          if (mine) setMode("reject");
          break;
        case "snooze":
          if (mine) setMode("snooze");
          break;
        case "escalate":
          if (mine) setMode("escalate");
          break;
        case "release":
          if (mine) void act(() => api.release(taskId), "Released");
          break;
        case "next":
        case "previous":
          onNavigate(action);
          break;
        default:
          break;
      }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const action = actionForKey({ key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, targetTag: target?.tagName ?? null, targetEditable: target?.isContentEditable ?? false });
      if (!action || action === "help") return;
      e.preventDefault();
      onKeyRef.current(action);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const segs = useMemo(() => (snapshot?.text ? segments(snapshot.text, snapshot.highlights) : []), [snapshot]);

  if (error && !view) return <div className="cn-card"><p className="cn-error" role="alert">{error}</p></div>;
  if (!view || !task) return <div className="cn-card cn-muted">Loading task…</div>;

  const evidenceById = new Map(view.verified.evidence.map((e) => [e.id, e]));

  return (
    <section className="cn-card" aria-labelledby="task-title">
      <h1 id="task-title" ref={headingRef} tabIndex={-1} style={{ margin: 0, fontSize: 20 }}>
        {view.program?.name ?? humanize(task.subject.type)} {view.cycle ? <span className="cn-muted">({view.cycle.termLabel})</span> : null}
      </h1>
      <div className="cn-item-meta">
        {view.program?.isSample ? <SampleChip /> : null}
        <Chip icon={FileText}>{humanize(task.kind)}</Chip>
        <StateChip state={task.state} />
        {claim.kind === "held" ? (
          <Chip icon={Clock} tone={claim.warn ? "soon" : undefined}>
            {claim.text}
          </Chip>
        ) : claim.kind === "expired" ? (
          <Chip icon={AlertTriangle} tone="late">
            Claim ended
          </Chip>
        ) : null}
        <DueChip dueAt={task.dueAt} now={now} />
        {task.reasonCodes.map((r) => (
          <Chip key={r} icon={ShieldAlert}>{humanize(r)}</Chip>
        ))}
        {task.claimedBy ? <span>Claimed by {task.claimedBy}</span> : null}
      </div>

      {task.reasonCodes.some((r) => r.startsWith("draft_unavailable:")) || view.proposals.length === 0 ? (
        <p className="cn-muted">No pipeline draft for this task (AI drafting is off or found nothing). Read the values from the official page; approval never depends on a draft.</p>
      ) : null}

      {view.firstApproval ? (
        <p className="cn-notice">
          First approval by {view.firstApproval.by ?? "another Curator"}: {view.firstApproval.reasons.map((r) => HIGH_IMPACT_LABELS[r] ?? humanize(r)).join("; ")}. A second Curator confirms by
          approving unchanged, or edits to restart the review.
        </p>
      ) : null}

      <div className="cn-actions" role="toolbar" aria-label="Task actions">
        <Btn kbd="C" onClick={() => onKey("claim")} disabled={busy || (claim.kind === "other" && claim.live)}>
          {mine ? "Extend claim" : "Claim"}
        </Btn>
        <Btn kbd="O" onClick={openOfficial} disabled={busy}>
          <ExternalLink size={14} aria-hidden="true" /> Official page
        </Btn>
        <Btn kbd="A" primary onClick={() => { setArmedUntil(null); void approve(mode === "edit"); }} disabled={busy || !mine}>
          {mode === "edit" ? "Approve edits" : "Approve unchanged"}
        </Btn>
        <Btn kbd="E" onClick={() => setMode("edit")} disabled={busy || !mine}>Edit</Btn>
        <Btn kbd="R" onClick={() => setMode("reject")} disabled={busy || !mine}>Reject</Btn>
        <Btn kbd="S" onClick={() => setMode("snooze")} disabled={busy || !mine}>Snooze</Btn>
        <Btn kbd="X" onClick={() => setMode("escalate")} disabled={busy || !mine}>Escalate</Btn>
        <Btn kbd="L" onClick={() => onKey("release")} disabled={busy || !mine}>Release</Btn>
        <Btn onClick={() => void act(() => api.recheck(taskId, task.reasonCodes.includes("urgent_recheck")), "Re-check requested")} disabled={busy || !mine}>
          <RefreshCw size={14} aria-hidden="true" /> Re-check
        </Btn>
      </div>
      {!view.officialOpenedByMe && mine ? <p className="cn-muted">Open the official page (O) before approving a changed deadline, status or link. The click is logged.</p> : null}
      {error ? <p className="cn-error" role="alert">{error}</p> : null}
      <p className={armedUntil !== null ? "cn-notice" : "cn-muted"} role="status" aria-live="polite">
        {armedUntil !== null
          ? `Press A again to ${mode === "edit" ? "publish these edits" : "publish"}. Approving writes the public registry and alerts students.`
          : ""}
      </p>
      <p className={claimNotice ? "cn-notice" : "cn-muted"} role="status" aria-live="polite">
        {claimNotice}
      </p>

      {mode === "reject" || mode === "snooze" || mode === "escalate" ? (
        <form
          ref={formRef}
          className="cn-form cn-card"
          onSubmit={(e) => {
            e.preventDefault();
            const base = { resolution: note, subjectVersion: null, activeSeconds: activeSeconds() };
            if (mode === "reject") void act(() => api.resolve(taskId, { decision: "reject", rejectReason, ...base }), "Rejected", "next");
            else if (mode === "snooze") void act(() => api.resolve(taskId, { decision: "snooze", snoozeUntil: new Date(snoozeUntil).toISOString(), ...base }), "Snoozed", "next");
            else void act(() => api.resolve(taskId, { decision: "escalate", ...base }), "Escalated", "next");
          }}
        >
          <h3>{mode === "reject" ? "Reject" : mode === "snooze" ? "Snooze" : "Escalate"}</h3>
          {mode === "reject" ? (
            <label className="cn-label">
              Reason (required)
              <select className="cn-input" value={rejectReason} onChange={(e) => setRejectReason(e.target.value as RejectReason)}>
                {REJECT_REASONS.map((r) => (
                  <option key={r} value={r}>{REJECT_LABELS[r]}</option>
                ))}
              </select>
            </label>
          ) : null}
          {mode === "snooze" ? (
            <label className="cn-label">
              Back in the queue on
              <input className="cn-input" type="datetime-local" value={snoozeUntil} onChange={(e) => setSnoozeUntil(e.target.value)} required />
            </label>
          ) : null}
          <label className="cn-label">
            {mode === "reject" ? "Note" : "Reason (required)"}
            <textarea className="cn-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </label>
          <div className="cn-actions">
            <Btn type="submit" primary disabled={busy}>Confirm</Btn>
            <Btn onClick={() => setMode("view")}>Cancel</Btn>
          </div>
        </form>
      ) : null}

      <div className="cn-split">
        <div ref={valuesRef} style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <div className="cn-card">
            <h3>Verified values</h3>
            {view.cycle ? (
              <dl className="cn-kv">
                <dt>Status</dt>
                <dd>
                  {mode === "edit" ? (
                    <select className="cn-input" value={cycleStatus} onChange={(e) => setCycleStatus(e.target.value)} onFocus={() => setActiveQuote("status")}>
                      {["expected", "open", "closed", "paused", "ended", "relaunched"].map((st) => (
                        <option key={st} value={st}>{humanize(st)}</option>
                      ))}
                    </select>
                  ) : (
                    humanize(view.cycle.status)
                  )}
                </dd>
                {mode === "edit" && cycleStatus !== view.cycle.status ? (
                  <>
                    <dt>Status quote</dt>
                    <dd>
                      <textarea className="cn-input" value={statusQuote} onFocus={() => setActiveQuote("status")} onChange={(e) => setStatusQuote(e.target.value)} placeholder="Verbatim from the official page" />
                    </dd>
                  </>
                ) : null}
                <dt>Opens</dt>
                <dd>{view.cycle.opensOn ?? "Not stated"}</dd>
                <dt>Application link</dt>
                <dd>{view.cycle.applicationUrl ?? "Not stated"}</dd>
                <dt>Fee</dt>
                <dd>{formatCents(view.cycle.applicationFeeCents)}</dd>
                <dt>Verified</dt>
                <dd>{view.cycle.lastVerifiedAt ? `${view.cycle.lastVerifiedAt.slice(0, 10)} by ${view.cycle.verifiedBy ?? "unknown"}` : "Never"}</dd>
              </dl>
            ) : (
              <p className="cn-muted">This task is not about a cycle; approving records the review only.</p>
            )}
          </div>

          <div className="cn-card">
            <h3>Deadlines</h3>
            {forms.length === 0 ? <p className="cn-muted">No live deadlines.</p> : null}
            {forms.map((f, i) => {
              const d = view.verified.deadlines.find((x) => x.id === f.deadlineId);
              const quote = view.verified.evidence.find((e) => e.entityId === f.deadlineId);
              return (
                <div key={f.deadlineId ?? i} style={{ marginBottom: 10 }}>
                  <strong>{humanize(f.kind)}</strong>{" "}
                  {d ? <span className="cn-muted">{[d.localDate, d.localTime, d.timeZone].filter(Boolean).join(" ")}</span> : <span className="cn-muted">New</span>}
                  {quote ? <blockquote className="cn-quote">{quote.quote}</blockquote> : null}
                  {mode === "edit" ? (
                    <div className="cn-form" onFocus={() => setActiveQuote(i)}>
                      <div className="cn-row">
                        <label className="cn-label">
                          Date
                          <input className="cn-input" value={f.localDate} onChange={(e) => setForms((fs) => fs.map((x, j) => (j === i ? { ...x, localDate: e.target.value } : x)))} placeholder="YYYY-MM-DD" />
                        </label>
                        <label className="cn-label">
                          Time
                          <input className="cn-input" value={f.localTime} onChange={(e) => setForms((fs) => fs.map((x, j) => (j === i ? { ...x, localTime: e.target.value } : x)))} placeholder="HH:MM" />
                        </label>
                        <label className="cn-label">
                          Time zone
                          <input className="cn-input" value={f.timeZone} onChange={(e) => setForms((fs) => fs.map((x, j) => (j === i ? { ...x, timeZone: e.target.value } : x)))} placeholder="America/Chicago" />
                        </label>
                      </div>
                      <label className="cn-label">
                        Quote (verbatim; select it in the Snapshot and press "Use selection")
                        <textarea className="cn-input" value={f.quote} onChange={(e) => setForms((fs) => fs.map((x, j) => (j === i ? { ...x, quote: e.target.value } : x)))} />
                      </label>
                      <label className="cn-label" style={{ display: "flex", gap: 6, alignItems: "center" }}>
                        <input type="checkbox" checked={f.withdraw} onChange={(e) => setForms((fs) => fs.map((x, j) => (j === i ? { ...x, withdraw: e.target.checked } : x)))} />
                        Withdraw this deadline (the official page no longer states it)
                      </label>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {mode === "edit" ? (
              <>
                <label className="cn-label">
                  Resolution note
                  <textarea className="cn-input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
                </label>
                <div className="cn-actions">
                  <Btn onClick={takeSelection}>Use selection as quote</Btn>
                  <Btn onClick={() => setMode("view")}>Cancel edits</Btn>
                </div>
              </>
            ) : null}
          </div>

          {view.verified.requirements.length ? (
            <div className="cn-card">
              <h3>Requirements</h3>
              <ul className="cn-list">
                {view.verified.requirements.map((r) => (
                  <li key={r.id}>{r.label}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {view.proposals.length ? (
            <div className="cn-card">
              <h3>Pipeline draft (plain text, not verified)</h3>
              <dl className="cn-kv">
                {view.proposals.map((p) => (
                  <div key={p.ref} style={{ display: "contents" }}>
                    <dt>{humanize(p.field)}</dt>
                    <dd>
                      {p.value || <span className="cn-muted">(no value)</span>}
                      {p.quote ? <blockquote className="cn-quote">{p.quote}</blockquote> : null}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {view.findings.length || view.riskSignals.length ? (
            <div className="cn-card">
              <h3>Validator findings</h3>
              <ul className="cn-list">
                {view.findings.map((f, i) => (
                  <li key={`${f.path}-${i}`}>
                    <Chip icon={f.blocked ? ShieldAlert : FileText} tone={f.blocked ? "late" : undefined}>{f.blocked ? "Blocked" : "Checked"}</Chip> {f.path}: {humanize(f.code)}
                  </li>
                ))}
                {view.riskSignals.map((r) => (
                  <li key={r}>
                    <Chip icon={ShieldAlert} tone="late">Risk</Chip> {humanize(r)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="cn-card">
            <h3>History</h3>
            {view.history.length === 0 ? <p className="cn-muted">No audit entries yet.</p> : null}
            <ul className="cn-list">
              {view.history.slice(0, 15).map((h) => (
                <li key={h.id} className="cn-muted">
                  {h.at.slice(0, 16).replace("T", " ")} {h.actor.ref}: {humanize(h.field ?? "")}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="cn-card" style={{ alignSelf: "start" }}>
          <h3>Official page as stored</h3>
          <div className="cn-tabs" role="group" aria-label="Snapshots">
            {view.snapshots.map((sv, i) => (
              <button key={sv.id} type="button" className="cn-tab" aria-pressed={i === snapIndex} onClick={() => setSnapIndex(i)}>
                {humanize(sv.role)} · {sv.fetchedAt.slice(0, 10)}
              </button>
            ))}
          </div>
          {view.diffs.length ? (
            <>
              <p className="cn-muted">Changes since the verified baseline (changes first):</p>
              {view.diffs.map((d) => (
                <ul key={d.sourceId} className="cn-diff">
                  {d.hunks.map((hunk, i) => (
                    <li key={i} data-op={hunk.op}>{hunk.line}</li>
                  ))}
                </ul>
              ))}
            </>
          ) : null}
          {snapshot ? (
            <>
              <p className="cn-muted">
                {snapshot.finalUrl} · HTTP {snapshot.httpStatus}
                {snapshot.isPdf ? " · PDF: open the official file at its page before approving" : ""}
                {snapshot.missingQuotes.length ? ` · ${snapshot.missingQuotes.length} verified quote(s) not found on this version` : ""}
              </p>
              {snapshot.text === null ? (
                <p className="cn-muted">No stored text ({humanize(snapshot.textUnavailable ?? "missing")}). Use the official link.</p>
              ) : (
                <div className="cn-text" tabIndex={0} aria-label="Snapshot text with highlighted quotes">
                  {segs.map((sg) =>
                    sg.kinds.length ? (
                      <mark key={sg.start} data-kind={sg.kinds.length > 1 ? "both" : sg.kinds[0]} title={sg.refs.map((r) => (evidenceById.has(r) ? "Verified quote" : "Draft quote")).join(", ")}>
                        {sg.text}
                      </mark>
                    ) : (
                      <span key={sg.start}>{sg.text}</span>
                    ),
                  )}
                </div>
              )}
              {snapshot.textTruncated ? <p className="cn-muted">Text cut for display; the official page has the rest.</p> : null}
              <p className="cn-muted">
                <mark data-kind="verified" style={{ background: "var(--nv-done)", color: "var(--nv-ink-dark)" }}>Verified quote</mark>{" "}
                <mark data-kind="proposed" style={{ background: "var(--nv-wheat)", color: "var(--nv-ink-dark)" }}>Draft quote</mark>
              </p>
            </>
          ) : (
            <p className="cn-muted">No Snapshot stored for this program yet. Use the official link.</p>
          )}
        </div>
      </div>
    </section>
  );
}
