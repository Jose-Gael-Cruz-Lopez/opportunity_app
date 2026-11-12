import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { Link, useLocation, useSearch } from "wouter";
import type { ProgramCard } from "@shared/contracts/registry";
import { EmptyPanel, ErrorPanel, LoadingPanel, Panel, ProgramCardView } from "@/components/app";
import { cardStatus } from "@/lib/deadlines";
import { eligibilityHint } from "@/lib/eligibility-hint";
import { formatShortDate, plural } from "@/lib/format";
import { usePrograms, useSession } from "@/lib/queries";
import { appPaths } from "@/lib/routes";
import { useNow } from "@/lib/use-now";
import { useTrackToggle } from "@/lib/use-track-toggle";
import { whyShownLine } from "@/lib/why-shown";
import { activeFilterCount, applyFilters, DEFAULT_FILTERS, groupCounts, parseFilters, serializeFilters, type ExploreFilters } from "./filters";
import { buildProgramIndex, searchPrograms } from "./search";

const TOGGLES: ReadonlyArray<{ key: "openToMyYear" | "paid" | "openNow"; label: string }> = [
  { key: "openToMyYear", label: "Open to my year" },
  { key: "openNow", label: "Open now" },
  { key: "paid", label: "Paid" },
];

const CLOSING_SOON_COUNT = 4;

