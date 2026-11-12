import { describe, expect, it } from "vitest";
import type { Deadline, Requirement } from "@shared/contracts";
import { isoWeekday } from "@shared/time/iso";
import { localDateIn, localTimeIn } from "@shared/time/zones";
import { planCycleReminders, planStepReminder, type CycleInfo, type FollowedCycle, type RecipientContext } from "./plan";
import {
  avoidQuietHours,
  isoWeekKey,
  mergesIntoWeekly,
  reminderDue,
  scheduledInstant,
  spreadWeekday,
  weeklyDateFor,
  weeklyWindowOpen,
  type WeeklySettings,
} from "./policy";
import { collectWeekly, isEmptyWeekly, renderWeekly } from "./weekly";

// Pure tests: the clock, the zone and every registry fact are inputs. All programs are samples.

const HOUR = 3_600_000;
const QUIET: [string, string] = ["22:00", "08:00"];
const ID = "0190a0a0-0000-7000-8000-000000000001";

function deadline(over: Partial<Deadline> & Pick<Deadline, "id" | "localDate">): Deadline {
  return {
    programCycleId: "cycle-1",
    kind: "application",
    scope: "national",
    institutionId: null,
    roundLabel: null,
    basis: "official",
    precision: "date_only",
    tzMode: "fixed",
    localTime: null,
    windowStart: null,
    windowEnd: null,
    timeZone: "America/Chicago",
    tzSource: "stated",
    dueAt: null,
    sortAt: null,
    revision: 1,
    verificationState: "verified",
    withdrawnAt: null,
    ...over,
  } as Deadline;
}

function info(over: Partial<CycleInfo> = {}): CycleInfo {
  return {
    cycleId: "cycle-1",
    programName: "Sample Job Shadow Week",
    programSlug: "sample-job-shadow-week",
    termLabel: "Winter 2026",
    officialUrl: "https://example.org/sample",
    sensitiveAudience: false,
    identityAudience: [],
    isSample: true,
    deadlines: [deadline({ id: "d-1", localDate: "2026-11-23" })],
    requirements: [],
    campusLead: null,
    ...over,
  };
}

function weekly(over: Partial<WeeklySettings> = {}): WeeklySettings {
  return { recipientKey: `u:${ID}`, zone: "America/Chicago", weeklyEmail: true, weeklyDay: 1, quiet: QUIET, examPauseUntil: null, ...over };
}

function recipient(over: Partial<RecipientContext> = {}, weeklyOver: Partial<WeeklySettings> = {}): RecipientContext {
  const zone = over.zone === undefined ? "America/Chicago" : over.zone;
  return {
    recipientKey: `u:${ID}`,
    userId: ID,
    contactId: null,
    zone,
    institutionId: null,
    quiet: QUIET,
    weekly: weekly({ zone, ...weeklyOver }),
    ...over,
  };
}

const followed: FollowedCycle = { cycleId: "cycle-1", trackerItemId: "t-1", ownCampusDeadline: null, nameInMessages: true, followedAt: Date.UTC(2026, 10, 1) };

// 2026-11-21 is a Saturday; 09:00 CST = 15:00 UTC.
const T2_AT = Date.UTC(2026, 10, 21, 15, 0);

