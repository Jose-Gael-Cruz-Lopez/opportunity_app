/**
 * Readiness view (/app/readiness/:programCycleId?program=:slug): the four parts in full, with up
 * to five next actions and the optional assistant. The `program` query names the slug so the
 * page can load the rule set even when the server withholds readiness for a status-defined
 * program; without it the slug comes from the report.
 */
import { useId, useMemo } from "react";
import { Link, useParams, useSearch } from "wouter";
import { useProgramDetail, useReadiness } from "@/components/readiness/data";
import { describeDeadline, formatShortDate, pickPrimaryDeadline } from "@/components/readiness/format";
import {
  ErrorBanner,
  Icon,
  LookToggle,
  NvPage,
  SampleBanner,
  Skeleton,
  StatTile,
  appHref,
} from "@/components/readiness/primitives";
import { DeviceOnlyReadiness, ReadinessParts, SignedOutReadiness } from "@/components/readiness/ReadinessParts";
import { appPaths } from "@/lib/routes";
import { ReadinessAssistant } from "@/components/readiness/ReadinessAssistant";
import { useViewer } from "@/components/readiness/viewer";
import { nextStartBy, readinessSlugFrom } from "./model";

export default function ReadinessPage({ params: routeParams }: { params?: { programCycleId?: string } } = {}) {
  const params = useParams<{ programCycleId?: string }>();
  const search = useSearch();
  const programCycleId = routeParams?.programCycleId ?? params.programCycleId;
  const viewer = useViewer();
  const headingId = useId();
  const readiness = useReadiness(programCycleId);
  const slug = readinessSlugFrom(search, readiness.data?.kind === "report" ? readiness.data.report.programSlug : null);
  const detail = useProgramDetail(slug ?? undefined);

  const program = detail.data?.data;
  const deadline = useMemo(() => {
    if (!program) return null;
    const d = pickPrimaryDeadline(program.deadlines, viewer.now, viewer.tz);
    return d ? describeDeadline(d, viewer.now, viewer.tz) : null;
  }, [program, viewer.now, viewer.tz]);
  const report = readiness.data?.kind === "report" ? readiness.data.report : null;
  const startBy = report ? nextStartBy(report) : null;
  const sample = Boolean((readiness.data?.kind === "report" && readiness.data.sample) || detail.data?.sample);
  const officialUrl = program?.program.officialUrl ?? null;
  const title = program?.program.name ?? "Your readiness";

  return (
    <NvPage labelledBy={headingId}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
        <nav aria-label="Breadcrumb" className="nvr-meta" style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Link href={appHref("/tracker")}>Tracker</Link>
          <Icon name="chev" />
          {slug ? <Link href={appHref(`/programs/${slug}`)}>{program?.program.name ?? "Program"}</Link> : <span>Program</span>}
          <Icon name="chev" />
          <span aria-current="page">Readiness</span>
        </nav>
        <LookToggle />
      </div>

      <SampleBanner show={sample} />

      <header style={{ display: "grid", gap: 16, marginBottom: 22, alignItems: "end" }} className="grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <p className="nvr-label">Readiness · four parts, never one score</p>
          <h1 id={headingId} className="nvr-h1" style={{ marginTop: 8 }}>
            {title}
          </h1>
          {program ? <p className="nvr-meta" style={{ marginTop: 6 }}>{program.organization.name}</p> : null}
          {deadline ? (
            <p style={{ marginTop: 12 }}>
              {deadline.verb} <b style={{ fontWeight: 600 }}>{deadline.officialText}</b>{" "}
              {deadline.viewerText ? <span className="nvr-meta">{deadline.viewerText}</span> : null}
            </p>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-2" style={{ minWidth: 0 }}>
          {deadline && deadline.daysLeft !== null && deadline.daysLeft >= 0 ? (
            <StatTile label="Days left" value={deadline.daysLeft} spoken={`${deadline.daysLeft} days left`} />
          ) : null}
          {startBy ? (
            <StatTile
              label="Start next"
              value={formatShortDate(startBy.date, { weekday: false })}
              spoken={`Start ${startBy.label} by ${formatShortDate(startBy.date)}`}
              note={startBy.label}
            />
          ) : null}
        </div>
      </header>

      {readiness.isLoading ? <Skeleton height={420} label="Loading your readiness" /> : null}
      {readiness.isError ? <ErrorBanner title="Your readiness could not load." onRetry={() => void readiness.refetch()} /> : null}
      {!programCycleId ? <ErrorBanner title="No program cycle was named in the address." /> : null}

      {report ? (
        <>
          <ReadinessParts
            report={report}
            ruleSet={program?.ruleSet ?? null}
            officialUrl={officialUrl}
            today={viewer.today}
            sample={sample}
            variant="detail"
          />
          <div style={{ marginTop: 16 }}>
            <ReadinessAssistant report={report} sample={sample} />
          </div>
          <p className="nvr-meta" style={{ marginTop: 18 }}>
            Computed {formatShortDate(report.generatedAt.slice(0, 10), { weekday: false, year: true })} with {report.algoVersion}. Private answers are
            checked in this browser and never sent.
          </p>
        </>
      ) : null}

      {readiness.data?.kind === "withheld" && programCycleId ? (
        detail.isLoading ? (
          <Skeleton height={240} label="Loading the program's rules" />
        ) : (
          <DeviceOnlyReadiness ruleSet={program?.ruleSet ?? null} programCycleId={programCycleId} officialUrl={officialUrl} today={viewer.today} />
        )
      ) : null}

      {readiness.data?.kind === "signed_out" && programCycleId ? (
        detail.isLoading ? (
          <Skeleton height={240} label="Loading the program's rules" />
        ) : (
          <SignedOutReadiness
            ruleSet={program?.ruleSet ?? null}
            programCycleId={programCycleId}
            officialUrl={officialUrl}
            today={viewer.today}
            next={appPaths.readiness(programCycleId, slug ?? undefined)}
          />
        )
      ) : null}
    </NvPage>
  );
}
