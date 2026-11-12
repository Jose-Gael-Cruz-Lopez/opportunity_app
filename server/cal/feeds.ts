import { deadlineEvent, ownCampusEvent, sortEvents } from "./events";
import { renderCalendar, type IcsEvent } from "./ics";
import type { FeedGroup, ProgramFeed, UserFeed } from "./store";

/**
 * Feed assembly: rows from the store become events, then one VCALENDAR. Pure, so the route
 * tests and golden tests run without a database.
 */

/** Calendar clients poll at their own pace; this is only a hint (RFC 7986 REFRESH-INTERVAL). */
export const PROGRAM_FEED_REFRESH_HOURS = 6;
export const USER_FEED_REFRESH_HOURS = 3;

export function groupEvents(groups: readonly FeedGroup[], origin: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  for (const group of groups) {
    const opts = { origin, neutral: group.neutral };
    for (const d of group.deadlines) {
      const event = deadlineEvent(d, group.context, opts);
      if (event) events.push(event);
    }
    if (group.ownCampus) {
      const own = ownCampusEvent(group.ownCampus, group.context, opts);
      if (own) events.push(own);
    }
  }
  return sortEvents(events);
}

export function renderProgramFeed(feed: ProgramFeed, origin: string): string {
  const sample = feed.isSample ? " Sample data, not a real program." : "";
  return renderCalendar({
    name: `Novus: ${feed.programName}`,
    description: `Official deadlines for ${feed.programName}, as recorded by Novus.${sample} Always confirm dates on the official page.`,
    refreshHours: PROGRAM_FEED_REFRESH_HOURS,
    events: groupEvents(feed.groups, origin),
  });
}

/** The calendar name never names a program, so it is safe in any calendar list. */
export function renderUserFeed(feed: UserFeed, origin: string): string {
  return renderCalendar({
    name: "Novus: my deadlines",
    description: "Deadlines you track in Novus. Always confirm dates on the official page.",
    refreshHours: USER_FEED_REFRESH_HOURS,
    events: groupEvents(feed.groups, origin),
  });
}
