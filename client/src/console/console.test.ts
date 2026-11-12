import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Deadline } from "@shared/contracts/registry";
import { ConsoleError, createConsoleApi, errorFor, SECOND_FACTOR_PROBLEM_TYPE, type FetchLike } from "./api";
import {
  actionForKey,
  ActiveTimer,
  APPROVE_CONFIRM_MS,
  approveKeyStep,
  CLAIM_WARN_MS,
  claimStatus,
  formatCountdown,
  buildDeadlineOp,
  dueLabel,
  formChanged,
  formFromDeadline,
  formatCents,
  formatSeconds,
  humanize,
  IDLE_AFTER_MS,
  segments,
  selectionQuote,
  severityLabel,
} from "./model";

const NOW = Date.parse("2026-11-11T15:00:00Z");

function problem(status: number, extra: Record<string, unknown> = {}) {
  const codes: Record<number, string> = { 400: "validation_failed", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "conflict", 412: "precondition_failed", 503: "unavailable" };
  return new Response(JSON.stringify({ type: "/problems/x", title: "t", status, code: codes[status], ...extra }), { status, headers: { "content-type": "application/problem+json" } });
}

describe("api errors", () => {
  it("maps statuses and the second-factor problem type to console error kinds", async () => {
    expect((await errorFor(problem(401))).kind).toBe("signed_out");
    expect((await errorFor(problem(403, { type: SECOND_FACTOR_PROBLEM_TYPE, detail: "Confirm the code from your authenticator app to continue." }))).kind).toBe("step_up");
    expect((await errorFor(problem(403, { type: SECOND_FACTOR_PROBLEM_TYPE, detail: "Set up an authenticator app to continue." }))).kind).toBe("enroll");
    expect((await errorFor(problem(403))).kind).toBe("forbidden");
    expect((await errorFor(problem(409, { detail: "Another Curator holds this task." }))).detail).toBe("Another Curator holds this task.");
    expect((await errorFor(problem(412))).kind).toBe("precondition");
    const invalid = await errorFor(problem(400, { errors: [{ path: "rejectReason", message: "x" }] }));
    expect(invalid.kind).toBe("invalid");
    expect(invalid.fieldErrors[0]!.path).toBe("rejectReason");
    expect((await errorFor(new Response("oops", { status: 502 }))).kind).toBe("unavailable");
  });

  it("calls same-origin paths with JSON bodies and surfaces network failures", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const ok: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ items: [], page: { nextCursor: null, limit: 50 }, context: {}, viewer: { handle: "h", roles: [] } }), { status: 200 });
    };
    const api = createConsoleApi(ok);
    await api.queue("second_review", "o:50");
    expect(calls[0]!.url).toBe("/api/v1/review-tasks?view=second_review&limit=50&cursor=o%3A50");
    expect(calls[0]!.init!.credentials).toBe("same-origin");
    await api.claim("0190f0a0-0000-7000-8000-000000000001");
    expect(calls[1]!.url).toBe("/api/v1/review-tasks/0190f0a0-0000-7000-8000-000000000001/claim");
    expect(calls[1]!.init!.method).toBe("POST");
    expect(calls[1]!.init!.body).toBe("{}");
    // Writes keep their Origin header, which the CSRF checks need (never "Origin: null").
    expect(calls[1]!.init!.referrerPolicy).toBe("same-origin");
    await api.rollback(3);
    expect(calls[2]!.url).toBe("/api/v1/registry/release/rollback");
    expect(JSON.parse(calls[2]!.init!.body as string)).toEqual({ release: 3 });

    const down = createConsoleApi(async () => {
      throw new TypeError("network");
    });
    await expect(down.ops()).rejects.toBeInstanceOf(ConsoleError);
  });

  it("returns undefined for 204", async () => {
    const api = createConsoleApi(async () => new Response(null, { status: 204 }));
    await expect(api.officialOpened("0190f0a0-0000-7000-8000-000000000001", null, null)).resolves.toBeUndefined();
  });
});

