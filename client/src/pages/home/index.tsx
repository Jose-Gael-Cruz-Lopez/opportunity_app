import { useMemo } from "react";
import { CalendarClock, ListChecks, Send, Sparkles } from "lucide-react";
import { Link, useLocation } from "wouter";
import { OPPORTUNITY_GROUP_LABELS } from "@shared/taxonomy";
import { CountdownCard, EmptyPanel, ErrorPanel, LoadingPanel, Panel, StatTile } from "@/components/app";
import { useToast } from "@/hooks/use-toast";
import { describeApiError } from "@/lib/api";
import { cardStatus, viewerToday } from "@/lib/deadlines";
import { firstName, formatLongDate } from "@/lib/format";
import { useInbox, usePrograms, useRoadmap, useRoadmapAction, useSession, useTracker } from "@/lib/queries";
import { appPaths } from "@/lib/routes";
import { joinTracked, summarizeTracker } from "@/lib/tracker-summary";
import { useNow } from "@/lib/use-now";
import { groupCounts } from "../explore/filters";
import { AskBox } from "./AskBox";
import { ChangesFeed } from "./ChangesFeed";
import { buildWeek, eventDatesThisWeek, feedRows, pickForSeason, planForWeek, tileState } from "./model";
import { PickedCard } from "./PickedCard";
import { PlanCard } from "./PlanCard";

function Greeting({ name, today }: { name: string | null; today: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid h-[50px] w-[50px] flex-none place-items-center rounded-full border-2 border-white/60 bg-white/10 text-lg font-semibold" aria-hidden="true">
        {name ? name.charAt(0).toUpperCase() : "N"}
      </span>
      <div>
        <span className="nv-meta">{formatLongDate(today)}</span>
        <b className="block text-[17px] font-semibold">{name ? `Hello, ${name}` : "Hello"}</b>
      </div>
    </div>
  );
}

function TypeChips() {
  const programs = usePrograms();
  const [, navigate] = useLocation();
  const groups = useMemo(() => groupCounts(programs.data?.data ?? []), [programs.data]);
  if (groups.length === 0) return null;
  return (
    <div className="nv-chip-row mb-7" role="group" aria-label="Browse by program type">
      {groups.map((g) => (
        <button key={g.group} type="button" className="nv-chip" onClick={() => navigate(`${appPaths.explore}?group=${g.group}`)}>
          {OPPORTUNITY_GROUP_LABELS[g.group]}
        </button>
      ))}
    </div>
  );
}

function SignedOutHome() {
  return (
    <Panel iris className="flex flex-col items-start gap-4 rounded-[34px] p-8">
      <h2 className="text-2xl font-semibold">Start with your season</h2>
      <p className="max-w-[52ch] nv-ink-2">
        Tell Novus your year and field to get a weekly plan, deadline countdowns and programs picked for you. Status and identity questions are
        answered on your device and never sent.
      </p>
      <div className="flex flex-wrap gap-3">
        <Link href={appPaths.start} className="nv-btn-go">
          Get started
        </Link>
        <Link href={appPaths.explore} className="nv-btn">
          Explore first
        </Link>
      </div>
    </Panel>
  );
}

