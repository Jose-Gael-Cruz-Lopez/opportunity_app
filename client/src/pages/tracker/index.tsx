/**
 * Tracker board (/app/tracker): tracked program cycles in five status columns, earliest date
 * first. Cards move with a labelled "Move to" menu (keyboard and screen readers) or by drag and
 * drop (pointer users); both send the same PATCH with the version the card last saw.
 */
import { useId, useMemo, useState, type DragEvent, type ReactNode } from "react";
import { Link } from "wouter";
import { TRACKER_STATUSES, type TrackerStatus } from "@shared/taxonomy";
import { ApiError } from "@/components/readiness/api-client";
import { useProgramDetail, useReleaseCards, useTracker, useUntrackProgram, useUpdateTrackerItem } from "@/components/readiness/data";
import { TRACKER_STATUS_LABELS } from "@/components/readiness/format";
import {
  DotNumber,
  ErrorBanner,
  SignInPrompt,
  Glass,
  Icon,
  LookToggle,
  NvPage,
  SampleBanner,
  Skeleton,
  StatTile,
  appHref,
} from "@/components/readiness/primitives";
import { useViewer } from "@/components/readiness/viewer";
import { decisionWindowFor, OutcomePrompt, type OutcomePromptProps } from "@/components/outcomes";
import { appPaths } from "@/lib/routes";
import { groupTracker, movePatch, trackerSummary, type TrackerCardView, type TrackerColumn } from "./model";

const DRAG_TYPE = "application/x-novus-tracker-item";

interface CardActions {
  move(card: TrackerCardView, to: TrackerStatus): void;
  remove(card: TrackerCardView): void;
  setCampusDate(card: TrackerCardView, date: string | null): void;
  /** The outcome prompt for a submitted or decided card (renders nothing otherwise). */
  outcome(card: TrackerCardView): ReactNode;
}

/**
 * The outcome prompt with the cycle's curated decision window, so a submitted card asks "How did
 * it go?" 3 days after the expected decision date. The program detail is loaded only for
 * submitted cards (a decided card asks without it).
 */
function TrackedOutcome({ item, card, slug, today }: { item: OutcomePromptProps["item"]; card: NonNullable<OutcomePromptProps["card"]>; slug: string; today: string }) {
  const detail = useProgramDetail(item.status === "submitted" && !card.flags.sensitiveAudience ? slug : undefined);
  const window = decisionWindowFor(detail.data && !detail.data.sample ? detail.data.data.cycle : null, item.programCycleId);
  return <OutcomePrompt item={item} card={card} window={window} today={today} />;
}

