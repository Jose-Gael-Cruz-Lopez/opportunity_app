import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import { CalendarClock, CheckCheck, Pin, PinOff, RotateCcw, Send, Undo2, X } from "lucide-react";
import { CheckPill } from "@/components/forms/controls";
import { CountdownCard, DotNumber, GlassPanel, PageShell, SampleNotice, StatTile } from "@/components/forms/surfaces";
import { appHref, programHref, roadmapItemAnchor } from "@/components/forms/links";
import { todayIso } from "@/components/forms/dates";
import { cn } from "@/lib/utils";
import { SAMPLE_CLASS_YEAR, useProfileClassYear, useRoadmapData } from "./data";
import {
  SEASON_LABELS,
  TONE_WORDS,
  currentTermKey,
  itemAccessibleName,
  itemDateLine,
  itemTone,
  layoutYears,
  nextDeadline,
  planStats,
  shortDate,
  thisSeason,
  toggleAction,
  type ItemTone,
  type PlanItem,
  type SeasonCell,
  type YearRow,
} from "./model";
import type { RoadmapItemAction } from "@shared/contracts";
import { parseTermKey } from "@shared/time";

/**
 * Roadmap: the student's plan by academic year and season, with this season's checklist, the next
 * deadline as a countdown card, and items that come from readiness next actions. Every count on
 * this page is a count of the student's own tasks; there is no score about the student.
 */

type Act = (item: PlanItem, action: RoadmapItemAction["action"]) => void;

function termLabel(term: string): string {
  const t = parseTermKey(term);
  return t ? `${SEASON_LABELS[t.term]} ${t.year}` : term;
}