function ClosingSoon({ cards, now, timeZone }: { cards: readonly ProgramCard[]; now: number; timeZone: string | null }) {
  const soon = cards
    .map((card) => ({ card, status: cardStatus(card, now, timeZone) }))
    .filter((x) => x.card.status === "open" && x.status.next)
    .sort((a, b) => (a.status.next?.daysLeft ?? 0) - (b.status.next?.daysLeft ?? 0))
    .slice(0, CLOSING_SOON_COUNT);
  return (
    <Panel as="aside" className="nv-sticky-xl rounded-[30px] px-5 py-5" aria-labelledby="closing-title">
      <h2 id="closing-title" className="nv-sec-title">
        Closing soon
      </h2>
      <p className="nv-meta">Official deadlines, shown in your time zone</p>
      {soon.length === 0 ? (
        <p className="mt-3 text-sm nv-ink-2">Nothing closes in the next weeks.</p>
      ) : (
        <ul className="mt-3">
          {soon.map(({ card, status }) => (
            <li key={card.programCycleId}>
              <Link href={appPaths.program(card.slug)} className="nv-closing-row">
                <span className="nv-closing-n" aria-hidden="true">
                  {status.next?.daysLeft}
                  <small className="mt-1.5 block font-sans text-[11px] tracking-[.14em] nv-ink-3">DAYS</small>
                </span>
                <span>
                  <b className="block text-[15px] font-semibold leading-tight">{card.name}</b>
                  <span className="nv-meta">
                    <span className="sr-only">{plural(status.next?.daysLeft ?? 0, "day")} left, </span>
                    due {status.next ? formatShortDate(status.next.date) : ""}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function ExplorePage() {
  const search = useSearch();
  const [location, navigate] = useLocation();
  const filters = useMemo(() => parseFilters(search), [search]);
  const [draft, setDraft] = useState(filters.q);
  const deferredQ = useDeferredValue(draft);
  const programs = usePrograms();
  const session = useSession();
  const tracking = useTrackToggle();
  const profile = session.data?.data.profile ?? null;
  const timeZone = profile?.timeZone ?? null;
  const cards = programs.data?.data ?? [];
  const now = useNow();

  // Keep the box in step when the URL changes from outside (top-bar search, back button).
  useEffect(() => setDraft(filters.q), [filters.q]);

  const update = (next: Partial<ExploreFilters>) => {
    navigate(`${location}${serializeFilters({ ...filters, ...next })}`, { replace: true });
  };

  // Write the typed query to the URL after a short pause, so history is not flooded.
  useEffect(() => {
    if (draft === filters.q) return;
    const t = window.setTimeout(() => update({ q: draft }), 300);
    return () => window.clearTimeout(t);
    // Only the draft drives this; `update` reads the latest filters when it fires.
  }, [draft]);

  const index = useMemo(() => buildProgramIndex(cards), [cards]);
  const hits = useMemo(() => (deferredQ.trim() ? searchPrograms(index, deferredQ) : null), [index, deferredQ]);
  const results = useMemo(() => applyFilters(cards, { ...filters, q: deferredQ }, { profile, now, searchHits: hits }), [cards, filters, deferredQ, profile, now, hits]);
  const groups = useMemo(() => groupCounts(cards), [cards]);
  const anyFilter = activeFilterCount(filters) > 0 || !!deferredQ.trim();

  return (
    <section aria-labelledby="explore-title">
      <div className="mb-5">
        <h1 id="explore-title" className="nv-h-lg mb-1.5">
          Explore
        </h1>
        <p className="nv-meta">
          {programs.data ? `${plural(cards.length, "program")} · each one checked by a person` : "Programs checked by people"}
          {programs.data?.source === "sample" ? " · sample data" : ""}
        </p>
      </div>

      <Panel as="form" role="search" className="nv-field mb-4 h-16 pl-5 pr-2.5" onSubmit={(e) => { e.preventDefault(); update({ q: draft }); }}>
        <Search aria-hidden="true" className="h-5 w-5 flex-none nv-ink-2" strokeWidth={1.6} />
        <label htmlFor="explore-q" className="sr-only">
          Search programs
        </label>
        <input
          id="explore-q"
          type="search"
          className="text-[17px]"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Search by program, organization or field"
          autoComplete="off"
          enterKeyHint="search"
        />
        {anyFilter ? (
          <button
            type="button"
            className="nv-btn min-h-10 px-4 text-sm"
            onClick={() => {
              setDraft("");
              navigate(location, { replace: true });
            }}
          >
            Clear
          </button>
        ) : (
          <SlidersHorizontal aria-hidden="true" className="mr-3 h-5 w-5 flex-none nv-ink-3" strokeWidth={1.6} />
        )}
      </Panel>

      <div className="nv-chip-row" role="group" aria-label="Program type">
        <button type="button" className="nv-chip" aria-pressed={filters.group === "all"} onClick={() => update({ group: "all" })}>
          All <span className="nv-chip-n">{cards.length}</span>
        </button>
        {groups.map((g) => (
          <button key={g.group} type="button" className="nv-chip" aria-pressed={filters.group === g.group} onClick={() => update({ group: filters.group === g.group ? "all" : g.group })}>
            {g.label} <span className="nv-chip-n">{g.count}</span>
          </button>
        ))}
      </div>

      <div className="mb-6 mt-4 flex flex-wrap gap-2.5" role="group" aria-label="Filters">
        {TOGGLES.map((t) => {
          const disabled = t.key === "openToMyYear" && !profile?.classYear;
          return (
            <button
              key={t.key}
              type="button"
              className="nv-toggle disabled:opacity-60"
              aria-pressed={filters[t.key]}
              disabled={disabled}
              title={disabled ? "Add your class year in Settings to use this filter" : undefined}
              onClick={() => update({ [t.key]: !filters[t.key] } as Partial<ExploreFilters>)}
            >
              <span className="nv-sw" aria-hidden="true" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="nv-ex-grid">
        <div>
          <p className="nv-meta mb-3" aria-live="polite">
            {programs.data ? `Showing ${plural(results.length, "program")}${hits ? ", best match first" : ", soonest deadline first"}` : ""}
          </p>
          {programs.isPending ? (
            <LoadingPanel label="Loading programs…" />
          ) : programs.isError ? (
            <ErrorPanel error={programs.error} onRetry={() => void programs.refetch()} />
          ) : results.length === 0 ? (
            <EmptyPanel title="No programs match">
              Clear a filter or try another word.{" "}
              <button type="button" className="nv-link underline" onClick={() => { setDraft(""); update({ ...DEFAULT_FILTERS }); }}>
                Clear everything
              </button>
            </EmptyPanel>
          ) : (
            <ul className="nv-cards">
              {results.map((card) => (
                <li key={card.programCycleId} className="flex">
                  <ProgramCardView
                    className="w-full"
                    card={card}
                    status={cardStatus(card, now, timeZone)}
                    hint={eligibilityHint(card, profile)}
                    whyShown={whyShownLine(card, profile, now)}
                    tracked={tracking.isTracked(card)}
                    onToggleTrack={() => tracking.toggle(card)}
                    trackBusy={tracking.busy}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
        {programs.data ? <ClosingSoon cards={cards} now={now} timeZone={timeZone} /> : null}
      </div>
    </section>
  );
}
