/**
 * Notification center (/app/notifications; s01 F-08 P2): the student's own reminders, change
 * alerts and weekly-email records, newest first, grouped by when they arrived, with filters,
 * per-item and all-at-once "mark read", and a plain summary of what Novus will send and when.
 * No feed ranking, streaks or engagement numbers: an unread count is the only number shown.
 */
import { useId, useMemo, useRef, useState, type MouseEvent, type RefObject } from "react";
import { Link } from "wouter";
import { ApiError } from "@/components/readiness/api-client";
import { ErrorBanner, Glass, Icon, NvPage, SampleBanner, SignInPrompt, Skeleton, appHref, type IconName } from "@/components/readiness/primitives";
import { useViewer } from "@/components/readiness/viewer";
import { formatAgo } from "@/lib/format";
import type { InboxItem } from "@shared/contracts/events";
import { useMarkAllRead, useMarkRead, useNotificationPages, useNotificationPrefs } from "./data";
import { applyFilter, CATEGORY_LABELS, categoryOf, FILTERS, groupByAge, inAppPath, markAllNotice, prefsSummary, priorityLabel, unreadIds, type NotificationFilter } from "./model";

const CATEGORY_ICON: Record<ReturnType<typeof categoryOf>, IconName> = { reminder: "cal", change: "flag", account: "info" };

/**
 * "Mark read" disappears once the item is read, so before it goes, focus moves to the row's
 * link, else the next unread row's button, else `fallback` (the page heading).
 */
function focusAfterRead(button: HTMLButtonElement, fallback: HTMLElement | null): void {
  const row = button.closest("li");
  const link = row?.querySelector<HTMLElement>(".nvr-link");
  if (link) return link.focus();
  const buttons = Array.from(button.ownerDocument.querySelectorAll<HTMLButtonElement>("button[data-mark-read]"));
  const next = buttons[buttons.indexOf(button) + 1] ?? buttons[buttons.indexOf(button) - 1];
  (next ?? fallback)?.focus();
}