describe("timing policy", () => {
  it("moves sends out of quiet hours earlier, never later", () => {
    expect(avoidQuietHours("09:00", QUIET)).toEqual({ time: "09:00", dayShift: 0 });
    expect(avoidQuietHours("23:00", QUIET)).toEqual({ time: "21:30", dayShift: 0 });
    expect(avoidQuietHours("07:00", QUIET)).toEqual({ time: "21:30", dayShift: -1 });
    expect(avoidQuietHours("09:00", ["06:00", "10:00"])).toEqual({ time: "05:30", dayShift: 0 });
    expect(avoidQuietHours("00:30", ["00:15", "07:00"])).toEqual({ time: "23:45", dayShift: -1 });
  });

  it("uses the recipient's zone, and 22:30 UTC when no zone is known", () => {
    expect(scheduledInstant("2026-11-21", "09:00", "America/Chicago", QUIET)).toBe(T2_AT);
    expect(new Date(scheduledInstant("2026-11-21", "09:00", null, QUIET)).toISOString()).toBe("2026-11-21T22:30:00.000Z");
    // Across the DST change (1 Nov 2026 in the US) the wall-clock hour stays 09:00.
    const summer = scheduledInstant("2026-10-30", "09:00", "America/New_York", QUIET);
    expect(localTimeIn(summer, "America/New_York")).toBe("09:00");
    expect(localDateIn(summer, "America/New_York")).toBe("2026-10-30");
  });

  it("spreads weekly days over 1-7 and keeps each id's day stable", () => {
    const days = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const d = spreadWeekday(`0190a0a0-0000-7000-8000-${String(i).padStart(12, "0")}`);
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(7);
      days.add(d);
    }
    expect(days.size).toBe(7);
    expect(spreadWeekday(ID)).toBe(spreadWeekday(ID));
  });

  it("keys weekly emails by ISO week, including the year boundary", () => {
    expect(isoWeekKey("2026-11-11")).toBe("2026-W46");
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
    expect(isoWeekKey("2027-01-04")).toBe("2027-W01");
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01");
  });

  it("opens the weekly window at 18:00 local on the weekly day, closes it at quiet hours", () => {
    const s = weekly({ weeklyDay: 6 });
    expect(weeklyDateFor(s, "2026-11-19")).toBe("2026-11-21");
    expect(weeklyWindowOpen(s, Date.UTC(2026, 10, 21, 23, 30), false)).toBe(false); // 17:30 CST
    expect(weeklyWindowOpen(s, Date.UTC(2026, 10, 22, 0, 30), false)).toBe(true); // 18:30 CST
    expect(weeklyWindowOpen(s, Date.UTC(2026, 10, 22, 4, 30), false)).toBe(false); // 22:30 CST
    expect(weeklyWindowOpen(s, Date.UTC(2026, 10, 21, 15, 5), true)).toBe(true); // 09:05 with a T−2
    expect(weeklyWindowOpen(s, Date.UTC(2026, 10, 20, 0, 30), false)).toBe(false); // another day
  });

  it("merges a T−2 into the weekly email only on that day and never during an exam pause", () => {
    expect(mergesIntoWeekly(weekly({ weeklyDay: 6 }), "2026-11-21")).toBe(true);
    expect(mergesIntoWeekly(weekly({ weeklyDay: 1 }), "2026-11-21")).toBe(false);
    expect(mergesIntoWeekly(weekly({ weeklyDay: 6, weeklyEmail: false }), "2026-11-21")).toBe(false);
    expect(mergesIntoWeekly(weekly({ weeklyDay: 6, examPauseUntil: "2026-11-30" }), "2026-11-21")).toBe(false);
  });

  it("writes reminders within the lookahead, drops stale ones unless they are the last", () => {
    expect(reminderDue(T2_AT, T2_AT - 2 * HOUR, { finalBeforeDeadline: true, deadlineAt: null })).toBe(false);
    expect(reminderDue(T2_AT, T2_AT - 30 * 60_000, { finalBeforeDeadline: true, deadlineAt: null })).toBe(true);
    expect(reminderDue(T2_AT, T2_AT + 30 * HOUR, { finalBeforeDeadline: false, deadlineAt: null })).toBe(false);
    expect(reminderDue(T2_AT, T2_AT + 30 * HOUR, { finalBeforeDeadline: true, deadlineAt: T2_AT + 40 * HOUR })).toBe(true);
    expect(reminderDue(T2_AT, T2_AT + 50 * HOUR, { finalBeforeDeadline: true, deadlineAt: T2_AT + 40 * HOUR })).toBe(false);
  });
});