function TrackerCard({ card, actions, onDragState }: { card: TrackerCardView; actions: CardActions; onDragState: (id: string | null) => void }) {
  const selectId = useId();
  const dateId = useId();
  const [dragging, setDragging] = useState(false);

  const onDragStart = (e: DragEvent<HTMLElement>) => {
    e.dataTransfer.setData(DRAG_TYPE, card.id);
    e.dataTransfer.effectAllowed = "move";
    setDragging(true);
    onDragState(card.id);
  };
  const onDragEnd = () => {
    setDragging(false);
    onDragState(null);
  };

  return (
    <li className="nvr-tcard" draggable onDragStart={onDragStart} onDragEnd={onDragEnd} data-dragging={dragging ? "" : undefined}>
      <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
        <span className="nvr-mono-badge" aria-hidden="true">
          {card.monogram}
        </span>
        <span style={{ minWidth: 0 }}>
          <Link href={appHref(`/programs/${card.slug}`)} style={{ display: "block", fontWeight: 600, lineHeight: 1.25 }}>
            {card.name}
          </Link>
          <span className="nvr-meta" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {[card.typeLabel, card.organization].filter(Boolean).join(" · ")}
          </span>
        </span>
      </div>
      <span className="nvr-line" data-hot={card.hot ? "" : undefined} style={{ fontSize: 13.5, color: card.hot ? undefined : "var(--nv-ink-2)" }}>
        {card.line}
      </span>
      {card.startByLine ? (
        <span className="nvr-meta" style={{ color: card.startByLate ? "var(--nv-bad)" : undefined }}>
          {card.startByLine}
        </span>
      ) : null}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <label htmlFor={selectId} className="nvr-sr">
          Move {card.name} to
        </label>
        <select
          id={selectId}
          className="nvr-select"
          value={card.status}
          onChange={(e) => actions.move(card, e.currentTarget.value as TrackerStatus)}
        >
          {TRACKER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s === card.status ? `In ${TRACKER_STATUS_LABELS[s]}` : `Move to ${TRACKER_STATUS_LABELS[s]}`}
            </option>
          ))}
        </select>
        <Link href={appHref(`/readiness/${card.programCycleId}?program=${encodeURIComponent(card.slug)}`)} className="nvr-mini">
          Readiness
        </Link>
        <button type="button" className="nvr-mini" onClick={() => actions.remove(card)} aria-label={`Stop tracking ${card.name}`}>
          <Icon name="trash" />
        </button>
      </div>

      {actions.outcome(card)}

      {card.status === "interested" || card.status === "applying" ? (
        <details>
          <summary className="nvr-meta" style={{ cursor: "pointer" }}>
            {card.ownCampusDeadline ? "Edit your campus deadline" : "Add your campus deadline"}
          </summary>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
            <label htmlFor={dateId} className="nvr-meta">
              Campus date (private to you)
            </label>
            <input
              id={dateId}
              type="date"
              className="nvr-input"
              defaultValue={card.ownCampusDeadline ?? ""}
              onBlur={(e) => {
                const v = e.currentTarget.value || null;
                if (v !== card.ownCampusDeadline) actions.setCampusDate(card, v);
              }}
            />
          </div>
        </details>
      ) : null}
    </li>
  );
}