export default function RoadmapPage() {
  const today = todayIso();
  const data = useRoadmapData(today);
  const profileClassYear = useProfileClassYear();
  const classYear = data.source === "live" ? profileClassYear : SAMPLE_CLASS_YEAR;
  const [announcement, setAnnouncement] = useState("");

  const view = useMemo(() => {
    if (!data.plan) return null;
    return {
      years: layoutYears(data.plan, { today, classYear }),
      season: thisSeason(data.plan, today),
      stats: planStats(data.plan, today),
      next: nextDeadline(data.plan, today),
      changed: data.plan.changedSinceLastVisit,
    };
  }, [data.plan, today, classYear]);

  const act: Act = (item, action) => {
    const saved = data.source === "live" ? "" : " (sample, not saved)";
    data.act(item, action).then(
      () => setAnnouncement(`${item.title}: ${actionWords(action)}${saved}.`),
      () => setAnnouncement(`Could not save the change to ${item.title}. It was undone.`),
    );
  };

  // Deep links from Readiness next actions: /app/roadmap#item-<key> focuses the item.
  useEffect(() => {
    if (!view || typeof window === "undefined") return;
    const id = window.location.hash.slice(1);
    if (!id.startsWith("item-")) return;
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ block: "center" });
      el.focus();
    }
  }, [view]);

  const nowLabel = termLabel(currentTermKey(today));
  const currentYear = view?.years.find((y) => y.seasons.some((s) => s.isNow));
  const lastYear = view?.years.at(-1);

  return (
    <PageShell labelledBy="roadmap-title">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 id="roadmap-title" className="nvp-h-lg">
            Roadmap
          </h1>
          <p className="nvp-meta mt-1">
            {currentYear?.yearOfStudy && lastYear?.yearOfStudy
              ? `Year ${currentYear.yearOfStudy} of ${lastYear.yearOfStudy} · you are here: ${nowLabel}`
              : `You are here: ${nowLabel}`}
          </p>
          {data.source === "sample" ? <SampleNotice /> : null}
          {data.source === "signed_out" ? (
            <SampleNotice>
              Sample plan. <Link href={appHref("/start")} className="underline underline-offset-2">Set up your profile</Link> to get your own.
            </SampleNotice>
          ) : null}
        </div>
        <Link className="nvp-btn" href={appHref("/explore")}>
          <Send size={18} aria-hidden="true" />
          Find programs to add
        </Link>
      </header>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {data.loading ? <LoadingState /> : null}
      {data.error ? <ErrorState message={data.error.message} onRetry={data.retry} /> : null}

      {view && view.years.length === 0 ? <EmptyState /> : null}

      {view && view.years.length > 0 ? (
        <>
          {view.changed.size > 0 ? (
            <p className="nvp-meta mb-4" role="note">
              {view.changed.size === 1 ? "1 item changed" : `${view.changed.size} items changed`} since your last visit. Changed items are marked
              "New".
            </p>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <SeasonCard items={view.season} today={today} act={act} pending={data.pending} />
            {view.next?.dueOn ? (
              <CountdownCard
                eyebrow={view.next.programName ?? view.next.title}
                opensOn={null}
                dueOn={view.next.dueOn}
                today={today}
                dueCaption={shortDate(view.next.dueOn)}
              />
            ) : (
              <GlassPanel as="article" className="flex flex-col justify-center rounded-[36px] p-6">
                <p className="text-[15px] text-[color:var(--nvp-ink-2)]">No open deadlines in your plan yet.</p>
              </GlassPanel>
            )}
          </div>

          <section aria-labelledby="stats-title" className="mt-4">
            <h2 id="stats-title" className="sr-only">
              This season at a glance
            </h2>
            <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
              <StatTile icon={<CalendarClock size={19} strokeWidth={1.4} />} label="Open this season" value={view.stats.openThisSeason} />
              <StatTile icon={<Send size={19} strokeWidth={1.4} />} label="Deadlines in 30 days" value={view.stats.dueWithin30} />
              <StatTile icon={<CheckCheck size={19} strokeWidth={1.4} />} label="Done this season" value={view.stats.doneThisSeason} />
              <StatTile icon={<Pin size={19} strokeWidth={1.4} />} label="Pinned" value={view.stats.pinned} dark />
            </div>
          </section>

          <section aria-labelledby="years-title" className="mt-8">
            <h2 id="years-title" className="mb-3 text-[19px] font-semibold">
              Your years, season by season
            </h2>
            <div className="flex flex-col gap-3.5">
              {view.years.map((y) => (
                <YearRowView key={y.startYear} row={y} today={today} act={act} pending={data.pending} changed={view.changed} />
              ))}
            </div>
            <Legend />
          </section>
        </>
      ) : null}
    </PageShell>
  );
}

function actionWords(action: RoadmapItemAction["action"]): string {
  const words: Record<RoadmapItemAction["action"], string> = {
    pin: "pinned",
    unpin: "unpinned",
    dismiss: "dismissed",
    restore: "restored",
    complete: "marked done",
    reopen: "reopened",
  };
  return words[action];
}

function SeasonCard({
  items,
  today,
  act,
  pending,
}: {
  items: readonly PlanItem[];
  today: string;
  act: Act;
  pending: ReadonlySet<string>;
}) {
  const done = items.filter((i) => i.state === "done").length;
  return (
    <GlassPanel iris as="article" aria-labelledby="season-title" className="grid gap-6 rounded-[34px] p-6 md:grid-cols-[minmax(0,200px)_minmax(0,1fr)] md:items-center md:pl-8">
      <div className="flex flex-col items-center gap-2 text-center">
        <h2 id="season-title" className="nvp-dot text-[44px] md:text-[56px]">
          This
          <br />
          season
        </h2>
        <span className="nvp-meta">
          {done} of {items.length} done
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-[15px] text-[color:var(--nvp-ink-2)]">Nothing is due this season. Pin a program to plan ahead.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="This season's items">
          {items.map((item) => {
            const date = itemDateLine(item);
            return (
              <li key={item.itemKey}>
                <CheckPill checked={item.state === "done"} disabled={pending.has(item.itemKey)} onChange={() => act(item, toggleAction(item))}>
                  <span className="block leading-snug">{item.title}</span>
                  {date ? <span className="nvp-meta block">{date}</span> : null}
                </CheckPill>
              </li>
            );
          })}
        </ul>
      )}
    </GlassPanel>
  );
}