function NotificationRow({
  item,
  now,
  onRead,
  busy,
  headingRef,
}: {
  item: InboxItem;
  now: number;
  onRead: (item: InboxItem) => void;
  busy: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  const category = categoryOf(item.type);
  const path = inAppPath(item.href);
  const unread = item.readAt === null;
  const urgent = priorityLabel(item);
  const title = (
    <span style={{ fontWeight: unread ? 700 : 500, display: "block", lineHeight: 1.3 }}>
      {unread ? <span className="nvr-sr">Unread: </span> : null}
      {item.title}
    </span>
  );
  return (
    <li className="nvr-row" data-unread={unread ? "" : undefined}>
      <span className="nvr-mk" aria-hidden="true" data-verdict={unread ? "unknown" : "met"}>
        <Icon name={CATEGORY_ICON[category]} />
      </span>
      <div style={{ minWidth: 0 }}>
        {path ? (
          <Link href={appHref(path)} onClick={() => unread && onRead(item)} className="nvr-link">
            {title}
          </Link>
        ) : (
          title
        )}
        <p className="nvr-body" style={{ fontSize: 14, margin: "4px 0 0", whiteSpace: "pre-line" }}>
          {item.body}
        </p>
        <small>
          {CATEGORY_LABELS[category]} · {formatAgo(item.createdAt, now)}
        </small>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
          {urgent ? (
            <span className="nvr-tag" data-tone="soon">
              <i className="nvr-led" aria-hidden="true" />
              {urgent}
            </span>
          ) : null}
          {unread ? (
            <span className="nvr-tag" data-ghost="">
              New
            </span>
          ) : null}
        </div>
      </div>
      <div>
        {unread ? (
          <button
            type="button"
            className="nvr-mini"
            data-mark-read=""
            aria-label={`Mark read: ${item.title}`}
            onClick={(e: MouseEvent<HTMLButtonElement>) => {
              focusAfterRead(e.currentTarget, headingRef.current);
              onRead(item);
            }}
            disabled={busy}
          >
            <Icon name="check" />
            Mark read
          </button>
        ) : null}
      </div>
    </li>
  );
}

export default function NotificationsPage() {
  const headingId = useId();
  const viewer = useViewer();
  const enabled = viewer.signedIn !== false;
  const pages = useNotificationPages(enabled);
  const prefs = useNotificationPrefs(enabled);
  const markRead = useMarkRead();
  const markAll = useMarkAllRead();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [filter, setFilter] = useState<NotificationFilter>("all");
  const [notice, setNotice] = useState("");

  const items = useMemo(() => pages.data?.pages.flatMap((p) => p.items) ?? [], [pages.data]);
  const sample = Boolean(pages.data?.pages.some((p) => p.sample) || prefs.data?.source === "sample");
  const unread = unreadIds(items);
  const shown = applyFilter(items, filter);
  const groups = groupByAge(shown, viewer.now, viewer.tz);
  const signedOut = viewer.signedIn === false || (pages.error instanceof ApiError && pages.error.status === 401);

  const read = (item: InboxItem) =>
    markRead.mutate({ id: item.id, sample }, { onError: () => setNotice(`Could not mark "${item.title}" as read. Try again.`) });
  // One optimistic update, one request per item; the notice waits for every request and says
  // how many really saved. The button unmounts when nothing is left unread, so focus goes to
  // the heading.
  const readAll = async () => {
    const ids = [...unread];
    if (!ids.length) return;
    setNotice("Marking read…");
    headingRef.current?.focus();
    try {
      const { failed } = await markAll.mutateAsync({ ids, sample });
      setNotice(markAllNotice(ids.length, failed.length));
    } catch {
      setNotice(markAllNotice(ids.length, ids.length));
    }
  };

  return (
    <NvPage labelledBy={headingId}>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap", marginBottom: 18 }}>
        <div>
          <h1 id={headingId} className="nvr-h1" ref={headingRef} tabIndex={-1}>
            Notifications
          </h1>
          {pages.data ? (
            <p className="nvr-meta" style={{ marginTop: 6 }}>
              {unread.length === 0 ? "You're all caught up." : `${unread.length} unread`}
            </p>
          ) : null}
        </div>
        {pages.data && unread.length > 0 ? (
          <button type="button" className="nvr-btn" onClick={() => void readAll()} disabled={markAll.isPending}>
            <Icon name="check" />
            Mark all read
          </button>
        ) : null}
      </div>

      <SampleBanner show={sample} />

      {signedOut ? (
        <SignInPrompt title="Sign in to see your notifications." detail="Reminders and changes to programs you follow are saved to your account." next="/notifications" />
      ) : (
        <div style={{ display: "grid", gap: 18, gridTemplateColumns: "minmax(0, 1fr)" }} className="lg:grid-cols-[minmax(0,1fr)_320px]">
          <div style={{ minWidth: 0 }}>
            <div className="nvr-opts" role="group" aria-label="Show" style={{ marginBottom: 14 }}>
              {FILTERS.map((f) => (
                <button key={f.id} type="button" className="nvr-mini" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                  {f.label}
                </button>
              ))}
            </div>

            {pages.isLoading ? <Skeleton height={320} label="Loading notifications" /> : null}
            {pages.isError && !signedOut ? <ErrorBanner title="Your notifications could not load." onRetry={() => void pages.refetch()} /> : null}

            {pages.data && shown.length === 0 ? (
              <Glass className="nvr-panel" style={{ alignItems: "flex-start", gap: 10 }}>
                <h2 className="nvr-h2">{filter === "all" ? "Nothing here yet" : "Nothing in this view"}</h2>
                <p className="nvr-body">
                  {filter === "all"
                    ? "Track a program or ask for reminders, and its deadline reminders and changes show up here."
                    : "Try another filter to see older or read notifications."}
                </p>
                {filter === "all" ? (
                  <Link href={appHref("/explore")} className="nvr-btn-go">
                    Find programs
                  </Link>
                ) : null}
              </Glass>
            ) : null}

            {groups.map((g) => (
              <section key={g.group} aria-label={g.group} style={{ marginBottom: 18 }}>
                <h2 className="nvr-label" style={{ margin: "6px 0 0" }}>
                  {g.group}
                </h2>
                <ul className="nvr-rows">
                  {g.items.map((item) => (
                    <NotificationRow key={item.id} item={item} now={viewer.now} onRead={read} busy={markAll.isPending} headingRef={headingRef} />
                  ))}
                </ul>
              </section>
            ))}

            {pages.hasNextPage ? (
              <button type="button" className="nvr-btn" onClick={() => void pages.fetchNextPage()} disabled={pages.isFetchingNextPage}>
                {pages.isFetchingNextPage ? "Loading…" : "Show older notifications"}
              </button>
            ) : null}
          </div>

          <Glass as="aside" className="nvr-panel" aria-labelledby={`${headingId}-prefs`} style={{ gap: 10, alignSelf: "start" }}>
            <h2 id={`${headingId}-prefs`} className="nvr-h3">
              What Novus sends you
            </h2>
            {prefs.data ? (
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {prefsSummary(prefs.data.data).map((line) => (
                  <li key={line} className="nvr-body" style={{ fontSize: 14 }}>
                    {line}
                  </li>
                ))}
              </ul>
            ) : prefs.isLoading ? (
              <Skeleton height={90} label="Loading your email settings" />
            ) : (
              <p className="nvr-meta">Your email settings could not load.</p>
            )}
            <p className="nvr-meta">Every email has a one-click unsubscribe link. Always confirm dates on the program's official page.</p>
            <Link href={appHref("/settings")} className="nvr-mini" style={{ alignSelf: "flex-start" }}>
              Change email settings
            </Link>
          </Glass>
        </div>
      )}
      <p className="nvr-sr" role="status" aria-live="polite">
        {notice}
      </p>
    </NvPage>
  );
}