describe("cycle reminders", () => {
  it("plans T−2 at 09:00 local with the full deadline line and the official link", () => {
    const [draft, ...rest] = planCycleReminders(recipient(), followed, info(), T2_AT - 20 * 60_000);
    expect(rest).toHaveLength(0);
    expect(draft).toMatchObject({ kind: "t2", scheduledFor: T2_AT, dedupeKey: "t2:d-1:2026-11-23", merged: false, neutral: false, href: "/programs/sample-job-shadow-week" });
    expect(draft!.title).toBe("Due in 2 days: Sample Job Shadow Week (Winter 2026) [sample listing]");
    expect(draft!.body).toContain("23 Nov 2026, time not stated: plan to submit by 22 Nov 2026");
    expect(draft!.body).toContain("https://example.org/sample");
  });

  it("is not planned before its time, and not for an item tracked after the send time", () => {
    expect(planCycleReminders(recipient(), followed, info(), T2_AT - 3 * HOUR)).toHaveLength(0);
    expect(planCycleReminders(recipient(), { ...followed, followedAt: T2_AT + HOUR }, info(), T2_AT + 2 * HOUR)).toHaveLength(0);
  });

  it("names no program for status-defined programs or recipients who chose neutral messages", () => {
    for (const [i, f] of [
      [info({ sensitiveAudience: true }), followed],
      [info(), { ...followed, nameInMessages: false }],
    ] as const) {
      const [draft] = planCycleReminders(recipient(), f, i, T2_AT);
      expect(draft?.neutral).toBe(true);
      expect(`${draft?.title} ${draft?.body} ${draft?.href}`).not.toMatch(/Job Shadow|sample-job-shadow|example\.org/);
      expect(draft?.href).toBe("/app/tracker");
    }
  });

  it("formats exact and applicant-local deadlines", () => {
    const exact = info({ deadlines: [deadline({ id: "d-2", localDate: "2026-11-23", precision: "exact", localTime: "17:00", timeZone: "America/New_York", dueAt: "2026-11-23T22:00:00.000Z" })] });
    const [a] = planCycleReminders(recipient(), followed, exact, T2_AT);
    expect(a?.body).toContain("23 Nov 2026, 5:00 PM EST");
    const local = info({ deadlines: [deadline({ id: "d-3", localDate: "2026-11-23", precision: "exact", localTime: "23:59", tzMode: "applicant_local", timeZone: null })] });
    const [b] = planCycleReminders(recipient(), followed, local, T2_AT);
    expect(b?.body).toContain("23 Nov 2026, 11:59 PM your time");
  });

  it("marks a T−2 on the weekly day as merged into the weekly email", () => {
    const [draft] = planCycleReminders(recipient({}, { weeklyDay: isoWeekday("2026-11-21") }), followed, info(), T2_AT);
    expect(draft?.merged).toBe(true);
  });

  it("dates a T−2 that quiet hours moved to the evening before by its send day, for merging and the weekly list", () => {
    const quiet: [string, string] = ["21:00", "10:00"];
    const ctx = recipient({ quiet }, { quiet, weeklyDay: isoWeekday("2026-11-20") });
    const at = Date.UTC(2026, 10, 21, 1, 40); // Fri 19:40 CST
    const [draft] = planCycleReminders(ctx, followed, info(), at);
    expect(localDateIn(draft!.scheduledFor, "America/Chicago")).toBe("2026-11-20");
    expect(localTimeIn(draft!.scheduledFor, "America/Chicago")).toBe("20:30");
    expect(draft).toMatchObject({ localDate: "2026-11-20", merged: true });
    // Saturday as the weekly day no longer claims it: Saturday's email would come after it.
    const [sat] = planCycleReminders(recipient({ quiet }, { quiet, weeklyDay: isoWeekday("2026-11-21") }), followed, info(), at);
    expect(sat).toMatchObject({ localDate: "2026-11-20", merged: false });
  });

  it("uses 22:30 UTC for recipients with no zone", () => {
    const at = Date.UTC(2026, 10, 21, 22, 30);
    const [draft] = planCycleReminders(recipient({ zone: null }), followed, info(), at - 10 * 60_000);
    expect(draft?.scheduledFor).toBe(at);
  });

  it("for nomination-gated cycles, reminds before E1 and once on the day after E1 passes", () => {
    // National nomination deadline 29 Jan 2027: E1 = 20 Nov 2026 (−70 days), E2 = 18 Dec (−42).
    const gated = info({ deadlines: [deadline({ id: "n-1", kind: "nomination", localDate: "2027-01-29", precision: "exact", localTime: "17:00", timeZone: "America/New_York", dueAt: "2027-01-29T22:00:00.000Z" })] });
    const beforeE1 = planCycleReminders(recipient(), followed, gated, Date.UTC(2026, 10, 18, 15, 0));
    expect(beforeE1.map((d) => d.kind)).toEqual(["t2"]);
    expect(beforeE1[0]?.dedupeKey).toContain(":2026-11-20");
    const dayAfter = planCycleReminders(recipient(), followed, gated, Date.UTC(2026, 10, 21, 15, 0));
    expect(dayAfter.map((d) => d.kind)).toEqual(["campus_confirm"]);
    expect(dayAfter[0]).toMatchObject({ dedupeKey: "campus:cycle-1:2026-11-20" });
    expect(dayAfter[0]?.title).toContain("Confirm your campus deadline now");
    // A known campus date (the student's own) replaces the estimates: no campus message.
    const own = planCycleReminders(recipient(), { ...followed, ownCampusDeadline: "2026-12-05" }, gated, Date.UTC(2026, 10, 21, 15, 0));
    expect(own).toHaveLength(0);
  });

  it("sends nothing for closed, rolling or predicted deadlines", () => {
    const closed = info({ deadlines: [deadline({ id: "d-9", localDate: "2026-11-01" })] });
    expect(planCycleReminders(recipient(), followed, closed, T2_AT)).toHaveLength(0);
    const rolling = info({ deadlines: [deadline({ id: "d-8", localDate: null, precision: "rolling" })] });
    expect(planCycleReminders(recipient(), followed, rolling, T2_AT)).toHaveLength(0);
  });
});

