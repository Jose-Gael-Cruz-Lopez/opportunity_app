import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, EyeOff, FlaskConical, Info } from "lucide-react";
import { ConsoleError } from "../api";
import { Chip } from "../ui";
import { METRICS_DAYS, METRICS_WEEKS, metricsApi, type AdminMetricsView, type Cell, type FreshnessSlice, type MetricsApi, type MetricsDays, type MetricsWeeks } from "./api";
import {
  barPercent,
  countText,
  daysText,
  freshnessTone,
  FUNNEL_ACTOR_NOTE,
  HIDDEN_TEXT,
  ingestNotice,
  maxShown,
  rateText,
  RETENTION_NOT_MEASURED,
  retentionShade,
  STATUS_LABELS,
  STEP_LABELS,
  timeText,
  weekLabel,
} from "./model";
import "./metrics.css";

/**
 * The founders' metrics (plan 10.10): activation funnel, weekly retention, Tracker and reminder
 * engagement, registry freshness. Admin only (the server checks), solid surfaces, aggregates
 * only: a count of 1 to 4 people arrives hidden and is shown as "fewer than 5".
 */

function Count({ cell }: { cell: Cell }) {
  if (cell.n !== null) return <>{countText(cell)}</>;
  return (
    <span className="mx-hidden" title="Hidden: fewer than 5 people">
      <EyeOff aria-hidden="true" />
      {HIDDEN_TEXT}
    </span>
  );
}

function Segmented<T extends number>({ label, options, value, onChange, unit }: { label: string; options: readonly T[]; value: T; onChange: (v: T) => void; unit: string }) {
  return (
    <div className="mx-seg" role="group" aria-label={label}>
      <span className="mx-seg-label">{label}</span>
      {options.map((o) => (
        <button key={o} type="button" className="cn-tab" aria-pressed={o === value} onClick={() => onChange(o)}>
          {o} {unit}
        </button>
      ))}
    </div>
  );
}

