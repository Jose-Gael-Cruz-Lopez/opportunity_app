import type { InboxItem, NotificationPrefs } from "@shared/contracts/events";

/**
 * Notification center model (s01 F-08 P2): pure helpers the page renders from. Items are the
 * student's own Alerts (change alerts, reminders, the weekly email's record), newest first. No
 * score, count of "matches" or engagement number is derived here; only unread counts.
 */

export type NotificationFilter = "all" | "unread" | "reminders" | "changes";

export const FILTERS: readonly { readonly id: NotificationFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "reminders", label: "Reminders" },
  { id: "changes", label: "Changes" },
];

export type NotificationCategory = "reminder" | "change" | "account";

const REMINDER_TYPES: ReadonlySet<string> = new Set(["deadline.reminder", "cycle.predicted_soon", "roadmap.replanned"]);
const ACCOUNT_TYPES: ReadonlySet<string> = new Set(["account.notice", "contact.confirmation", "curator.note", "advisor.list_item", "profile.newly_eligible"]);

export function categoryOf(type: InboxItem["type"]): NotificationCategory {
  if (REMINDER_TYPES.has(type)) return "reminder";
  if (ACCOUNT_TYPES.has(type)) return "account";
  return "change";
}

export const CATEGORY_LABELS: Record<NotificationCategory, string> = { reminder: "Reminder", change: "Change", account: "Notice" };

export function applyFilter(items: readonly InboxItem[], filter: NotificationFilter): InboxItem[] {
  switch (filter) {
    case "unread":
      return items.filter((i) => i.readAt === null);
    case "reminders":
      return items.filter((i) => categoryOf(i.type) === "reminder");
    case "changes":
      return items.filter((i) => categoryOf(i.type) === "change");
    default:
      return [...items];
  }
}

export function unreadIds(items: readonly InboxItem[]): string[] {
  return items.filter((i) => i.readAt === null).map((i) => i.id);
}

/** In-app routes an Alert may link to (relative to /app). Anything else gets no link. */
const IN_APP_PREFIXES = ["/programs/", "/tracker", "/roadmap", "/settings", "/readiness/", "/explore"] as const;

/**
 * Turns an Alert's href into an in-app path: `/app/tracker` -> `/tracker`, and public program
 * pages `/programs/{slug}` open the in-app program page. Email-only links (`/e/...`), other sites
 * and unknown paths return null, so the center never sends a student somewhere unexpected.
 */
export function inAppPath(href: string | null): string | null {
  if (!href || !href.startsWith("/") || href.startsWith("//")) return null;
  const path = href.startsWith("/app/") ? href.slice(4) : href === "/app" ? "/" : href;
  const allowed = IN_APP_PREFIXES.some((p) =>
    p.endsWith("/") ? path.length > p.length && path.startsWith(p) : path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`),
  );
  return allowed ? path : null;
}

export type AgeGroup = "Today" | "This week" | "Earlier";

function localDay(ms: number, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** Groups items by when they arrived, in the viewer's zone; groups keep the newest-first order. */
export function groupByAge(items: readonly InboxItem[], now: number, timeZone?: string): { group: AgeGroup; items: InboxItem[] }[] {
  const today = localDay(now, timeZone);
  const groups: Record<AgeGroup, InboxItem[]> = { Today: [], "This week": [], Earlier: [] };
  for (const item of items) {
    const at = Date.parse(item.createdAt);
    if (!Number.isFinite(at)) continue;
    if (localDay(at, timeZone) === today) groups.Today.push(item);
    else if (now - at < 7 * 86_400_000) groups["This week"].push(item);
    else groups.Earlier.push(item);
  }
  return (["Today", "This week", "Earlier"] as const).filter((g) => groups[g].length > 0).map((g) => ({ group: g, items: groups[g] }));
}

/** "Urgent" only for P0 items; other priorities carry no label (no color-only status). */
export function priorityLabel(item: Pick<InboxItem, "priority">): string | null {
  return item.priority === "p0" ? "Urgent" : null;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

function clock(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Plain lines describing what the student will receive, from their preferences. */
export function prefsSummary(prefs: NotificationPrefs): string[] {
  if (!prefs.channels.email) return ["Email is off. Reminders and changes still appear here."];
  const lines = [
    prefs.weeklyEmail
      ? `Weekly email: ${prefs.weeklyDay ? `${WEEKDAYS[prefs.weeklyDay - 1]}s` : "one day a week (Novus spreads days out)"} at 6:00 PM, listing every date in the next two weeks.`
      : "Weekly email: off.",
    "Reminder emails: 2 days before each deadline, at 9:00 AM.",
    `Quiet hours: ${clock(prefs.quietHoursStart)} to ${clock(prefs.quietHoursEnd)}. Only deadlines under 72 hours away can break them.`,
  ];
  if (prefs.examPauseUntil) lines.push(`Exam pause until ${prefs.examPauseUntil}: only urgent alerts and 2-day reminders arrive.`);
  return lines;
}

/** Sets (or clears, with null) `readAt` on the given ids; items already in that state keep theirs. */
export function withReadAt<T extends { items: InboxItem[] }>(pages: readonly T[], ids: ReadonlySet<string>, readAt: string | null): T[] {
  return pages.map((p) => ({
    ...p,
    items: p.items.map((i) => {
      if (!ids.has(i.id)) return i;
      if (readAt === null) return i.readAt === null ? i : { ...i, readAt: null };
      return i.readAt === null ? { ...i, readAt } : i;
    }),
  }));
}

/**
 * Marks every id read, one request each, and reports which ones failed. Never rejects: a
 * failure on one item does not stop or undo the others.
 */
export async function markEachRead(ids: readonly string[], markOne: (id: string) => Promise<unknown>): Promise<{ done: string[]; failed: string[] }> {
  const results = await Promise.allSettled(ids.map((id) => markOne(id)));
  const done: string[] = [];
  const failed: string[] = [];
  results.forEach((r, n) => (r.status === "fulfilled" ? done : failed).push(ids[n]!));
  return { done, failed };
}

/** What "Mark all read" says once every request has settled: the real count, never a guess. */
export function markAllNotice(total: number, failed: number): string {
  const done = total - failed;
  if (failed === 0) return done === 1 ? "1 notification marked read." : `${done} notifications marked read.`;
  if (done === 0) return "Could not mark your notifications read. Try again.";
  return `${done} of ${total} marked read. Try again for the rest.`;
}
