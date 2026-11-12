import { useCallback, useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ConsoleError, QUEUE_VIEWS, type ConsoleApi, type QueueResponse, type QueueView } from "./api";
import { humanize, KEY_HELP, severityLabel } from "./model";
import { TaskPanel } from "./TaskPanel";
import { Chip, DueChip, SampleChip, StateChip } from "./ui";
import { Gauge } from "lucide-react";

/**
 * The queue on the left (due time, then severity; plan 4.10) and the selected task on the right.
 * Sessions start at the top of the queue and end with their time box (runbook 14.4), so the
 * list is not sortable by hand.
 */

const VIEW_LABELS: Record<QueueView, string> = {
  queue: "Queue",
  mine: "My claims",
  second_review: "Second review",
  escalated: "Escalated",
  snoozed: "Snoozed",
};

export function Workspace({
  api,
  taskId,
  now,
  onAuthError,
  onViewer,
}: {
  api: ConsoleApi;
  taskId: string | null;
  now: number;
  onAuthError: (err: ConsoleError) => boolean;
  onViewer: (viewer: QueueResponse["viewer"]) => void;
}) {
  const [, navigate] = useLocation();
  const [view, setView] = useState<QueueView>("queue");
  const [data, setData] = useState<QueueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.queue(view);
      setData(res);
      onViewer(res.viewer);
      setError(null);
    } catch (err) {
      if (err instanceof ConsoleError && onAuthError(err)) return;
      setError(err instanceof ConsoleError ? err.detail : "Could not load the queue.");
    }
  }, [api, view, onAuthError, onViewer]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(id);
  }, [load]);

  /** Moves along the queue; false when there is nowhere else to go (the panel then reloads). */
  const move = (dir: "next" | "previous"): boolean => {
    if (!data || data.items.length === 0) return false;
    const i = data.items.findIndex((t) => t.id === taskId);
    const j = dir === "next" ? Math.min(data.items.length - 1, i + 1) : Math.max(0, i - 1);
    const target = data.items[j]!.id;
    if (target === taskId) return false;
    navigate(`/tasks/${target}`);
    return true;
  };

  return (
    <div className="cn-work">
      <aside className="cn-card" aria-label="Review queue">
        <div className="cn-tabs" role="group" aria-label="Queue views">
          {QUEUE_VIEWS.map((v) => (
            <button key={v} type="button" className="cn-tab" aria-pressed={v === view} onClick={() => setView(v)}>
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
        {error ? <p className="cn-error" role="alert">{error}</p> : null}
        {flash ? <p className="cn-ok" role="status">{flash}</p> : null}
        {data && data.items.length === 0 ? <p className="cn-muted">Nothing here. The queue is clear.</p> : null}
        <ul className="cn-list">
          {data?.items.map((t) => {
            const ctx = data.context[t.id];
            return (
              <li key={t.id}>
                <button type="button" className="cn-item" aria-current={t.id === taskId} onClick={() => navigate(`/tasks/${t.id}`)}>
                  <span className="cn-item-title">{ctx?.programName ?? humanize(t.subject.type)}</span>
                  {ctx?.termLabel ? <span className="cn-muted"> {ctx.termLabel}</span> : null}
                  <span className="cn-item-meta">
                    {ctx?.isSample ? <SampleChip /> : null}
                    <StateChip state={t.state} />
                    <DueChip dueAt={t.dueAt} now={now} />
                    <Chip icon={Gauge}>{severityLabel(ctx?.severity ?? 0.4)}</Chip>
                    <span>{humanize(t.kind)}</span>
                    {ctx?.secondReviewOf ? <span>First approval: {ctx.secondReviewOf}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        <details style={{ marginTop: 12 }}>
          <summary className="cn-muted">Keyboard</summary>
          <dl className="cn-kv">
            {KEY_HELP.map((k) => (
              <div key={k.key} style={{ display: "contents" }}>
                <dt>{k.key}</dt>
                <dd>{k.action}</dd>
              </div>
            ))}
          </dl>
        </details>
      </aside>
      {taskId && data ? (
        <TaskPanel
          key={taskId}
          api={api}
          taskId={taskId}
          handle={data.viewer.handle}
          now={now}
          onAuthError={onAuthError}
          onNavigate={move}
          onChanged={(message) => {
            setFlash(message);
            void load();
          }}
        />
      ) : (
        <div className="cn-card cn-muted">Pick the top task to start. Claims last 15 minutes.</div>
      )}
    </div>
  );
}
