import { describe, expect, it } from "vitest";
import { ReviewTaskResolveSchema } from "@shared/contracts/ops";
import { REVIEW_TASK_KINDS } from "@shared/taxonomy";
import { findingsFrom, officialLink, proposalsFrom, riskSignalsFrom } from "./evidence";
import { changedCycleFields, dayNumber, highImpactReasons, needsOfficialLink, type CurrentCycle, type CurrentDeadline } from "./impact";
import { isRetryable, median } from "./ops";
import { claimable, compareQueue, decodeCursor, encodeCursor, inView, KIND_SEVERITY, orderQueue, severityOf, type QueueRow } from "./queue";
import { CuratorResolveSchema, EditsSchema } from "./schemas";
import { changedHunks, foldWithMap, highlightRanges, hostOf, lineDiff, locateQuote, plainModelText } from "./text";

const NOW = Date.parse("2026-11-11T15:00:00Z");
const ME = "c-me";
const YOU = "c-you";

function row(over: Partial<QueueRow> = {}): QueueRow {
  return { id: "t1", kind: "cycle_update", state: "open", priority: 5, dueAt: null, createdAt: NOW - 1000, claimedBy: null, claimExpiresAt: null, payload: {}, ...over };
}

describe("queue", () => {
  it("has a severity for every task kind, from error report 1.0 down to hint 0.3", () => {
    for (const k of REVIEW_TASK_KINDS) expect(KIND_SEVERITY[k]).toBeGreaterThan(0);
    expect(severityOf("error_report")).toBe(1);
    expect(severityOf("community_hint")).toBe(0.3);
    expect(Math.max(...Object.values(KIND_SEVERITY))).toBe(1);
    expect(Math.min(...Object.values(KIND_SEVERITY))).toBe(0.3);
  });

  it("orders by due time, then severity, then wedge, then priority and age", () => {
    const a = { ...row({ id: "a", dueAt: NOW + 10 }), wedge: false };
    const b = { ...row({ id: "b", dueAt: NOW + 5, kind: "community_hint" }), wedge: false };
    const c = { ...row({ id: "c", dueAt: null, kind: "error_report" }), wedge: true };
    const d = { ...row({ id: "d", dueAt: NOW + 10, kind: "error_report" }), wedge: false };
    const e = { ...row({ id: "e", dueAt: NOW + 10 }), wedge: true };
    expect(orderQueue([a, b, c, d, e]).map((r) => r.id)).toEqual(["b", "d", "e", "a", "c"]);
    expect(compareQueue(a, a)).toBe(0);
  });

  it("claim rules: open yes, live claim only for its holder, second review never for the first approver", () => {
    expect(claimable(row(), ME, NOW, false).ok).toBe(true);
    const held = row({ state: "claimed", claimedBy: YOU, claimExpiresAt: NOW + 60_000 });
    expect(claimable(held, ME, NOW, false).ok).toBe(false);
    expect(claimable(held, YOU, NOW, false).ok).toBe(true);
    expect(claimable({ ...held, claimExpiresAt: NOW - 1 }, ME, NOW, false).ok).toBe(true);
    const second = row({ state: "second_review", payload: { firstApproval: { by: ME } } });
    expect(claimable(second, ME, NOW, false).ok).toBe(false);
    expect(claimable(second, YOU, NOW, false).ok).toBe(true);
    // An expired second-review claim does not fall back to the first approver.
    const expiredSecond = row({ state: "claimed", claimedBy: YOU, claimExpiresAt: NOW - 1, payload: { firstApproval: { by: ME } } });
    expect(claimable(expiredSecond, ME, NOW, false).ok).toBe(false);
    expect(inView(expiredSecond, "queue", ME, NOW)).toBe(false);
  });

  it("snoozed tasks wake at their date; escalated tasks are for admins; closed tasks never", () => {
    const snoozed = row({ state: "snoozed", payload: { snoozedUntil: new Date(NOW + 1000).toISOString() } });
    expect(claimable(snoozed, ME, NOW, false).ok).toBe(false);
    expect(claimable(snoozed, ME, NOW + 2000, false).ok).toBe(true);
    expect(inView(snoozed, "queue", ME, NOW)).toBe(false);
    expect(inView(snoozed, "snoozed", ME, NOW)).toBe(true);
    expect(inView(snoozed, "queue", ME, NOW + 2000)).toBe(true);
    expect(claimable(row({ state: "escalated" }), ME, NOW, false).ok).toBe(false);
    expect(claimable(row({ state: "escalated" }), ME, NOW, true).ok).toBe(true);
    for (const state of ["applied", "rejected", "approved", "apply_failed"]) expect(claimable(row({ state }), ME, NOW, true).ok).toBe(false);
  });

  it("views: mine shows only my live claims", () => {
    const mine = row({ state: "claimed", claimedBy: ME, claimExpiresAt: NOW + 1 });
    expect(inView(mine, "mine", ME, NOW)).toBe(true);
    expect(inView(mine, "mine", YOU, NOW)).toBe(false);
    expect(inView(mine, "queue", YOU, NOW)).toBe(false);
  });

  it("offset cursors round-trip and stop at the end", () => {
    expect(decodeCursor(undefined)).toBe(0);
    expect(decodeCursor("o:25")).toBe(25);
    expect(decodeCursor("junk")).toBe(0);
    expect(encodeCursor(25, 30)).toBe("o:25");
    expect(encodeCursor(30, 30)).toBeNull();
  });
});