describe("keyboard", () => {
  it("maps the plan's keys and ignores typing, modifiers and Shift+A", () => {
    expect(actionForKey({ key: "a" })).toBe("approve");
    expect(actionForKey({ key: "R" })).toBe("reject");
    expect(actionForKey({ key: "x" })).toBe("escalate");
    expect(actionForKey({ key: "l" })).toBe("release");
    expect(actionForKey({ key: "o" })).toBe("open_official");
    expect(actionForKey({ key: "a", targetTag: "input" })).toBeNull();
    expect(actionForKey({ key: "a", targetTag: "TEXTAREA" })).toBeNull();
    expect(actionForKey({ key: "a", targetEditable: true })).toBeNull();
    expect(actionForKey({ key: "a", metaKey: true })).toBeNull();
    expect(actionForKey({ key: "A", shiftKey: true })).toBeNull();
    expect(actionForKey({ key: "m" })).toBeNull();
    expect(actionForKey({ key: "?", shiftKey: true })).toBe("help");
  });
});

describe("highlight segments", () => {
  it("splits text at quote edges and keeps overlapping kinds", () => {
    const text = "0123456789";
    const segs = segments(text, [
      { start: 2, end: 6, ref: "e1", kind: "verified" },
      { start: 4, end: 8, ref: "p0", kind: "proposed" },
    ]);
    expect(segs.map((s) => s.text)).toEqual(["01", "23", "45", "67", "89"]);
    expect(segs.map((s) => s.kinds)).toEqual([[], ["verified"], ["proposed", "verified"], ["proposed"], []]);
    expect(segs.map((s) => s.text).join("")).toBe(text);
  });

  it("ignores ranges outside the text", () => {
    expect(segments("abc", [{ start: 2, end: 10, ref: "x", kind: "verified" }]).map((s) => s.text)).toEqual(["abc"]);
  });
});

describe("labels", () => {
  it("due labels by distance", () => {
    expect(dueLabel(null, NOW)).toEqual({ text: "No due time", tone: "none" });
    expect(dueLabel(new Date(NOW - 2 * 3_600_000).toISOString(), NOW)).toEqual({ text: "Overdue by 2 h", tone: "late" });
    expect(dueLabel(new Date(NOW + 30 * 60_000).toISOString(), NOW)).toEqual({ text: "Due in 30 min", tone: "soon" });
    expect(dueLabel(new Date(NOW + 5 * 86_400_000).toISOString(), NOW)).toEqual({ text: "Due in 5 d", tone: "ok" });
  });

  it("severity, durations, money and codes", () => {
    expect(severityLabel(1)).toBe("High");
    expect(severityLabel(0.55)).toBe("Medium");
    expect(severityLabel(0.3)).toBe("Low");
    expect(formatSeconds(null)).toBe("n/a");
    expect(formatSeconds(45)).toBe("45 s");
    expect(formatSeconds(125)).toBe("2 min 5 s");
    expect(formatCents(null)).toBe("None stated");
    expect(formatCents(2500)).toBe("$25.00");
    expect(humanize("key_change_pending_draft")).toBe("Key change pending draft");
  });
});

describe("active timer", () => {
  it("counts only visible, focused, non-idle time and caps at an hour", () => {
    const t = new ActiveTimer(NOW);
    t.tick(NOW + 10_000, true, true);
    t.tick(NOW + 20_000, false, true);
    t.tick(NOW + 30_000, true, false);
    expect(t.seconds()).toBe(10);
    // Back in focus with no input: time counts only up to the idle allowance after the last input.
    t.tick(NOW + 30_000 + IDLE_AFTER_MS + 10_000, true, true);
    expect(t.seconds()).toBe(10 + (IDLE_AFTER_MS - 30_000) / 1000);
    // Input after the idle gap resumes counting from the input, not from the last tick.
    const before = t.seconds();
    t.input(NOW + 200_000);
    t.tick(NOW + 205_000, true, true);
    expect(t.seconds()).toBe(before + 5);
    const long = new ActiveTimer(NOW);
    for (let i = 1; i <= 80; i++) {
      long.input(NOW + i * 60_000);
      long.tick(NOW + i * 60_000, true, true);
    }
    expect(long.seconds()).toBe(3600);
  });
});