export default function HomePage() {
  const now = useNow();
  const session = useSession();
  const programs = usePrograms();
  const tracker = useTracker();
  const roadmap = useRoadmap();
  const inbox = useInbox();
  const roadmapAction = useRoadmapAction();
  const { toast } = useToast();

  const user = session.data?.data.user ?? null;
  const profile = session.data?.data.profile ?? null;
  const zone = profile?.timeZone ?? null;
  const today = viewerToday(now, zone);
  const cards = programs.data?.data ?? [];
  const trackerItems = tracker.data?.data ?? [];

  const plan = useMemo(() => planForWeek(roadmap.data?.data, today), [roadmap.data, today]);
  const trackedCards = useMemo(() => joinTracked(cards, trackerItems).flatMap((t) => (t.card && t.item.status !== "not_applying" ? [t.card] : [])), [cards, trackerItems]);
  const week = useMemo(() => buildWeek(today, eventDatesThisWeek(today, plan, trackedCards, now, zone)), [today, plan, trackedCards, now, zone]);
  const summary = useMemo(() => summarizeTracker(cards, trackerItems, now, zone), [cards, trackerItems, now, zone]);
  const pick = useMemo(() => pickForSeason(cards, profile, trackerItems, now), [cards, profile, trackerItems, now]);
  const rows = useMemo(() => feedRows(inbox.data?.data ?? []), [inbox.data]);

  const toggle = (item: (typeof plan)[number]) =>
    roadmapAction.mutate(
      { itemKey: item.itemKey, action: item.state === "done" ? "reopen" : "complete" },
      { onError: (err) => toast({ title: "Could not update your plan", description: describeApiError(err) }) },
    );

  if (session.isPending) return <LoadingPanel label="Loading your home…" />;
  if (session.isError) return <ErrorPanel error={session.error} onRetry={() => void session.refetch()} />;

  const name = firstName(user?.displayName);
  // Each tile waits for its own data: an empty state ("No deadlines yet") is only true once the
  // query behind it has loaded, never while it is loading or after it failed.
  const trackerTile = tileState(tracker, programs);
  const planTile = tileState(roadmap);
  const feedTile = tileState(inbox);
  const retryTracker = () => {
    if (tracker.isError) void tracker.refetch();
    if (programs.isError) void programs.refetch();
  };

  return (
    <section aria-labelledby="home-title">
      <Greeting name={name} today={today} />
      <h1 id="home-title" className="nv-h-xl mb-[22px] mt-6">
        Where will you
        <br />
        <span className="nv-soft">
          <span className="nv-hl">grow next?</span>
        </span>
      </h1>
      <TypeChips />

      {!user ? (
        <SignedOutHome />
      ) : (
        <div className="nv-bento">
          {planTile === "loading" ? (
            <LoadingPanel className="nv-b-plan rounded-[36px]" label="Loading this week's plan…" />
          ) : planTile === "error" ? (
            <ErrorPanel className="nv-b-plan rounded-[36px]" error={roadmap.error} onRetry={() => void roadmap.refetch()} />
          ) : (
            <PlanCard className="nv-b-plan" week={week} items={plan} onToggle={toggle} busyKey={roadmapAction.isPending ? (roadmapAction.variables?.itemKey ?? null) : null} />
          )}

          {programs.isError ? (
            <ErrorPanel className="nv-b-pick" error={programs.error} onRetry={() => void programs.refetch()} />
          ) : (
            <PickedCard className="nv-b-pick" pick={pick} status={pick ? cardStatus(pick.card, now, zone) : null} />
          )}

          {trackerTile === "loading" ? (
            <LoadingPanel className="nv-b-due rounded-[36px]" label="Loading your deadlines…" />
          ) : trackerTile === "error" ? (
            <ErrorPanel className="nv-b-due rounded-[36px]" error={tracker.error ?? programs.error} onRetry={retryTracker} />
          ) : summary.nextUp ? (
            <CountdownCard
              className="nv-b-due"
              headingId="due-title"
              eyebrow={
                <Link href={appPaths.program(summary.nextUp.card.slug)} className="hover:underline">
                  {summary.nextUp.card.name}
                  {summary.nextUp.countdown.scope === "campus" ? " · campus deadline" : ""}
                </Link>
              }
              countdown={summary.nextUp.countdown}
            />
          ) : (
            <EmptyPanel className="nv-b-due rounded-[36px]" title="No deadlines yet">
              Track a program to see its countdown here.
            </EmptyPanel>
          )}

          <section className="nv-b-stats nv-stats" aria-labelledby="stats-title">
            <h2 id="stats-title" className="sr-only">
              This season at a glance
            </h2>
            {/* Zeros would read as "you track nothing": show counts only once the Tracker has loaded. */}
            {trackerTile === "ready" ? (
              <>
                <StatTile icon={ListChecks} label="Programs tracked" value={summary.tracked} dots={{ on: summary.applying + summary.submitted, total: summary.tracked }} />
                <StatTile icon={CalendarClock} label="Due in 30 days" value={summary.dueSoon} bars={summary.weeklyDue} />
                <StatTile icon={Sparkles} label="Applying now" value={summary.applying} of={summary.tracked || undefined} />
                <StatTile
                  icon={Send}
                  label="Applications sent"
                  value={summary.submitted}
                  dots={{ on: summary.submitted, total: Math.max(summary.tracked, summary.submitted) }}
                  dark
                />
              </>
            ) : trackerTile === "loading" ? (
              <LoadingPanel className="col-span-full rounded-[28px]" label="Loading your season…" />
            ) : (
              <EmptyPanel className="col-span-full rounded-[28px]" title="Counts are not available">
                They appear once your Tracker loads.
              </EmptyPanel>
            )}
          </section>

          {feedTile === "loading" ? (
            <LoadingPanel className="nv-b-feed rounded-[28px]" label="Loading changes to programs you track…" />
          ) : feedTile === "error" ? (
            <ErrorPanel className="nv-b-feed rounded-[28px]" error={inbox.error} onRetry={() => void inbox.refetch()} />
          ) : (
            <ChangesFeed className="nv-b-feed" rows={rows} now={now} />
          )}
          <AskBox className="nv-b-ask" />
        </div>
      )}
    </section>
  );
}