function YearRowView({
  row,
  today,
  act,
  pending,
  changed,
}: {
  row: YearRow;
  today: string;
  act: Act;
  pending: ReadonlySet<string>;
  changed: ReadonlySet<string>;
}) {
  const yLabel = row.yearOfStudy !== null && row.yearOfStudy > 0 ? `Y${row.yearOfStudy}` : row.label.slice(2, 4) + "'";
  const yName = row.yearOfStudy !== null && row.yearOfStudy > 0 ? `Year ${row.yearOfStudy}, ${row.label}` : `Academic year ${row.label}`;
  return (
    <GlassPanel as="article" aria-label={yName} className={cn("grid gap-4 rounded-[30px] p-4 md:grid-cols-[120px_minmax(0,1fr)] md:p-5", row.isPast && "nvp-past")}>
      <div className="flex items-baseline gap-3 px-1 md:flex-col md:gap-1.5 md:pt-1">
        <DotNumber value={yLabel} label={yName} className="text-[34px] md:text-[38px]" />
        <span className="nvp-meta" aria-hidden="true">
          {row.label}
        </span>
      </div>
      <div className={cn("grid gap-2.5 sm:grid-cols-2", row.seasons.length === 4 ? "xl:grid-cols-4" : "lg:grid-cols-3")}>
        {row.seasons.map((cell) => (
          <SeasonCellView key={cell.term} cell={cell} today={today} act={act} pending={pending} changed={changed} />
        ))}
      </div>
    </GlassPanel>
  );
}

function SeasonCellView({
  cell,
  today,
  act,
  pending,
  changed,
}: {
  cell: SeasonCell;
  today: string;
  act: Act;
  pending: ReadonlySet<string>;
  changed: ReadonlySet<string>;
}) {
  const headingId = `term-${cell.term}`;
  return (
    <section className="nvp-sz" data-now={cell.isNow ? "" : undefined} aria-labelledby={headingId}>
      <h3 id={headingId} className="nvp-label flex items-center justify-between gap-2">
        <span>
          {SEASON_LABELS[cell.season]} <span className="sr-only">{cell.term.split("-")[1]}</span>
        </span>
        {cell.isNow ? (
          <span className="rounded-full bg-[color:var(--nvp-cream)] px-2 py-0.5 text-[10px] tracking-[0.06em] text-[color:var(--nvp-ink-dark)]">You are here</span>
        ) : null}
      </h3>
      {cell.items.length === 0 ? (
        <p className="text-[13.5px] text-[color:var(--nvp-ink-3)]">{cell.isPast ? "Nothing recorded" : "Open"}</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {cell.items.map((item) => (
            <ItemLine key={item.itemKey} item={item} today={today} act={act} busy={pending.has(item.itemKey)} isNew={changed.has(item.itemKey)} />
          ))}
        </ul>
      )}
      {cell.more > 0 ? (
        <Link className="nvp-meta underline underline-offset-2" href={appHref("/explore")}>
          +{cell.more} more you could apply to
        </Link>
      ) : null}
      {cell.capacityWarning ? (
        <p className="text-[13px] text-[color:var(--nvp-warn)]" role="note">
          {cell.capacityWarning}
        </p>
      ) : null}
    </section>
  );
}

