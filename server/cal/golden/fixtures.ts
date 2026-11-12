import type { DeadlineEventSource, ProgramEventContext } from "../events";
import type { ProgramFeed } from "../store";

/**
 * TEST ONLY. Synthetic deadlines for the ICS golden files: one per start form (fixed UTC,
 * date-only, applicant-local floating) plus a withdrawn row, a predicted window and a month-only
 * row that must emit nothing. Every name is invented and every URL is on example.org.
 */

export const GOLDEN_ORIGIN = "https://novus.example.org";

/** 2026-12-01T12:00:00Z: the record's last change, used for DTSTAMP. */
const UPDATED = Date.UTC(2026, 11, 1, 12, 0, 0);

export const GOLDEN_PROGRAM: ProgramEventContext = {
  slug: "sample-national-stem-scholarship",
  name: "Sample National STEM Scholarship",
  organizationName: "Example Science Foundation",
  officialUrl: "https://example.org/stem-scholarship",
  verifiedOn: "2026-11-05",
  verifiedBy: "curator-ada",
  isSample: true,
};

const base: Omit<DeadlineEventSource, "id" | "precision" | "localDate" | "localTime" | "timeZone" | "dueAt" | "tzMode"> = {
  kind: "application",
  scope: "national",
  roundLabel: "",
  basis: "official",
  windowStart: null,
  windowEnd: null,
  revision: 1,
  verificationState: "verified",
  withdrawnAt: null,
  updatedAt: UPDATED,
};

/** 29 Jan 2027, 6:00 pm America/New_York = 23:00 UTC. */
export const FIXED_EXACT: DeadlineEventSource = {
  ...base,
  id: "0193a000-0000-7000-8000-000000000001",
  precision: "exact",
  tzMode: "fixed",
  localDate: "2027-01-29",
  localTime: "18:00",
  timeZone: "America/New_York",
  dueAt: Date.UTC(2027, 0, 29, 23, 0, 0),
};

/** End of 15 Feb 2027 in America/Chicago; written as an all-day event. */
export const DATE_ONLY: DeadlineEventSource = {
  ...base,
  id: "0193a000-0000-7000-8000-000000000002",
  kind: "recommendation",
  precision: "date_only",
  tzMode: "fixed",
  localDate: "2027-02-15",
  localTime: null,
  timeZone: "America/Chicago",
  dueAt: Date.UTC(2027, 1, 16, 5, 59, 59, 999),
};

/** "11:59 pm, your time zone" on 2 Feb 2027: floating time, no zone. */
export const APPLICANT_LOCAL: DeadlineEventSource = {
  ...base,
  id: "0193a000-0000-7000-8000-000000000003",
  kind: "priority_round",
  roundLabel: "Early round",
  precision: "exact",
  tzMode: "applicant_local",
  localDate: "2027-02-02",
  localTime: "23:59",
  timeZone: null,
  dueAt: null,
  verificationState: "unverified",
};

/** Withdrawn after two revisions: CANCELLED, same UID, SEQUENCE 3. */
export const WITHDRAWN: DeadlineEventSource = {
  ...FIXED_EXACT,
  id: "0193a000-0000-7000-8000-000000000004",
  kind: "interest_form",
  localDate: "2026-12-10",
  dueAt: Date.UTC(2026, 11, 10, 23, 0, 0),
  revision: 3,
  withdrawnAt: Date.UTC(2026, 11, 2, 9, 0, 0),
  updatedAt: Date.UTC(2026, 11, 2, 9, 0, 0),
};

/** A predicted window: tentative, on the window's first day. */
export const PREDICTED_WINDOW: DeadlineEventSource = {
  ...base,
  id: "0193a000-0000-7000-8000-000000000005",
  basis: "predicted",
  precision: "window",
  tzMode: "fixed",
  localDate: "2027-09-20",
  localTime: null,
  windowStart: "2027-09-10",
  windowEnd: "2027-09-30",
  timeZone: null,
  dueAt: null,
  verificationState: "unverified",
};

/** Month-only: no single day, so no event. */
export const MONTH_ONLY: DeadlineEventSource = {
  ...base,
  id: "0193a000-0000-7000-8000-000000000006",
  precision: "month_only",
  tzMode: "fixed",
  localDate: "2027-03",
  localTime: null,
  timeZone: null,
  dueAt: null,
};

export function goldenFeed(deadlines: readonly DeadlineEventSource[]): ProgramFeed {
  return {
    kind: "feed",
    slug: GOLDEN_PROGRAM.slug,
    programName: GOLDEN_PROGRAM.name,
    isSample: true,
    groups: [{ context: GOLDEN_PROGRAM, neutral: false, deadlines, ownCampus: null }],
  };
}