describe("text", () => {
  const page = "Applications are due\n  February 17, 2027 at 11:59 PM Central. Letters: “two” required.";

  it("finds a quote across whitespace, case and typographic quotes, with original offsets", () => {
    const r = locateQuote(page, "applications are due February 17, 2027");
    expect(r).not.toBeNull();
    expect(page.slice(r!.start, r!.end)).toBe("Applications are due\n  February 17, 2027");
    const q = locateQuote(page, 'Letters: "two" required.');
    expect(page.slice(q!.start, q!.end)).toBe("Letters: “two” required.");
  });

  it("never matches different words", () => {
    expect(locateQuote(page, "Applications are due February 24, 2027")).toBeNull();
    expect(locateQuote(page, "   ")).toBeNull();
  });

  it("folds whitespace runs to one space and keeps a map back to the original", () => {
    const { folded, map } = foldWithMap("  A\n\n b  ");
    expect(folded).toBe("a b");
    expect(map).toEqual([2, 3, 6]);
  });

  it("highlights found quotes in order and reports missing ones", () => {
    const { marks, missing } = highlightRanges(page, [
      { ref: "e2", quote: "11:59 PM Central", kind: "verified" },
      { ref: "e1", quote: "Applications are due", kind: "verified" },
      { ref: "p0", quote: "not on this page", kind: "proposed" },
    ]);
    expect(marks.map((m) => m.ref)).toEqual(["e1", "e2"]);
    expect(missing).toEqual(["p0"]);
  });

  it("diffs lines and keeps changes first with context", () => {
    const before = "Title\nDue February 17\nTwo letters\nFooter";
    const after = "Title\nDue February 24\nTwo letters\nFooter";
    const { ops, truncated } = lineDiff(before, after);
    expect(truncated).toBe(false);
    expect(ops.filter((o) => o.op !== "same")).toEqual([
      { op: "del", line: "Due February 17" },
      { op: "add", line: "Due February 24" },
    ]);
    expect(changedHunks(ops, 1).map((o) => o.line)).toEqual(["Title", "Due February 17", "Due February 24", "Two letters"]);
    expect(lineDiff("a\nb", "a\nb").ops.every((o) => o.op === "same")).toBe(true);
    expect(lineDiff("x\n".repeat(10), "y\n".repeat(10), 5).truncated).toBe(true);
  });

  it("renders model text plain: link labels kept, URLs, tags and control characters removed", () => {
    expect(plainModelText("See [the portal](https://x.example.com) or https://y.example.com/a <b>now</b>\u0007")).toBe("See the portal or [link removed] now");
    expect(plainModelText(42)).toBe("");
    expect(plainModelText("a".repeat(50), 10)).toHaveLength(10);
  });

  it("reads hosts without www", () => {
    expect(hostOf("https://www.Example.org/apply")).toBe("example.org");
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});

describe("high-impact changes", () => {
  const cycle: CurrentCycle = { status: "open", applicationUrl: "https://apply.example.org/form", applicationFeeCents: null, opensOn: null };
  const deadlines: CurrentDeadline[] = [{ id: "d1", kind: "application", scope: "national", institutionId: null, roundLabel: "", localDate: "2027-02-17" }];
  const ev = { snapshotId: "0190f0a0-0000-7000-8000-000000000001", url: "https://apply.example.org/form", quote: "q" };
  const edits = (raw: unknown) => EditsSchema.parse(raw);
  const upsert = (localDate: string, basis: "official" | "attested" = "official") => ({
    op: "upsert",
    deadline: { kind: "application", precision: "date_only", localDate, timeZone: "America/Chicago", basis, ...(basis === "attested" ? { scope: "campus", institutionId: "0190f0a0-0000-7000-8000-000000000002" } : {}) },
    evidence: ev,
  });

  it("flags status paused or ended", () => {
    expect(highImpactReasons(cycle, deadlines, edits({ cycle: { status: "paused" } }))).toEqual(["status_paused_or_ended"]);
    expect(highImpactReasons(cycle, deadlines, edits({ cycle: { status: "closed" } }))).toEqual([]);
  });

  it("flags a deadline moved more than 3 days earlier, not later or by 3 days", () => {
    expect(highImpactReasons(cycle, deadlines, edits({ deadlines: [upsert("2027-02-13")] }))).toEqual(["deadline_moved_earlier"]);
    expect(highImpactReasons(cycle, deadlines, edits({ deadlines: [upsert("2027-02-14")] }))).toEqual([]);
    expect(highImpactReasons(cycle, deadlines, edits({ deadlines: [upsert("2027-03-01")] }))).toEqual([]);
  });

  it("flags a new application host and attested URL, fee or campus-date changes", () => {
    expect(highImpactReasons(cycle, deadlines, edits({ cycle: { applicationUrl: "https://other.example.net/apply" } }))).toEqual(["new_application_host"]);
    expect(highImpactReasons(cycle, deadlines, edits({ cycle: { applicationUrl: "https://apply.example.org/v2" } }))).toEqual([]);
    expect(
      highImpactReasons(cycle, deadlines, edits({ cycle: { applicationFeeCents: 2500 }, cycleEvidence: { applicationFeeCents: { snapshotId: null, basis: "manual_note", url: "https://x.example.org", quote: "phone call" } } })),
    ).toEqual(["attested_change"]);
    expect(highImpactReasons(cycle, deadlines, edits({ deadlines: [upsert("2027-02-20", "attested")] }))).toEqual(["attested_change"]);
  });

  it("asks for the official link on deadline, status or URL changes only", () => {
    expect(needsOfficialLink(cycle, edits({}))).toBe(false);
    expect(needsOfficialLink(cycle, edits({ cycle: { applicationFeeCents: 100 } }))).toBe(false);
    expect(needsOfficialLink(cycle, edits({ cycle: { status: "open" } }))).toBe(false);
    expect(needsOfficialLink(cycle, edits({ cycle: { status: "closed" } }))).toBe(true);
    expect(needsOfficialLink(cycle, edits({ deadlines: [upsert("2027-02-20")] }))).toBe(true);
    expect(changedCycleFields(cycle, edits({ cycle: { status: "open", opensOn: "2026-12-01" } }))).toEqual(["opensOn"]);
  });

  it("reads day numbers of dates and months", () => {
    expect(dayNumber("2027-02-17")! - dayNumber("2027-02-13")!).toBe(4);
    expect(dayNumber("2027-02")).toBe(dayNumber("2027-02-01"));
    expect(dayNumber(null)).toBeNull();
  });
});

describe("request schemas", () => {
  it("accepts every contract-valid resolve body unchanged (superset of the route map)", () => {
    for (const body of [
      { decision: "approve", resolution: "ok", subjectVersion: 3 },
      { decision: "escalate", resolution: "needs a founder", subjectVersion: null },
    ]) {
      expect(ReviewTaskResolveSchema.safeParse(body).success).toBe(true);
      expect(CuratorResolveSchema.safeParse(body).success).toBe(true);
    }
  });

  it("requires a reason code to reject, a date and reason to snooze, and edits only with approve", () => {
    expect(CuratorResolveSchema.safeParse({ decision: "reject", resolution: "x", subjectVersion: null }).success).toBe(false);
    expect(CuratorResolveSchema.safeParse({ decision: "reject", rejectReason: "duplicate", subjectVersion: null }).success).toBe(true);
    expect(CuratorResolveSchema.safeParse({ decision: "reject", rejectReason: "other", resolution: "", subjectVersion: null }).success).toBe(false);
    expect(CuratorResolveSchema.safeParse({ decision: "snooze", resolution: "waiting", subjectVersion: null }).success).toBe(false);
    expect(CuratorResolveSchema.safeParse({ decision: "snooze", resolution: "waiting", snoozeUntil: "2026-11-20T00:00:00.000Z", subjectVersion: null }).success).toBe(true);
    expect(CuratorResolveSchema.safeParse({ decision: "reject", rejectReason: "duplicate", subjectVersion: null, edits: {} }).success).toBe(false);
    expect(CuratorResolveSchema.safeParse({ decision: "approve", subjectVersion: 1, activeSeconds: 4000 }).success).toBe(false);
  });

  it("evidence: snapshot quotes name their Snapshot, notes do not", () => {
    const base = { url: "https://example.org", quote: "q" };
    expect(EditsSchema.safeParse({ cycleEvidence: { status: { ...base, basis: "snapshot", snapshotId: null } } }).success).toBe(false);
    expect(EditsSchema.safeParse({ cycleEvidence: { status: { ...base, basis: "manual_note", snapshotId: "0190f0a0-0000-7000-8000-000000000001" } } }).success).toBe(false);
    expect(EditsSchema.safeParse({ cycleEvidence: { status: { ...base, basis: "manual_note" } } }).success).toBe(true);
  });

  it("refuses sensitive-looking or unknown keys in edits (strict)", () => {
    expect(EditsSchema.safeParse({ cycle: { citizenship: "x" } }).success).toBe(false);
    expect(EditsSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe("evidence helpers and ops", () => {
  it("proposals are plain text; findings drop model confidence; risk signals are strings", () => {
    const payload = {
      extraction: {
        payload: {
          cycle_status: { value: "open", quote: "Applications are open", status: "found" },
          opens_on: { value: "", quote: "", status: "not_stated" },
          deadlines: [{ kind: "application", local_date: "2027-02-24", local_time: "", time_zone_text: "", quote: "Due [Feb 24](https://x.example.com)", status: "found" }],
        },
        validation: { fields: [{ path: "a", code: "QUOTE_OK", blocked: true, flags: ["f", 3], confidence: "high" }] },
      },
      riskSignals: ["new_host", 7],
    };
    const proposals = proposalsFrom(payload);
    expect(proposals.map((p) => p.field)).toEqual(["cycle_status", "deadline.application"]);
    expect(proposals[1]!.quote).toBe("Due Feb 24");
    expect(findingsFrom(payload)).toEqual([{ path: "a", code: "QUOTE_OK", blocked: true, flags: ["f"] }]);
    expect(riskSignalsFrom(payload)).toEqual(["new_host"]);
    expect(proposalsFrom({})).toEqual([]);
    expect(findingsFrom({})).toEqual([]);
  });

  it("links PDFs at their page", () => {
    expect(officialLink("https://example.org/a.pdf", true, 3)).toBe("https://example.org/a.pdf#page=3");
    expect(officialLink("https://example.org/a.pdf#x", true, 3)).toBe("https://example.org/a.pdf#page=3");
    expect(officialLink("https://example.org/a", false, 3)).toBe("https://example.org/a");
  });

  it("median and retry rules", () => {
    expect(median([])).toBeNull();
    expect(median([5, 1, 3])).toBe(3);
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(isRetryable({ status: "dead", attempts: 8, lastError: "x" })).toBe(true);
    expect(isRetryable({ status: "pending", attempts: 2, lastError: "x" })).toBe(true);
    expect(isRetryable({ status: "pending", attempts: 0, lastError: null })).toBe(false);
    expect(isRetryable({ status: "leased", attempts: 1, lastError: "x" })).toBe(false);
  });
});