describe("deadline editor", () => {
  const live: Deadline = {
    id: "0190f0a0-0000-7000-8000-000000000001",
    programCycleId: "0190f0a0-0000-7000-8000-000000000002",
    kind: "application",
    scope: "national",
    institutionId: null,
    roundLabel: "",
    basis: "official",
    precision: "exact",
    tzMode: "fixed",
    localDate: "2027-02-17",
    localTime: "23:59",
    windowStart: null,
    windowEnd: null,
    timeZone: "America/Chicago",
    tzSource: "stated",
    dueAt: "2027-02-18T05:59:00.000Z",
    sortAt: "2027-02-18T05:59:00.000Z",
    revision: 1,
    verificationState: "verified",
    withdrawnAt: null,
  };

  it("starts from the live value and sends only changed rows", () => {
    const f = formFromDeadline(live);
    expect(formChanged(f, live)).toBe(false);
    expect(formChanged({ ...f, localDate: "2027-02-24" }, live)).toBe(true);
    expect(formChanged({ ...f, withdraw: true }, live)).toBe(true);
  });

  it("builds an upsert with its quote, and says what is missing", () => {
    const f = { ...formFromDeadline(live), localDate: "2027-02-24" };
    expect(buildDeadlineOp(f, "https://example.org")).toEqual({ ok: false, message: "Paste the verbatim quote from the official page." });
    const withQuote = { ...f, quote: "Due February 24", snapshotId: "0190f0a0-0000-7000-8000-000000000009" };
    const built = buildDeadlineOp(withQuote, "https://example.org");
    expect(built.ok).toBe(true);
    if (built.ok && built.op.op === "upsert") {
      expect(built.op.deadline).toMatchObject({ localDate: "2027-02-24", localTime: "23:59", timeZone: "America/Chicago", precision: "exact" });
      expect(built.op.evidence).toMatchObject({ basis: "snapshot", quote: "Due February 24" });
    }
    expect(buildDeadlineOp({ ...withQuote, localTime: "" }, "u").ok).toBe(false);
    expect(buildDeadlineOp({ ...withQuote, timeZone: "" }, "u").ok).toBe(false);
    const monthOnly = buildDeadlineOp({ ...withQuote, precision: "month_only", localDate: "2027-02", localTime: "" }, "u");
    expect(monthOnly.ok && monthOnly.op.op === "upsert" && monthOnly.op.deadline.timeZone).toBe(null);
  });

  it("withdraws a live deadline, with or without a quote", () => {
    const built = buildDeadlineOp({ ...formFromDeadline(live), withdraw: true }, "u");
    expect(built).toEqual({ ok: true, op: { op: "withdraw", deadlineId: live.id, evidence: null } });
    expect(buildDeadlineOp({ ...formFromDeadline(live), deadlineId: null, withdraw: true }, "u").ok).toBe(false);
  });

  it("cleans a selected quote", () => {
    expect(selectionQuote("  Applications are due\n\n February 24.  ")).toBe("Applications are due February 24.");
  });
});

describe("console document", () => {
  it("never sets a no-referrer policy, which would send Origin: null on every console write", () => {
    const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
    const meta = html.match(/<meta\s+name="referrer"\s+content="([^"]+)"/);
    expect(meta?.[1]).toBe("same-origin");
    expect(html).not.toMatch(/content="no-referrer"/);
  });
});

describe("claim lease and approve confirmation", () => {
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  const task = (claimedBy: string | null, expiresIn: number | null, state = "claimed") => ({ state, claimedBy, claimExpiresAt: expiresIn === null ? null : at(expiresIn) });

  it("counts down the viewer's own claim and warns in the last 2 minutes", () => {
    expect(formatCountdown(14 * 60_000 + 5_000)).toBe("14:05");
    expect(formatCountdown(-5)).toBe("00:00");
    expect(claimStatus(task("me", 10 * 60_000), "me", NOW)).toEqual({ kind: "held", msLeft: 600_000, text: "Claim ends in 10:00", warn: false });
    const late = claimStatus(task("me", CLAIM_WARN_MS - 1_000), "me", NOW);
    expect(late.kind === "held" && late.warn).toBe(true);
  });

  it("treats a lapsed lease as expired, so actions are disabled until the task is claimed again", () => {
    expect(claimStatus(task("me", -1), "me", NOW)).toEqual({ kind: "expired" });
    expect(claimStatus(task("me", null), "me", NOW)).toEqual({ kind: "expired" });
    expect(claimStatus(task(null, null, "open"), "me", NOW)).toEqual({ kind: "none" });
    expect(claimStatus(task("other", 60_000), "me", NOW)).toEqual({ kind: "other", by: "other", live: true });
    expect(claimStatus(task("other", -60_000), "me", NOW)).toEqual({ kind: "other", by: "other", live: false });
  });

  it("needs A twice within 3 seconds to approve", () => {
    expect(approveKeyStep(null, NOW)).toBe("arm");
    expect(approveKeyStep(NOW + APPROVE_CONFIRM_MS, NOW + 1_000)).toBe("approve");
    expect(approveKeyStep(NOW + APPROVE_CONFIRM_MS, NOW + APPROVE_CONFIRM_MS)).toBe("arm");
  });
});
