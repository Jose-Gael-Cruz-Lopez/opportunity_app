import { getDb } from "@server/db/client";
import { createCalRoutes, type CalDeps } from "./routes";
import { createD1CalStore } from "./store";

/**
 * Calendar feeds mounted at /cal by server/app.ts. See ./routes.ts for the HTTP contract and
 * ./events.ts for the frozen event rules (UIDs, SEQUENCE, start forms, neutral text).
 */

export { createCalRoutes, PROGRAM_FEED_CACHE, USER_FEED_CACHE, type CalDeps } from "./routes";
export { createD1CalStore, feedAllows, type CalStore, type FeedGroup, type ProgramFeed, type ProgramFeedLookup, type UserFeed } from "./store";
export { groupEvents, renderProgramFeed, renderUserFeed } from "./feeds";
export { deadlineEvent, deadlineStart, isNeutral, ownCampusEvent, type DeadlineEventSource, type ProgramEventContext } from "./events";
export { escapeText, foldLine, renderCalendar, ICS_CONTENT_TYPE, type IcsCalendar, type IcsEvent, type IcsStart } from "./ics";
export { eventUid, NOVUS_ICS_NAMESPACE, UID_NAMES, uuidv5 } from "./uid";
export { calendarTokenHash, isCalendarToken, newCalendarToken, userFeedPath } from "./token";

export const calDeps: CalDeps = {
  store: (c) => createD1CalStore(getDb(c.env.DB)),
  now: () => Date.now(),
  origin: (c) => c.env.APP_ORIGIN,
};

export const calRoutes = createCalRoutes(calDeps);