describe("first-door step reminders", () => {
  const row = { id: "r1", reminderKey: "fd:step-1", kind: "step_due" as const, stepId: "step-1", sendOn: "2026-11-21", sendAt: "09:00", timeZone: "America/Chicago", neutral: false };
  const ctx = { recipient: recipient(), trackerStatus: "applying", stepTitle: "Ask a professor for a letter", info: info(), nameInMessages: true };

  it("sends a due step with its title and waits for future ones", () => {
    const d = planStepReminder(row, ctx, T2_AT);
    expect(d.action).toBe("send");
    if (d.action === "send") {
      expect(d.draft.title).toBe("Due tomorrow: Ask a professor for a letter");
      expect(d.draft.dedupeKey).toBe("step:fd:step-1");
    }
    expect(planStepReminder(row, ctx, T2_AT - 5 * HOUR).action).toBe("wait");
  });

  it("cancels once the application is submitted or dropped, and when stale", () => {
    expect(planStepReminder(row, { ...ctx, trackerStatus: "submitted" }, T2_AT)).toEqual({ action: "cancel", reason: "not_preparing" });
    expect(planStepReminder(row, { ...ctx, trackerStatus: null }, T2_AT)).toEqual({ action: "cancel", reason: "not_preparing" });
    expect(planStepReminder(row, ctx, T2_AT + 30 * HOUR)).toEqual({ action: "cancel", reason: "stale" });
  });

  it("keeps neutral rows neutral", () => {
    const d = planStepReminder({ ...row, neutral: true }, ctx, T2_AT);
    expect(d.action === "send" && `${d.draft.title} ${d.draft.body}`).not.toMatch(/Job Shadow|professor/);
  });
});

describe("weekly email", () => {
  const now = Date.UTC(2026, 10, 16, 0, 30); // Sun 15 Nov 18:30 CST
  const requirement = { id: "q-1", programCycleId: "cycle-1", kind: "recommendation", label: "One recommendation letter", detail: null, quantity: 1, wordLimit: null, deadlineId: null, effortHours: null, leadTimeDays: null, evidence: null, verificationState: "verified" } as unknown as Requirement;

  it("lists deadlines and start-by dates in the next 14 days, earliest first", () => {
    const content = collectWeekly({
      recipient: recipient(),
      cycles: [{ followed, info: info({ requirements: [requirement], deadlines: [deadline({ id: "d-1", localDate: "2026-11-27" })] }) }],
      progress: [],
      changes: [],
      dueSoon: [],
      now,
    });
    expect(content.today).toBe("2026-11-15");
    expect(content.entries.map((e) => e.kind)).toContain("deadline");
    expect(content.entries[0]!.date <= content.entries[content.entries.length - 1]!.date).toBe(true);
    const r = renderWeekly(content, { appOrigin: "https://novus.example.org", unsubscribeUrl: "https://novus.example.org/e/u/tok" });
    expect(r.subject).not.toContain("Job Shadow");
    expect(r.text).toContain("Sample Job Shadow Week (Winter 2026) [sample listing]");
    expect(r.text).toContain("Stop the weekly email: https://novus.example.org/e/u/tok");
    expect(r.html).toContain('href="https://novus.example.org/e/u/tok"');
    expect(r.html).not.toMatch(/<img/i);
  });

  it("drops finished requirements and is empty when nothing is due", () => {
    const far = info({ deadlines: [deadline({ id: "d-1", localDate: "2027-03-01" })] });
    const empty = collectWeekly({ recipient: recipient(), cycles: [{ followed, info: far }], progress: [], changes: [], dueSoon: [], now });
    expect(isEmptyWeekly(empty)).toBe(true);
    const done = collectWeekly({
      recipient: recipient(),
      cycles: [{ followed, info: info({ requirements: [requirement], deadlines: [deadline({ id: "d-1", localDate: "2026-11-27" })] }) }],
      progress: [{ subjectKey: "req:q-1", state: "met" }],
      changes: [],
      dueSoon: [],
      now,
    });
    expect(done.entries.every((e) => e.kind === "deadline")).toBe(true);
  });

  it("keeps neutral programs neutral and escapes change text", () => {
    const content = collectWeekly({
      recipient: recipient(),
      cycles: [{ followed: { ...followed, nameInMessages: false }, info: info({ deadlines: [deadline({ id: "d-1", localDate: "2026-11-20" })] }) }],
      progress: [],
      changes: [{ title: "Deadline changed: <b>x</b>", body: "Now earlier.", href: "/programs/x" }],
      dueSoon: [],
      now,
    });
    const r = renderWeekly(content, { appOrigin: "https://novus.example.org", unsubscribeUrl: null });
    expect(r.text).toContain("A program you saved");
    expect(r.text).not.toContain("Job Shadow");
    expect(r.html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});
