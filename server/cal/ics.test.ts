import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeDueAt } from "@shared/time";
import { deadlineEvent, deadlineStart, isNeutral, ownCampusEvent, sortEvents } from "./events";
import { groupEvents, renderProgramFeed, renderUserFeed } from "./feeds";
import { escapeText, foldLine, formatDate, formatFloating, formatUtc, renderCalendar } from "./ics";
import { eventUid, isUuid, NOVUS_ICS_NAMESPACE, sha1, UID_NAMES, uuidv5 } from "./uid";
import {
  APPLICANT_LOCAL,
  DATE_ONLY,
  FIXED_EXACT,
  GOLDEN_ORIGIN,
  GOLDEN_PROGRAM,
  MONTH_ONLY,
  PREDICTED_WINDOW,
  WITHDRAWN,
  goldenFeed,
} from "./golden/fixtures";

const golden = (name: string): string => readFileSync(decodeURIComponent(new URL(`./golden/${name}.ics`, import.meta.url).pathname), "utf8");
const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const octets = (s: string): number => new TextEncoder().encode(s).length;

/** Unfolds and splits an ICS body into logical content lines. */
function contentLines(ics: string): string[] {
  return ics.replace(/\r\n /g, "").split("\r\n").filter(Boolean);
}

describe("UIDs (UUIDv5, RFC 9562)", () => {
  it("implements SHA-1 (FIPS 180-4 vectors)", () => {
    const enc = new TextEncoder();
    expect(hex(sha1(enc.encode("abc")))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(hex(sha1(enc.encode("")))).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    // 56 bytes: the padding spills into a second block.
    expect(hex(sha1(enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")))).toBe("84983e441c3bd26ebaae4aa1f95129e5e54670f1");
  });

  it("matches Python's uuid.uuid5 (RFC test namespace and the Novus namespace)", () => {
    expect(uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org")).toBe("886313e1-3b8a-5372-9b90-0c9aee199e5d");
    // Non-ASCII names hash as UTF-8.
    expect(uuidv5("6ba7b811-9dad-11d1-80b4-00c04fd430c8", "https://example.org/é")).toBe("4db32f13-2b90-551e-bb13-4c966035961b");
    // Frozen values: a change here would duplicate events in every subscribed calendar.
    expect(NOVUS_ICS_NAMESPACE).toBe("a36eeaa1-4df9-4a12-8c36-c1060db8f768");
    expect(eventUid(UID_NAMES.deadline("0193a000-0000-7000-8000-000000000001"))).toBe("a7089939-5301-5900-9c1e-e7c34ed367db");
    expect(eventUid(UID_NAMES.ownCampus("0193a000-0000-7000-8000-0000000000aa"))).toBe("67fa034e-a9e2-5cfa-b7e8-8210f50af935");
    expect(eventUid(UID_NAMES.estimate("0193a000-0000-7000-8000-0000000000bb", "e1"))).toBe("62b22249-e2c6-5a30-a893-186ddcb9003a");
  });

  it("gives every event a UUID UID that is stable and distinct", () => {
    const events = groupEvents(goldenFeed([FIXED_EXACT, DATE_ONLY, APPLICANT_LOCAL, WITHDRAWN, PREDICTED_WINDOW]).groups, GOLDEN_ORIGIN);
    expect(events).toHaveLength(5);
    for (const e of events) expect(isUuid(e.uid), e.uid).toBe(true);
    expect(new Set(events.map((e) => e.uid)).size).toBe(5);
    const again = groupEvents(goldenFeed([FIXED_EXACT]).groups, GOLDEN_ORIGIN);
    expect(again[0]!.uid).toBe(events.find((e) => e.start.kind === "utc" && e.status === "CONFIRMED")!.uid);
  });
});

describe("text encoding (RFC 5545 §3.1, §3.3.11)", () => {
  it("escapes TEXT values", () => {
    expect(escapeText("a,b;c\\d\ne\r\nf")).toBe("a\\,b\\;c\\\\d\\ne\\nf");
  });

  it("folds at 75 octets with a leading space and never splits a UTF-8 sequence", () => {
    const ascii = `DESCRIPTION:${"x".repeat(200)}`;
    const folded = foldLine(ascii);
    for (const line of folded.split("\r\n")) expect(octets(line)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, "")).toBe(ascii);

    const wide = `SUMMARY:${"é漢🎓".repeat(30)}`;
    const wideFolded = foldLine(wide);
    for (const line of wideFolded.split("\r\n")) {
      expect(octets(line)).toBeLessThanOrEqual(75);
      expect(line).not.toContain("�");
    }
    expect(wideFolded.replace(/\r\n /g, "")).toBe(wide);
    expect(foldLine("SHORT:ok")).toBe("SHORT:ok");
  });

  it("formats dates without going through local Date parsing", () => {
    expect(formatUtc(Date.UTC(2027, 0, 29, 23, 0, 0))).toBe("20270129T230000Z");
    expect(formatDate("2027-01-01")).toBe("20270101");
    expect(formatFloating("2027-02-02", "23:59")).toBe("20270202T235900");
    expect(() => formatDate("2027-02")).toThrow();
  });

  it("drops a URL that could inject a property", () => {
    const body = renderCalendar({
      name: "t",
      refreshHours: 1,
      events: [{ uid: eventUid("x"), sequence: 1, start: { kind: "date", date: "2027-01-01" }, summary: "s", status: "CONFIRMED", stampMs: 0, url: "https://example.org/a\r\nATTACH:evil" }],
    });
    expect(body).not.toContain("ATTACH");
    expect(body).not.toContain("URL:");
  });
});

describe("golden feeds (one per start form, plus CANCELLED)", () => {
  it("writes fixed timed deadlines in UTC from due_at, with no VTIMEZONE", () => {
    expect(computeDueAt(FIXED_EXACT)).toBe(FIXED_EXACT.dueAt);
    const body = renderProgramFeed(goldenFeed([FIXED_EXACT]), GOLDEN_ORIGIN);
    expect(body).toBe(golden("fixed-utc"));
    expect(body).toContain("DTSTART:20270129T230000Z\r\n");
    expect(body).not.toContain("VTIMEZONE");
    expect(body).not.toContain("TZID");
    expect(body).toContain("STATUS:CONFIRMED");
    expect(contentLines(body)).toContain("DESCRIPTION:Sample data\\, not a real program.\\nSample National STEM Scholarship (Example Science Foundation)\\nDue 2027-01-29 at 18:00 (America/New_York)\\nVerified on 2026-11-05 by curator-ada.\\nOfficial page: https://example.org/stem-scholarship\\nOn Novus: https://novus.example.org/programs/sample-national-stem-scholarship\\nAlways confirm dates on the official page.");
  });

  it("writes date-only deadlines as all-day events", () => {
    expect(computeDueAt(DATE_ONLY)).toBe(DATE_ONLY.dueAt);
    const body = renderProgramFeed(goldenFeed([DATE_ONLY]), GOLDEN_ORIGIN);
    expect(body).toBe(golden("date-only"));
    expect(body).toContain("DTSTART;VALUE=DATE:20270215\r\nDTEND;VALUE=DATE:20270216\r\n");
  });

  it("writes applicant-local deadlines in floating time", () => {
    const body = renderProgramFeed(goldenFeed([APPLICANT_LOCAL]), GOLDEN_ORIGIN);
    expect(body).toBe(golden("applicant-local"));
    expect(body).toContain("DTSTART:20270202T235900\r\n");
    expect(contentLines(body)).toContain("SUMMARY:[Priority round] Sample National STEM Scholarship: priority deadline (Early round)");
    // Unverified rows are tentative and say so.
    expect(body).toContain("STATUS:TENTATIVE");
    expect(contentLines(body).join("\n")).toContain("Not yet verified by a Novus Curator.");
  });

  it("keeps the UID and raises SEQUENCE for a withdrawn deadline, with no alarms", () => {
    const body = renderProgramFeed(goldenFeed([WITHDRAWN]), GOLDEN_ORIGIN);
    expect(body).toBe(golden("cancelled"));
    expect(body).toContain("STATUS:CANCELLED");
    expect(body).toContain("SEQUENCE:3");
    expect(body).toContain(`UID:${eventUid(UID_NAMES.deadline(WITHDRAWN.id))}`);
    expect(body).not.toContain("VALARM");
  });

  it("marks predicted windows tentative and emits nothing for month-only rows", () => {
    const body = renderProgramFeed(goldenFeed([PREDICTED_WINDOW, MONTH_ONLY]), GOLDEN_ORIGIN);
    expect(body).toBe(golden("predicted-window"));
    expect(body.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(contentLines(body)).toContain("SUMMARY:[National] Sample National STEM Scholarship: application deadline (predicted)");
    expect(body).toContain("DTSTART;VALUE=DATE:20270910");
  });

  it("includes 7-day and 1-day alarms on submission deadlines only", () => {
    const body = renderProgramFeed(goldenFeed([FIXED_EXACT]), GOLDEN_ORIGIN);
    expect(body).toContain("TRIGGER:-P7D");
    expect(body).toContain("TRIGGER:-P1D");
    const start = deadlineEvent({ ...FIXED_EXACT, kind: "program_start" }, GOLDEN_PROGRAM, { origin: GOLDEN_ORIGIN, neutral: false });
    expect(start?.alarms).toEqual([]);
  });

  it("never mentions eligibility", () => {
    const body = renderProgramFeed(goldenFeed([FIXED_EXACT, DATE_ONLY, APPLICANT_LOCAL, WITHDRAWN, PREDICTED_WINDOW]), GOLDEN_ORIGIN);
    expect(body.toLowerCase()).not.toMatch(/eligib/);
  });

  it("renders the same bytes for the same data, whatever order rows arrive in", () => {
    const a = renderProgramFeed(goldenFeed([FIXED_EXACT, DATE_ONLY, APPLICANT_LOCAL]), GOLDEN_ORIGIN);
    const b = renderProgramFeed(goldenFeed([APPLICANT_LOCAL, FIXED_EXACT, DATE_ONLY]), GOLDEN_ORIGIN);
    expect(a).toBe(b);
  });
});

describe("neutral mode (status- and identity-defined programs)", () => {
  const own = { trackerItemId: "0193a000-0000-7000-8000-0000000000aa", date: "2027-01-10", version: 4, updatedAt: Date.UTC(2026, 11, 1) };

  it("names nothing that identifies the program", () => {
    const body = renderUserFeed(
      { groups: [{ context: GOLDEN_PROGRAM, neutral: true, deadlines: [FIXED_EXACT, DATE_ONLY, APPLICANT_LOCAL, WITHDRAWN, PREDICTED_WINDOW], ownCampus: own }] },
      GOLDEN_ORIGIN,
    );
    const text = contentLines(body).join("\n");
    for (const forbidden of [GOLDEN_PROGRAM.name, GOLDEN_PROGRAM.slug, GOLDEN_PROGRAM.organizationName, "example.org/stem", "Priority round", "CATEGORIES", "LOCATION", "ATTACH", "ORGANIZER"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(text).toContain("SUMMARY:[National] Saved deadline");
    expect(text).toContain("SUMMARY:[Campus] Saved deadline");
    expect(text).toContain("DESCRIPTION:Details in Novus (sign in)");
    expect(text).toContain("URL:https://novus.example.org/app/tracker");
    expect(text).toContain("DESCRIPTION:Saved deadline coming up");
  });

  it("decides neutral text from the program flags, the opt-in and the feed setting", () => {
    const named = { sensitiveAudience: false, identityAudience: [] as string[], nameInMessages: true, feedNeutral: false };
    expect(isNeutral(named)).toBe(false);
    expect(isNeutral({ ...named, sensitiveAudience: true })).toBe(true);
    expect(isNeutral({ ...named, sensitiveAudience: true, nameInMessages: true })).toBe(true);
    expect(isNeutral({ ...named, identityAudience: ["women"], nameInMessages: false })).toBe(true);
    expect(isNeutral({ ...named, identityAudience: ["women"], nameInMessages: true })).toBe(false);
    expect(isNeutral({ ...named, feedNeutral: true })).toBe(true);
  });
});

describe("private campus dates", () => {
  it("uses the tracker item's UID and version, all-day and tentative", () => {
    const event = ownCampusEvent(
      { trackerItemId: "0193a000-0000-7000-8000-0000000000aa", date: "2027-01-10", version: 4, updatedAt: 0 },
      GOLDEN_PROGRAM,
      { origin: GOLDEN_ORIGIN, neutral: false },
    );
    expect(event).toMatchObject({
      uid: "67fa034e-a9e2-5cfa-b7e8-8210f50af935",
      sequence: 4,
      start: { kind: "date", date: "2027-01-10" },
      status: "TENTATIVE",
      summary: "[Campus] Sample National STEM Scholarship: your campus deadline",
    });
  });
});

describe("start forms", () => {
  it("skips rows whose fields cannot place a day", () => {
    expect(deadlineStart({ ...FIXED_EXACT, dueAt: null })).toBeNull();
    expect(deadlineStart({ ...APPLICANT_LOCAL, localTime: null })).toBeNull();
    expect(deadlineStart({ ...DATE_ONLY, localDate: "2027-02" })).toBeNull();
    expect(deadlineStart({ ...FIXED_EXACT, precision: "rolling" })).toBeNull();
    expect(deadlineStart({ ...FIXED_EXACT, precision: "tbd" })).toBeNull();
  });

  it("orders events by start then UID", () => {
    const events = groupEvents(goldenFeed([PREDICTED_WINDOW, APPLICANT_LOCAL, FIXED_EXACT, WITHDRAWN]).groups, GOLDEN_ORIGIN);
    expect(sortEvents(events).map((e) => e.sequence)).toEqual([3, 1, 1, 1]);
    expect(events[0]!.status).toBe("CANCELLED");
    expect(events[events.length - 1]!.summary).toContain("(predicted)");
  });
});
