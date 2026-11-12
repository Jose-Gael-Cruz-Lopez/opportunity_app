import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, HeartPulse, RotateCcw } from "lucide-react";
import { ConsoleError, type ConsoleApi, type OpsPipelineView } from "./api";
import { formatSeconds, humanize } from "./model";
import { Btn, Chip } from "./ui";

/**
 * The ops pipeline view: review SLAs, job queues by kind, failures with Retry, the last run of
 * each Worker job, heartbeats, and releases with rollback (admins only; the server checks).
 * Job payload values never reach this page, only the names of their keys.
 */

export function OpsPage({ api, isAdmin, onAuthError }: { api: ConsoleApi; isAdmin: boolean; onAuthError: (err: ConsoleError) => boolean }) {
  const [data, setData] = useState<OpsPipelineView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [confirmRelease, setConfirmRelease] = useState<number | null>(null);
  const [typed, setTyped] = useState("");

  const fail = useCallback(
    (err: unknown) => {
      if (err instanceof ConsoleError && onAuthError(err)) return;
      setError(err instanceof ConsoleError ? err.detail : "Could not load the pipeline view.");
    },
    [onAuthError],
  );

  const load = useCallback(async () => {
    try {
      setData(await api.ops());
      setError(null);
    } catch (err) {
      fail(err);
    }
  }, [api, fail]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  async function retry(id: string) {
    try {
      await api.retryJob(id);
      setFlash("Job queued again");
      await load();
    } catch (err) {
      fail(err);
    }
  }

  async function rollback(n: number) {
    try {
      await api.rollback(n);
      setFlash(`Release ${n} is live again. Founders are alerted.`);
      setConfirmRelease(null);
      setTyped("");
      await load();
    } catch (err) {
      fail(err);
    }
  }

  if (!data) return <div className="cn-card">{error ? <p className="cn-error" role="alert">{error}</p> : <span className="cn-muted">Loading…</span>}</div>;

  const r = data.review;
  return (
    <div style={{ display: "grid", gap: 12 }}>
      {error ? <p className="cn-error" role="alert">{error}</p> : null}
      {flash ? <p className="cn-ok" role="status">{flash}</p> : null}
      <div className="cn-tiles">
        <div className="cn-tile"><b>{r.open}</b><span>Open tasks</span></div>
        <div className="cn-tile"><b>{r.overdue}</b><span>Past their SLA</span></div>
        <div className="cn-tile"><b>{r.secondReview}</b><span>Waiting for second review</span></div>
        <div className="cn-tile"><b>{r.escalated}</b><span>Escalated</span></div>
        <div className="cn-tile"><b>{r.appliedLast24h}</b><span>Published in 24 h</span></div>
        <div className="cn-tile"><b>{formatSeconds(r.medianActiveSeconds)}</b><span>Median active time per task (24 h)</span></div>
      </div>

      <section className="cn-card">
        <h2>Heartbeats</h2>
        {data.heartbeats.length === 0 ? <p className="cn-muted">No heartbeats recorded yet.</p> : null}
        <div className="cn-actions">
          {data.heartbeats.map((h) => (
            <Chip key={h.name} icon={h.stale ? AlertTriangle : HeartPulse} tone={h.stale ? "late" : "good"}>
              {h.name}: {h.stale ? "stale" : "live"} ({h.lastSeenAt.slice(11, 16)} UTC)
            </Chip>
          ))}
        </div>
      </section>

      <section className="cn-card">
        <h2>Job queues</h2>
        <table className="cn-table">
          <thead>
            <tr><th>Kind</th><th>Pending</th><th>Leased</th><th>Dead</th><th>Oldest waiting</th></tr>
          </thead>
          <tbody>
            {data.queues.map((q) => (
              <tr key={q.kind}>
                <td>{q.kind}</td>
                <td>{q.pending}</td>
                <td>{q.leased}</td>
                <td>{q.dead ? <Chip icon={AlertTriangle} tone="late">{q.dead} dead</Chip> : 0}</td>
                <td>{q.oldestPendingRunAfter ? `${q.lateMinutes} min` : "None"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.queues.length === 0 ? <p className="cn-muted">The queue is empty.</p> : null}
      </section>

      <section className="cn-card">
        <h2>Failures</h2>
        {data.failures.length === 0 ? <p className="cn-muted">No failed jobs.</p> : null}
        <table className="cn-table">
          <thead>
            <tr><th>Kind</th><th>Status</th><th>Attempts</th><th>Error class</th><th>Payload keys</th><th /></tr>
          </thead>
          <tbody>
            {data.failures.map((f) => (
              <tr key={f.id}>
                <td>{f.kind}</td>
                <td><Chip icon={AlertTriangle} tone={f.status === "dead" ? "late" : "soon"}>{humanize(f.status)}</Chip></td>
                <td>{f.attempts} / {f.maxAttempts}</td>
                <td>{f.lastError ?? "n/a"}</td>
                <td>{f.payloadKeys.join(", ")}</td>
                <td>{f.retryable ? <Btn onClick={() => void retry(f.id)}>Retry</Btn> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="cn-card">
        <h2>Last Worker runs</h2>
        <table className="cn-table">
          <thead>
            <tr><th>Kind</th><th>Started</th><th>Outcome</th><th>Processed</th><th>Error class</th></tr>
          </thead>
          <tbody>
            {data.lastRuns.map((run) => (
              <tr key={run.kind}>
                <td>{run.kind}</td>
                <td>{run.startedAt.slice(0, 16).replace("T", " ")}</td>
                <td>
                  <Chip icon={run.outcome === "failed" ? AlertTriangle : CheckCircle2} tone={run.outcome === "failed" ? "late" : run.outcome === "ok" ? "good" : "soon"}>
                    {humanize(run.outcome ?? "running")}
                  </Chip>
                </td>
                <td>{run.processed}</td>
                <td>{run.errorClass ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="cn-card">
        <h2>Releases</h2>
        <p className="cn-muted">Live release: {data.currentRelease ?? "none yet"}. A rollback moves the pointer only; the next publish builds a new release from the registry.</p>
        <table className="cn-table">
          <thead>
            <tr><th>#</th><th>State</th><th>Built</th><th>Published</th><th>Data</th><th /></tr>
          </thead>
          <tbody>
            {data.releases.map((rel) => (
              <tr key={rel.number}>
                <td>{rel.number}</td>
                <td>{humanize(rel.state)}</td>
                <td>{rel.builtAt?.slice(0, 16).replace("T", " ") ?? ""}</td>
                <td>{rel.publishedAt?.slice(0, 16).replace("T", " ") ?? ""}</td>
                <td>{rel.containsSample ? "Includes sample records" : "Verified records"}</td>
                <td>
                  {isAdmin && rel.canRollBackTo ? (
                    <Btn onClick={() => setConfirmRelease(rel.number)}>
                      <RotateCcw size={14} aria-hidden="true" /> Roll back to this
                    </Btn>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {confirmRelease !== null ? (
        <div className="cn-sheet" role="dialog" aria-modal="false" aria-labelledby="rollback-title">
          <h2 id="rollback-title">Roll back to release {confirmRelease}?</h2>
          <p className="cn-muted">Students, pages and MCP will read release {confirmRelease} until the next publish. Type the number to confirm.</p>
          <input className="cn-input" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Release number" />
          <div className="cn-actions">
            <Btn primary disabled={typed !== String(confirmRelease)} onClick={() => void rollback(confirmRelease)}>Roll back</Btn>
            <Btn onClick={() => setConfirmRelease(null)}>Cancel</Btn>
          </div>
        </div>
      ) : null}
    </div>
  );
}
