/**
 * Program page, signed-in view (/app/programs/:slug). The hero carries the deadline in the
 * official zone and on the viewer's clock, the countdown and its ruler, and the verification
 * stamp; below it sit the four readiness parts, what the program gives, its cycles and sources.
 */
import { useId, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import type { ProgramDetail } from "@shared/contracts/registry";
import { addDays } from "@shared/time";
import { ApiError } from "@/components/readiness/api-client";
import { useProgramDetail, useReadiness, useTracker, useTrackProgram, useUntrackProgram } from "@/components/readiness/data";
import { CYCLE_STATUS_LABELS, formatCycleKey, formatShortDate, hostOf } from "@/components/readiness/format";
import {
  CountdownRuler,
  DotNumber,
  ErrorBanner,
  Glass,
  Icon,
  LookToggle,
  NvPage,
  PartHeading,
  SampleBanner,
  Skeleton,
  appHref,
} from "@/components/readiness/primitives";
import { DeviceOnlyReadiness, ReadinessParts, SignedOutReadiness } from "@/components/readiness/ReadinessParts";
import { appPaths } from "@/lib/routes";
import { useViewer } from "@/components/readiness/viewer";
import { OutcomeSummaryPanel } from "@/components/outcomes";
import { buildProgramView, type ProgramView } from "./model";

function Hero({ view, headingId }: { view: ProgramView; headingId: string }) {
  return (
    <Glass as="header" iris className="nvr-hero">
      <div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {view.tags.map((t) => (
            <span key={t.label} className="nvr-tag" data-tone={t.tone} data-ghost={t.ghost ? "" : undefined} data-sample={t.sample ? "" : undefined}>
              {t.tone ? <span className="nvr-led" aria-hidden="true" /> : null}
              {t.label}
            </span>
          ))}
        </div>
        <h1 id={headingId} className="nvr-h1" style={{ margin: "14px 0 6px", maxWidth: "22ch" }}>
          {view.title}
        </h1>
        <span className="nvr-meta">{view.organization}</span>
        {view.deadline ? (
          <p style={{ marginTop: 14, fontSize: 15.5 }}>
            {view.deadline.verb} <b style={{ fontWeight: 600 }}>{view.deadline.officialText}</b>{" "}
            {view.deadline.viewerText ? <span className="nvr-meta">{view.deadline.viewerText}</span> : null}
            {!view.deadline.timeStated && view.deadline.date && !view.deadline.approximate ? (
              <span className="nvr-meta" style={{ display: "block" }}>
                Time not stated: plan to submit by {formatShortDate(addDays(view.deadline.date, -1))}.
              </span>
            ) : null}
          </p>
        ) : null}
        {view.openingLine ? <p style={{ marginTop: 14 }}>{view.openingLine}</p> : null}
        {view.verifiedLine ? (
          <span className="nvr-verified">
            <Icon name="check" />
            {view.verifiedLine}
          </span>
        ) : null}
      </div>
      {view.countdown ? (
        <div className="nvr-count">
          <DotNumber value={view.countdown.value} spoken={view.countdown.spoken} />
          <div className="nvr-dot nvr-unit" aria-hidden="true">
            {view.countdown.unit}
          </div>
          {view.ruler ? (
            <div style={{ marginTop: 22, width: 260, maxWidth: "100%" }}>
              <CountdownRuler position={view.ruler.position} startLabel={view.ruler.startLabel} endLabel={view.ruler.endLabel} />
            </div>
          ) : null}
        </div>
      ) : null}
    </Glass>
  );
}

function TrackButton({ detail }: { detail: ProgramDetail }) {
  const tracker = useTracker();
  const track = useTrackProgram();
  const untrack = useUntrackProgram();
  const [message, setMessage] = useState("");
  const item = tracker.data?.data.find((i) => i.programCycleId === detail.cycle.id);
  const busy = track.isPending || untrack.isPending;

  const onClick = () => {
    setMessage("");
    if (item) {
      untrack.mutate(item.id, { onSuccess: () => setMessage("Removed from your Tracker.") });
      return;
    }
    track.mutate(
      { programCycleId: detail.cycle.id, programSlug: detail.program.slug, cycleKey: detail.cycle.cycleKey },
      {
        onSuccess: () => setMessage("Added to your Tracker."),
        onError: (err) => {
          if (err instanceof ApiError && err.code === "consent_required") {
            setMessage("This program serves students with a particular status. Give consent in Settings, Privacy, to track it.");
          } else if (err instanceof ApiError && err.status === 401) {
            setMessage("Sign in to track programs.");
          } else {
            setMessage("Could not update your Tracker. Try again.");
          }
        },
      },
    );
  };

  return (
    <>
      <button type="button" className="nvr-btn" aria-pressed={Boolean(item)} onClick={onClick} disabled={busy || tracker.isLoading}>
        <Icon name="star" />
        {item ? "Tracking" : "Track"}
      </button>
      <span className="nvr-sr" role="status" aria-live="polite">
        {message}
      </span>
      {message && !message.startsWith("Added") && !message.startsWith("Removed") ? (
        <p className="nvr-meta" style={{ flexBasis: "100%" }}>
          {message}
          {message.includes("Settings") ? (
            <>
              {" "}
              <Link className="nvr-link" href={appHref("/settings/privacy")}>
                Open privacy settings
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

function ReadinessSection({ detail, officialUrl }: { detail: ProgramDetail; officialUrl: string }) {
  const viewer = useViewer();
  const readiness = useReadiness(detail.cycle.id);
  const headingId = useId();
  const moreHref = appHref(`/readiness/${detail.cycle.id}?program=${encodeURIComponent(detail.program.slug)}`);

  return (
    <section aria-labelledby={headingId} style={{ marginTop: 34 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 14 }}>
        <h2 id={headingId} className="nvr-h2">
          Your readiness
        </h2>
        <span className="nvr-meta">Four parts. Never one score.</span>
      </div>
      {readiness.isLoading ? <Skeleton height={320} label="Loading your readiness" /> : null}
      {readiness.isError ? <ErrorBanner title="Your readiness could not load." onRetry={() => void readiness.refetch()} /> : null}
      {readiness.data?.kind === "report" ? (
        <ReadinessParts
          report={readiness.data.report}
          ruleSet={detail.ruleSet}
          officialUrl={officialUrl}
          today={viewer.today}
          sample={readiness.data.sample}
          variant="card"
          moreHref={moreHref}
        />
      ) : null}
      {readiness.data?.kind === "withheld" ? (
        <DeviceOnlyReadiness ruleSet={detail.ruleSet} programCycleId={detail.cycle.id} officialUrl={officialUrl} today={viewer.today} />
      ) : null}
      {readiness.data?.kind === "signed_out" ? (
        <SignedOutReadiness
          ruleSet={detail.ruleSet}
          programCycleId={detail.cycle.id}
          officialUrl={officialUrl}
          today={viewer.today}
          next={appPaths.program(detail.program.slug)}
        />
      ) : null}
    </section>
  );
}

function CyclesPanel({ detail }: { detail: ProgramDetail }) {
  const id = useId();
  const rows = [...detail.otherCycles.map((c) => ({ ...c, now: false })), { cycleKey: detail.cycle.cycleKey, status: detail.cycle.status, now: true }].sort((a, b) =>
    a.cycleKey.localeCompare(b.cycleKey),
  );
  return (
    <Glass as="article" className="nvr-panel" aria-labelledby={id}>
      <PartHeading id={id} title="Cycle history" />
      <ul className="nvr-rows" aria-label="Cycles">
        {rows.map((c) => (
          <li key={c.cycleKey} className="nvr-row" style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
            <span>
              {formatCycleKey(c.cycleKey)}
              {c.now ? <small>This cycle</small> : null}
            </span>
            <span className="nvr-tag" data-ghost="">
              {CYCLE_STATUS_LABELS[c.status]}
            </span>
          </li>
        ))}
      </ul>
      {detail.prediction ? (
        <p className="nvr-meta" style={{ marginTop: 12 }}>
          Next opening expected between {formatShortDate(detail.prediction.p10, { weekday: false })} and{" "}
          {formatShortDate(detail.prediction.p90, { weekday: false, year: true })} ({detail.prediction.label} confidence, from{" "}
          {detail.prediction.method.replace(/_/g, " ")}).
        </p>
      ) : null}
    </Glass>
  );
}

function SourcesPanel({ detail, view }: { detail: ProgramDetail; view: ProgramView }) {
  const id = useId();
  const c = detail.citation;
  const checked = c.sourceCheckedAt ? `checked ${formatShortDate(c.sourceCheckedAt.slice(0, 10), { weekday: false })}` : "not checked yet";
  const sources = [
    { title: "Official program page", url: c.officialUrl },
    ...(c.evidenceUrl && c.evidenceUrl !== c.officialUrl ? [{ title: "Eligibility source", url: c.evidenceUrl }] : []),
  ];
  return (
    <Glass as="article" className="nvr-panel" aria-labelledby={id}>
      <PartHeading id={id} title="Sources" />
      <ul className="nvr-rows">
        {sources.map((s) => (
          <li key={s.url} className="nvr-row">
            <Icon name="doc" />
            <span>
              <a className="nvr-link" href={s.url} target="_blank" rel="noopener noreferrer">
                {s.title}
              </a>
              <small>
                {hostOf(s.url)} · {checked}
              </small>
            </span>
            <span />
          </li>
        ))}
      </ul>
      {c.evidenceExcerpt ? (
        <blockquote className="nvr-body" style={{ margin: "12px 0 0", paddingLeft: 12, borderLeft: "2px solid var(--nv-line)" }}>
          “{c.evidenceExcerpt}”
        </blockquote>
      ) : null}
      <p className="nvr-meta" style={{ marginTop: "auto", paddingTop: 12 }}>
        Record version {c.recordVersion} · {c.license}.{" "}
        <a className="nvr-link" href={`${view.publicHref}#report-error`}>
          Report an error
        </a>
      </p>
    </Glass>
  );
}

function GivesPanel({ view }: { view: ProgramView }) {
  const id = useId();
  const lines = [...view.gives, ...view.costs, ...view.when];
  return (
    <Glass as="article" className="nvr-panel" aria-labelledby={id}>
      <PartHeading id={id} title="What it gives" />
      {view.summary ? (
        <p className="nvr-body" style={{ marginTop: 10 }}>
          {view.summary}
        </p>
      ) : null}
      <ul style={{ listStyle: "none", padding: 0, margin: "14px 0 0", display: "flex", flexDirection: "column", gap: 10 }}>
        {lines.map((l) => (
          <li key={l} style={{ display: "flex", gap: 10 }} className="nvr-body">
            <Icon name="leaf" />
            {l}
          </li>
        ))}
      </ul>
    </Glass>
  );
}

export default function ProgramPage({ params: routeParams }: { params?: { slug?: string } } = {}) {
  const params = useParams<{ slug?: string }>();
  const slug = routeParams?.slug ?? params.slug;
  const viewer = useViewer();
  const detail = useProgramDetail(slug);
  const headingId = useId();
  const view = useMemo(
    () => (detail.data ? buildProgramView(detail.data.data, viewer.now, viewer.tz, detail.data.sample) : null),
    [detail.data, viewer.now, viewer.tz],
  );

  return (
    <NvPage labelledBy={headingId}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <nav aria-label="Breadcrumb" className="nvr-meta" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Link href={appHref("/explore")}>Explore</Link>
          <Icon name="chev" className="nvr-icon" />
          <Link href={appHref("/tracker")}>Tracker</Link>
          <Icon name="chev" className="nvr-icon" />
          <span aria-current="page">{view?.title ?? "Program"}</span>
        </nav>
        <LookToggle />
      </div>

      <SampleBanner show={Boolean(detail.data?.sample)} />
      {!slug ? <ErrorBanner title="No program was named in the address." /> : null}
      {detail.isLoading ? <Skeleton height={360} label="Loading program" /> : null}
      {detail.isError ? (
        <ErrorBanner
          title={detail.error instanceof ApiError && detail.error.status === 404 ? "We could not find that program." : "The program could not load."}
          detail={detail.error instanceof ApiError && detail.error.status === 404 ? "It may have been renamed or merged. Try Explore." : undefined}
          onRetry={() => void detail.refetch()}
        />
      ) : null}

      {detail.data && view ? (
        <>
          <Hero view={view} headingId={headingId} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, margin: "16px 0 0" }}>
            <a className="nvr-btn-go" href={view.applyHref} target="_blank" rel="noopener noreferrer">
              Apply on the official site
              <Icon name="out" />
              <span className="nvr-sr">(opens in a new tab)</span>
            </a>
            <TrackButton detail={detail.data.data} />
            <a className="nvr-btn" href={view.calendarHref}>
              <Icon name="cal" />
              Add to calendar
            </a>
            <a className="nvr-btn" href={`${view.publicHref}#report-error`}>
              <Icon name="flag" />
              Report an error
            </a>
          </div>

          <ReadinessSection detail={detail.data.data} officialUrl={view.officialUrl} />

          {/* Aggregate, disclosure-safe outcome labels next to the readiness parts; renders nothing
              until the program has a released summary. */}
          {slug ? <OutcomeSummaryPanel slug={slug} /> : null}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" style={{ marginTop: 16 }}>
            <div className="grid min-w-0 grid-cols-1">
              <GivesPanel view={view} />
            </div>
            <div className="grid min-w-0 grid-cols-1">
              <CyclesPanel detail={detail.data.data} />
            </div>
            <div className="grid min-w-0 grid-cols-1">
              <SourcesPanel detail={detail.data.data} view={view} />
            </div>
          </div>
          {view.sample ? (
            <p className="nvr-meta" style={{ marginTop: 22 }}>
              Dates, counts and amounts on this page are sample data for review.
            </p>
          ) : null}
        </>
      ) : null}
    </NvPage>
  );
}
