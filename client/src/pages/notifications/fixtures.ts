import type { InboxItem, NotificationPrefs } from "@shared/contracts/events";

/**
 * SAMPLE DATA for the notification center when no API answers (development only; never in a
 * production build, see lib/data-source.ts). Every program named here is invented and labelled.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;

function sampleId(n: number): string {
  return `0190a0a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
}

export function sampleNotifications(now: number = Date.now()): InboxItem[] {
  const at = (ms: number) => new Date(now - ms).toISOString();
  return [
    {
      id: sampleId(701),
      type: "deadline.reminder",
      priority: "p1",
      title: "Due in 2 days: Sample Job Shadow Week (Winter 2026) [sample listing]",
      body: "Sample data. Deadline: 23 Nov 2026, time not stated: plan to submit by 22 Nov 2026.",
      href: "/programs/sample-job-shadow-week",
      readAt: null,
      createdAt: at(2 * HOUR),
    },
    {
      id: sampleId(702),
      type: "deadline.changed",
      priority: "p0",
      title: "Deadline changed: Sample Summer Research Fellowship (Summer 2027) [sample listing]",
      body: "Sample data. The deadline is now earlier. Confirm on the official page.",
      href: "/programs/sample-summer-research-fellowship",
      readAt: null,
      createdAt: at(26 * HOUR),
    },
    {
      id: sampleId(703),
      type: "deadline.reminder",
      priority: "p2",
      title: "Your week ahead: 3 dates in the next two weeks",
      body: "Sample data. A weekly list of start-by dates and deadlines.",
      href: "/app/tracker",
      readAt: at(2 * DAY),
      createdAt: at(3 * DAY),
    },
    {
      id: sampleId(704),
      type: "eligibility.changed",
      priority: "p1",
      title: "An update to a program you saved [sample listing]",
      body: "Sample data. Open Novus to see what changed.",
      href: "/app/tracker",
      readAt: at(9 * DAY),
      createdAt: at(10 * DAY),
    },
  ];
}

export const DEFAULT_SAMPLE_PREFS: NotificationPrefs = {
  weeklyEmail: true,
  weeklyDay: null,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  examPauseUntil: null,
  channels: { email: true, inApp: true, push: false },
};