function Column({ column, actions, draggingId, onDragState }: { column: TrackerColumn; actions: CardActions; draggingId: string | null; onDragState: (id: string | null) => void }) {
  const headingId = useId();
  const [over, setOver] = useState(false);
  const findCard = (id: string) => column.cards.find((c) => c.id === id);

  return (
    <Glass
      as="section"
      className="nvr-col"
      aria-labelledby={headingId}
      data-drop-target={over ? "" : undefined}
      onDragOver={(e: DragEvent<HTMLElement>) => {
        if (!draggingId || findCard(draggingId)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        setOver(false);
        const id = e.dataTransfer.getData(DRAG_TYPE);
        if (id) actions.move({ id } as TrackerCardView, column.status);
      }}
    >
      <div className="nvr-col-head">
        <h2 id={headingId} style={{ fontSize: 16, fontWeight: 600 }}>
          {column.label}
        </h2>
        <DotNumber value={column.cards.length} spoken={`${column.cards.length} ${column.cards.length === 1 ? "program" : "programs"}`} />
      </div>
      {column.cards.length === 0 ? (
        <p className="nvr-meta" style={{ padding: "4px 6px" }}>
          Nothing here yet.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {column.cards.map((c) => (
            <TrackerCard key={c.id} card={c} actions={actions} onDragState={onDragState} />
          ))}
        </ul>
      )}
    </Glass>
  );
}

export default function TrackerPage() {
  const viewer = useViewer();
  const headingId = useId();
  const tracker = useTracker();
  const cards = useReleaseCards();
  const update = useUpdateTrackerItem();
  const untrack = useUntrackProgram();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");

  const columns = useMemo(
    () => (tracker.data ? groupTracker(tracker.data.data, cards.data?.data ?? new Map(), viewer.now, viewer.tz) : []),
    [tracker.data, cards.data, viewer.now, viewer.tz],
  );
  const summary = trackerSummary(columns);
  const trackerItems = tracker.data?.data;
  const allCards = columns.flatMap((c) => c.cards);

  const actions: CardActions = {
    move(partial, to) {
      const card = allCards.find((c) => c.id === partial.id);
      if (!card || card.status === to) return;
      update.mutate(
        { id: card.id, patch: movePatch(card, to, viewer.today) },
        {
          onSuccess: () => setNotice(`${card.name} moved to ${TRACKER_STATUS_LABELS[to]}.`),
          onError: (err) =>
            setNotice(
              err instanceof ApiError && err.code === "version_conflict"
                ? `${card.name} changed somewhere else; the board has been refreshed.`
                : `Could not move ${card.name}. Try again.`,
            ),
        },
      );
    },
    remove(card) {
      untrack.mutate(card.id, {
        onSuccess: () => setNotice(`Stopped tracking ${card.name}.`),
        onError: () => setNotice(`Could not remove ${card.name}. Try again.`),
      });
    },
    outcome(card) {
      if (card.status !== "submitted" && card.status !== "decided") return null;
      const item = trackerItems?.find((i) => i.id === card.id);
      if (!item) return null;
      // Unknown card (still loading, or failed) renders nothing: it might be status-defined.
      const programCard = cards.data?.data.get(card.slug);
      if (!programCard) return null;
      return <TrackedOutcome item={item} card={programCard} slug={card.slug} today={viewer.today} />;
    },
    setCampusDate(card, date) {
      update.mutate(
        { id: card.id, patch: { ownCampusDeadline: date, version: card.version } },
        {
          onSuccess: () => setNotice(date ? `Campus deadline saved for ${card.name}.` : `Campus deadline cleared for ${card.name}.`),
          onError: () => setNotice(`Could not save the campus deadline for ${card.name}.`),
        },
      );
    },
  };

  const signedOut = tracker.error instanceof ApiError && tracker.error.status === 401;
  const sample = Boolean(tracker.data?.sample || cards.data?.sample);

  return (
    <NvPage labelledBy={headingId}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 22 }}>
        <div>
          <h1 id={headingId} className="nvr-h1">
            Tracker
          </h1>
          {tracker.data ? (
            <p className="nvr-meta" style={{ marginTop: 6 }}>
              {summary.tracked} {summary.tracked === 1 ? "program" : "programs"} · {summary.dueSoon} {summary.dueSoon === 1 ? "deadline" : "deadlines"} in the
              next 30 days
            </p>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <LookToggle />
          <Link href={appHref("/explore")} className="nvr-btn">
            <Icon name="plus" />
            Add a program
          </Link>
        </div>
      </div>

      <SampleBanner show={sample} />

      {tracker.isLoading ? <Skeleton height={420} label="Loading your Tracker" /> : null}
      {signedOut ? (
        <SignInPrompt
          title="Sign in to see your Tracker."
          detail="Your tracked programs, campus dates and reminders are saved to your account."
          next={appPaths.tracker}
        />
      ) : tracker.isError ? (
        <ErrorBanner title="Your Tracker could not load." onRetry={() => void tracker.refetch()} />
      ) : null}
      {cards.isError ? <p className="nvr-meta" style={{ marginBottom: 12 }}>Program details could not load, so some cards show only their name.</p> : null}

      {tracker.data ? (
        summary.tracked === 0 ? (
          <Glass className="nvr-panel" style={{ alignItems: "flex-start", gap: 12 }}>
            <h2 className="nvr-h2">Nothing tracked yet</h2>
            <p className="nvr-body">Track a program from Explore or its page, and its deadlines and start-by dates land here.</p>
            <Link href={appHref("/explore")} className="nvr-btn-go">
              Find programs
            </Link>
          </Glass>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2" style={{ marginBottom: 16, maxWidth: 560 }}>
              <StatTile label="Tracking" value={summary.tracked} spoken={`${summary.tracked} tracked`} />
              <StatTile label="Due in 30 days" value={summary.dueSoon} spoken={`${summary.dueSoon} due in the next 30 days`} />
              <StatTile label="Submitted" value={summary.submitted} spoken={`${summary.submitted} submitted`} />
            </div>
            <div className="nvr-board" role="group" aria-label="Tracker board" tabIndex={-1}>
              {columns.map((col) => (
                <Column key={col.status} column={col} actions={actions} draggingId={draggingId} onDragState={setDraggingId} />
              ))}
            </div>
            <p className="nvr-meta" style={{ marginTop: 10 }}>
              Use each card's menu to move it, or drag it to another column.
            </p>
          </>
        )
      ) : null}
      <p className="nvr-sr" role="status" aria-live="polite">
        {notice}
      </p>
    </NvPage>
  );
}