function ItemLine({ item, today, act, busy, isNew }: { item: PlanItem; today: string; act: Act; busy: boolean; isNew: boolean }) {
  const tone: ItemTone = itemTone(item, today);
  const date = itemDateLine(item);
  const name = itemAccessibleName(item, today);
  return (
    <li id={roadmapItemAnchor(item.itemKey)} tabIndex={-1} className="nvp-item rounded-xl outline-offset-2">
      <div className="nvp-ms" data-tone={tone}>
        <i aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <span className="block">
            {item.programSlug && item.kind === "apply" ? (
              <Link href={programHref(item.programSlug)} className="hover:underline">
                {item.title}
              </Link>
            ) : (
              item.title
            )}
            {item.pinned ? <Pin size={12} className="ml-1 inline align-[-1px]" aria-label="Pinned" /> : null}
            {isNew ? <span className="nvp-label ml-1.5 text-[color:var(--nvp-wheat)]">New</span> : null}
          </span>
          <span className="sr-only">{TONE_WORDS[tone]}.</span>
          {date ? <span className="nvp-meta block">{date}</span> : null}
          {item.origin === "next_action" ? <span className="nvp-meta block">From your readiness next steps</span> : null}
        </div>
      </div>
      <div className="nvp-item-actions mt-1 flex flex-wrap gap-1 pl-[18px]" role="group" aria-label={`Actions for ${name}`}>
        {item.state === "done" ? (
          <ItemButton label="Reopen" icon={<RotateCcw size={14} />} onClick={() => act(item, "reopen")} busy={busy} />
        ) : item.state === "dismissed" ? (
          <ItemButton label="Restore" icon={<Undo2 size={14} />} onClick={() => act(item, "restore")} busy={busy} />
        ) : (
          <>
            <ItemButton label="Done" icon={<CheckCheck size={14} />} onClick={() => act(item, "complete")} busy={busy} />
            <ItemButton
              label={item.pinned ? "Unpin" : "Pin"}
              icon={item.pinned ? <PinOff size={14} /> : <Pin size={14} />}
              onClick={() => act(item, item.pinned ? "unpin" : "pin")}
              busy={busy}
            />
            {item.kind !== "milestone" ? <ItemButton label="Dismiss" icon={<X size={14} />} onClick={() => act(item, "dismiss")} busy={busy} /> : null}
          </>
        )}
      </div>
    </li>
  );
}

function ItemButton({ label, icon, onClick, busy }: { label: string; icon: React.ReactNode; onClick: () => void; busy: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="inline-flex min-h-[28px] items-center gap-1 rounded-full border border-[color:var(--nvp-line)] px-2.5 text-[12px] text-[color:var(--nvp-ink-2)] transition hover:bg-white/10 disabled:opacity-40"
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </button>
  );
}

function Legend() {
  const tones: ItemTone[] = ["done", "soon", "due", "plan", "missed"];
  return (
    <div className="mt-4 flex flex-wrap gap-4" aria-label="Legend">
      {tones.map((t) => (
        <span key={t} className="nvp-ms nvp-meta" data-tone={t}>
          <i aria-hidden="true" />
          {TONE_WORDS[t]}
        </span>
      ))}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="grid gap-4" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your roadmap</span>
      {[0, 1, 2].map((i) => (
        <div key={i} className="nvp-glass h-40 animate-pulse rounded-[30px] motion-reduce:animate-none" />
      ))}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <GlassPanel className="rounded-[28px] p-6" role="alert">
      <p className="font-semibold">Your roadmap did not load.</p>
      <p className="nvp-meta mt-1">{message}</p>
      <button type="button" className="nvp-btn mt-4" onClick={onRetry}>
        Try again
      </button>
    </GlassPanel>
  );
}

function EmptyState() {
  return (
    <GlassPanel iris className="rounded-[34px] p-8 text-center">
      <h2 className="text-[22px] font-semibold">Your plan starts with a profile</h2>
      <p className="mx-auto mt-2 max-w-[46ch] text-[color:var(--nvp-ink-2)]">
        Tell Novus your class year and field, then pin a few programs. The roadmap lays them out season by season.
      </p>
      <Link href={appHref("/start")} className="nvp-btn-go mt-6">
        Set up my profile
      </Link>
    </GlassPanel>
  );
}