function Funnel({ funnel }: { funnel: AdminMetricsView["funnel"] }) {
  const max = maxShown(funnel.steps.map((s) => s.actors));
  const rec = funnel.serverRecorded;
  return (
    <section className="cn-card" aria-labelledby="mx-funnel">
      <h2 id="mx-funnel">Activation funnel</h2>
      <p className="cn-muted">Devices that started onboarding in the window, and how many reached each step since. Resume reading is optional, so the step after it compares with the quiz. {FUNNEL_ACTOR_NOTE}</p>
      <table className="cn-table mx-funnel">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col" className="mx-bar-col"><span className="mx-sr">Bar</span></th>
            <th scope="col">Devices</th>
            <th scope="col">From previous</th>
            <th scope="col">From start</th>
          </tr>
        </thead>
        <tbody>
          {funnel.steps.map((s) => (
            <tr key={s.step}>
              <th scope="row">
                {STEP_LABELS[s.step]}
                {s.optional ? <small className="mx-optional"> optional</small> : null}
              </th>
              <td className="mx-bar-col" aria-hidden="true">
                <div className="mx-track" title={`${STEP_LABELS[s.step]}: ${countText(s.actors)}`}>
                  {s.actors.n === null ? <div className="mx-bar mx-bar-hidden" /> : <div className="mx-bar" style={{ width: `${barPercent(s.actors, max)}%` }} />}
                </div>
              </td>
              <td className="mx-num"><Count cell={s.actors} /></td>
              <td className="mx-num">{rateText(s.fromPrevious)}</td>
              <td className="mx-num">{rateText(s.fromStart)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>Server cross-check (signed-in students, records opened in the window)</h3>
      <dl className="cn-kv">
        <dt>Onboarding records</dt>
        <dd><Count cell={rec.records} /></dd>
        <dt>Quiz saved</dt>
        <dd><Count cell={rec.quizSaved} /></dd>
        <dt>First door chosen</dt>
        <dd><Count cell={rec.firstDoorChosen} /></dd>
        <dt>Onboarding completed</dt>
        <dd><Count cell={rec.completed} /></dd>
      </dl>
    </section>
  );
}

function Retention({ retention, weeks }: { retention: AdminMetricsView["retention"]; weeks: number }) {
  const offsets = Array.from({ length: weeks }, (_, i) => i);
  if (!retention.measured) {
    return (
      <section className="cn-card" aria-labelledby="mx-retention">
        <h2 id="mx-retention">Retention by week</h2>
        <p className="cn-muted">{RETENTION_NOT_MEASURED}</p>
      </section>
    );
  }
  return (
    <section className="cn-card" aria-labelledby="mx-retention">
      <h2 id="mx-retention">Retention by week</h2>
      <p className="cn-muted">
        Signed-in students grouped by the week of their first active event (a program view, Tracker add, apply click, readiness or onboarding step). Each cell is the share active in that later week. The current week is still running and is marked with an asterisk.
      </p>
      <div className="mx-scroll">
        <table className="cn-table mx-cohorts">
          <caption className="mx-sr">Weekly retention by first-active week</caption>
          <thead>
            <tr>
              <th scope="col">First week</th>
              <th scope="col">Students</th>
              {offsets.map((o) => (
                <th scope="col" key={o} className="mx-num">Wk {o}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {retention.cohorts.map((c) => (
              <tr key={c.weekStart}>
                <th scope="row">{weekLabel(c.weekStart)}</th>
                <td className="mx-num"><Count cell={c.size} /></td>
                {offsets.map((o) => {
                  const w = c.weeks.find((x) => x.offset === o);
                  if (!w) return <td key={o} />;
                  const shade = retentionShade(w.rate);
                  const text = w.actors.n === null ? "hidden" : `${rateText(w.rate)}${w.partial ? "*" : ""}`;
                  return (
                    <td
                      key={o}
                      className="mx-num mx-heat"
                      data-dark={shade?.darkText ? "" : undefined}
                      style={shade ? { background: `color-mix(in oklab, var(--nv-leaf) ${shade.mix}%, var(--nv-surface-strong))` } : undefined}
                      title={`${weekLabel(c.weekStart)} cohort, week ${o}: ${countText(w.actors)} students${w.partial ? " (week in progress)" : ""}`}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Engagement({ e }: { e: AdminMetricsView["engagement"] }) {
  return (
    <section className="cn-card" aria-labelledby="mx-engagement">
      <h2 id="mx-engagement">Tracker and reminders</h2>
      <div className="cn-tiles">
        <div className="cn-tile"><b><Count cell={e.studentsTracking} /></b><span>Students with a Tracker item</span></div>
        <div className="cn-tile"><b><Count cell={e.studentsWithUpcomingReminder} /></b><span>Students with a reminder coming up</span></div>
        <div className="cn-tile"><b>{rateText(e.remindedItems.rate)}</b><span>Items with a sent reminder that reached Applying or later</span></div>
        <div className="cn-tile"><b>{rateText(e.unremindedItems.rate)}</b><span>Same, for items without one</span></div>
      </div>
      <p className="cn-muted">Reminded items: <Count cell={e.remindedItems.items} />, of which <Count cell={e.remindedItems.progressed} /> moved on. Not reminded: <Count cell={e.unremindedItems.items} />, of which <Count cell={e.unremindedItems.progressed} /> moved on. A comparison, not a cause: students who get reminders have usually planned more.</p>
      <div className="mx-scroll">
        <table className="cn-table">
          <caption className="mx-sr">Tracker and reminder activity by week</caption>
          <thead>
            <tr>
              <th scope="col">Week of</th>
              <th scope="col" className="mx-num">Items added</th>
              <th scope="col" className="mx-num">Students adding</th>
              <th scope="col" className="mx-num">Reminders scheduled</th>
              <th scope="col" className="mx-num">Sent</th>
              <th scope="col" className="mx-num">Cancelled</th>
            </tr>
          </thead>
          <tbody>
            {e.weeks.map((w) => (
              <tr key={w.weekStart}>
                <th scope="row">{weekLabel(w.weekStart)}{w.partial ? " *" : ""}</th>
                <td className="mx-num"><Count cell={w.trackerItemsAdded} /></td>
                <td className="mx-num"><Count cell={w.studentsAdding} /></td>
                <td className="mx-num"><Count cell={w.remindersScheduled} /></td>
                <td className="mx-num"><Count cell={w.remindersSent} /></td>
                <td className="mx-num"><Count cell={w.remindersCancelled} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>Tracker items by status now</h3>
      <table className="cn-table mx-narrow">
        <tbody>
          {e.trackerStatus.cells.map((c) => (
            <tr key={c.key}>
              <th scope="row">{STATUS_LABELS[c.key] ?? c.key}</th>
              <td className="mx-num"><Count cell={c.count} /></td>
            </tr>
          ))}
          <tr>
            <th scope="row">All live items</th>
            <td className="mx-num"><Count cell={e.trackerStatus.total} /></td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function FreshnessBlock({ slice, title, sample, windowDays, target }: { slice: FreshnessSlice; title: string; sample: boolean; windowDays: number; target: number }) {
  const tone = freshnessTone(slice.medianDaysSinceVerification, target);
  return (
    <div className="mx-fresh">
      <h3>
        {title} {sample ? <Chip icon={FlaskConical} tone="sample" title="Sample records: not real programs">Sample</Chip> : null}
      </h3>
      <div className="cn-tiles">
        <div className="cn-tile">
          <b>{slice.verifiedWithinWindow} / {slice.published}</b>
          <span>Published programs verified in the last {windowDays} days ({rateText(slice.share)})</span>
        </div>
        <div className="cn-tile">
          <b>{daysText(slice.medianDaysSinceVerification)}</b>
          <span>
            Median days since verification{" "}
            {tone === "none" ? null : (
              <Chip icon={tone === "good" ? CheckCircle2 : AlertTriangle} tone={tone}>
                {tone === "good" ? `under ${target} d target` : `target under ${target} d`}
              </Chip>
            )}
          </span>
        </div>
        <div className="cn-tile"><b>{slice.neverVerified}</b><span>Never verified</span></div>
      </div>
      <table className="cn-table mx-narrow">
        <caption className="mx-sr">{title}: programs by days since verification</caption>
        <thead>
          <tr>{slice.ageBuckets.map((b) => <th scope="col" key={b.key} className="mx-num">{b.key === "never" ? "Never" : `${b.key} d`}</th>)}</tr>
        </thead>
        <tbody>
          <tr>{slice.ageBuckets.map((b) => <td key={b.key} className="mx-num">{b.n}</td>)}</tr>
        </tbody>
      </table>
    </div>
  );
}

function Freshness({ f }: { f: AdminMetricsView["freshness"] }) {
  return (
    <section className="cn-card" aria-labelledby="mx-fresh">
      <h2 id="mx-fresh">Registry freshness</h2>
      <p className="cn-muted">Published, active programs by their latest Curator verification. Registry counts are about programs, not people, so they are exact.</p>
      <FreshnessBlock slice={f.real} title="Curated programs" sample={false} windowDays={f.windowDays} target={f.targetMedianDays} />
      {f.sample.published > 0 ? <FreshnessBlock slice={f.sample} title="Sample programs" sample windowDays={f.windowDays} target={f.targetMedianDays} /> : null}
    </section>
  );
}

export interface MetricsViewProps {
  data: AdminMetricsView;
  days: MetricsDays;
  weeks: MetricsWeeks;
  onDays: (d: MetricsDays) => void;
  onWeeks: (w: MetricsWeeks) => void;
}

/** The page body for one loaded view (pure; rendered in tests). */
export function MetricsView({ data, days, weeks, onDays, onWeeks }: MetricsViewProps) {
  const notice = ingestNotice(data);
  return (
    <div className="mx-root">
      <div className="mx-controls">
        <Segmented label="Funnel window" options={METRICS_DAYS} value={days} onChange={onDays} unit="days" />
        <Segmented label="Weeks shown" options={METRICS_WEEKS} value={weeks} onChange={onWeeks} unit="wk" />
        <span className="cn-spacer" />
        <span className="cn-muted">
          {data.window.from} to {data.window.to} · generated {timeText(data.generatedAt)} · last event {timeText(data.ingest.lastEventAt)}
        </span>
      </div>
      <p className="cn-notice mx-note">
        <Info aria-hidden="true" /> Aggregates only. Any count of 1 to {data.k - 1} people is hidden, and where a hidden count could be worked out from a total, the cells next to it are hidden too. Staff accounts, deleted accounts, students under 18 and students who turned analytics off are not counted.
      </p>
      {notice ? (
        <p className="cn-notice mx-note" role="status">
          <AlertTriangle aria-hidden="true" /> {notice}
        </p>
      ) : null}
      <Funnel funnel={data.funnel} />
      <Retention retention={data.retention} weeks={data.window.weeks} />
      <Engagement e={data.engagement} />
      <Freshness f={data.freshness} />
    </div>
  );
}

export function MetricsPage({ api = metricsApi, onAuthError }: { api?: MetricsApi; onAuthError: (err: ConsoleError) => boolean }) {
  const [days, setDays] = useState<MetricsDays>(28);
  const [weeks, setWeeks] = useState<MetricsWeeks>(8);
  const [data, setData] = useState<AdminMetricsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.metrics(days, weeks));
      setError(null);
    } catch (err) {
      if (err instanceof ConsoleError && onAuthError(err)) return;
      if (err instanceof ConsoleError && err.kind === "forbidden") setError("Metrics are for admins only.");
      else setError(err instanceof ConsoleError ? err.detail : "Could not load the metrics.");
    }
  }, [api, days, weeks, onAuthError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return <div className="cn-card">{error ? <p className="cn-error" role="alert">{error}</p> : <span className="cn-muted">Loading…</span>}</div>;
  return (
    <>
      {error ? <p className="cn-error" role="alert">{error}</p> : null}
      <MetricsView data={data} days={days} weeks={weeks} onDays={setDays} onWeeks={setWeeks} />
    </>
  );
}

export default MetricsPage;
