import { beforeEach, describe, expect, it } from "vitest";
import { JobSchema, ReviewTaskSchema } from "../../../shared/contracts/ops";
import { InboxItemSchema } from "../../../shared/contracts/events";
import { createUser, freshDb, freshEventsDb, seededDb, type TestDb } from "../testing/fixtures";
import { sampleIds } from "../seed/build";
import * as jobs from "./jobs";
import * as review from "./review";
import * as audit from "./audit";
import * as notifications from "./notifications";
import * as events from "./events";

const NOW = Date.parse("2026-11-11T15:00:00Z");

describe("jobs queue", () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await freshDb();
  });

  it("retry delay doubles from 60 s, caps at 24 h and jitters by 20%", () => {
    expect(jobs.retryDelayMs(0, 0.5)).toBe(60_000);
    expect(jobs.retryDelayMs(3, 0.5)).toBe(480_000);
    expect(jobs.retryDelayMs(30, 0.5)).toBe(86_400_000);
    expect(jobs.retryDelayMs(0, 0)).toBe(48_000);
    expect(jobs.retryDelayMs(0, 0.999999)).toBeLessThanOrEqual(72_000);
  });

  it("enqueue is idempotent", async () => {
    const a = await jobs.enqueueJob(t.db, { kind: "fetch", idempotencyKey: "fetch:s1:1" }, NOW);
    const b = await jobs.enqueueJob(t.db, { kind: "fetch", idempotencyKey: "fetch:s1:1" }, NOW);
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
  });

  it("leases one job per concurrency key, by priority", async () => {
    await jobs.enqueueJob(t.db, { kind: "fetch", idempotencyKey: "a", concurrencyKey: "host:example.org", priority: 5 }, NOW);
    await jobs.enqueueJob(t.db, { kind: "fetch", idempotencyKey: "b", concurrencyKey: "host:example.org", priority: 1 }, NOW);
    await jobs.enqueueJob(t.db, { kind: "fetch", idempotencyKey: "c", concurrencyKey: "host:other.example.org", priority: 3 }, NOW);
    await jobs.enqueueJob(t.db, { kind: "rollover", idempotencyKey: "d" }, NOW);
    await jobs.enqueueJob(t.db, { kind: "fetch", idempotencyKey: "later", runAfter: NOW + 60_000 }, NOW);
    const leased = await jobs.leaseJobs(t.db, { kinds: ["fetch"], max: 10, leaseMs: 60_000, owner: "w1", now: NOW });
    expect(leased.map((j) => j.idempotencyKey)).toEqual(["b", "c"]);
    for (const j of leased) expect(JobSchema.safeParse(j).success).toBe(true);
    // The host key is busy until its lease ends.
    expect(await jobs.leaseJobs(t.db, { kinds: ["fetch"], max: 10, leaseMs: 60_000, owner: "w2", now: NOW + 1 })).toEqual([]);
    expect(await jobs.completeJob(t.db, leased[0]!.id, "w2", NOW)).toBe(false);
    expect(await jobs.completeJob(t.db, leased[0]!.id, "w1", NOW)).toBe(true);
    const next = await jobs.leaseJobs(t.db, { kinds: ["fetch"], max: 10, leaseMs: 60_000, owner: "w2", now: NOW + 2 });
    expect(next.map((j) => j.idempotencyKey)).toEqual(["a"]);
  });

  it("retries with backoff, defers without spending an attempt, and goes dead at max attempts", async () => {
    const { id } = await jobs.enqueueJob(t.db, { kind: "fetch", idempotencyKey: "x", maxAttempts: 2 }, NOW);
    await jobs.leaseJobs(t.db, { kinds: ["fetch"], max: 1, leaseMs: 1000, owner: "w", now: NOW });
    expect(await jobs.failJob(t.db, id, "w", "HttpTimeout", "defer", NOW, 0.5)).toBe("deferred");
    expect((await jobs.getJob(t.db, id))?.attempts).toBe(0);
    await jobs.leaseJobs(t.db, { kinds: ["fetch"], max: 1, leaseMs: 1000, owner: "w", now: NOW + 5 * 60_000 });
    expect(await jobs.failJob(t.db, id, "w", "Http500", "retry", NOW + 5 * 60_000, 0.5)).toBe("retrying");
    const retry = await jobs.getJob(t.db, id);
    expect(retry?.runAfter).toBe(new Date(NOW + 5 * 60_000 + 120_000).toISOString());
    await jobs.leaseJobs(t.db, { kinds: ["fetch"], max: 1, leaseMs: 1000, owner: "w", now: NOW + 10 * 60_000 });
    expect(await jobs.failJob(t.db, id, "w", "Http500", "retry", NOW + 10 * 60_000, 0.5)).toBe("dead");
  });

  it("re-leases a job whose lease expired", async () => {
    await jobs.enqueueJob(t.db, { kind: "fetch", idempotencyKey: "y" }, NOW);
    await jobs.leaseJobs(t.db, { kinds: ["fetch"], max: 1, leaseMs: 1000, owner: "crashed", now: NOW });
    const again = await jobs.leaseJobs(t.db, { kinds: ["fetch"], max: 1, leaseMs: 1000, owner: "w", now: NOW + 2000 });
    expect(again[0]?.leaseOwner).toBe("w");
    expect(again[0]?.attempts).toBe(2);
  });

  it("nonces reject replays; heartbeats and flags upsert", async () => {
    expect(await jobs.useNonce(t.db, "n1", "k1", NOW + 600_000)).toBe(true);
    expect(await jobs.useNonce(t.db, "n1", "k1", NOW + 600_000)).toBe(false);
    await jobs.sweepNonces(t.db, NOW + 700_000);
    expect(await jobs.useNonce(t.db, "n1", "k1", NOW + 1_300_000)).toBe(true);
    await jobs.heartbeat(t.db, "tick", NOW);
    await jobs.heartbeat(t.db, "tick", NOW + 5);
    expect((await jobs.getHeartbeat(t.db, "tick"))?.lastSeenAt).toBe(NOW + 5);
    await jobs.setFlag(t.db, "site.read_only", false, NOW);
    expect(await jobs.getFlags(t.db)).toEqual({ "site.read_only": false });
  });
});

describe("review tasks and audit", () => {
  it("dedupes live tasks, merging reasons and keeping the higher priority", async () => {
    const t = await seededDb();
    const subject = { type: "program_cycle" as const, id: sampleIds.cycle("sample-reu-site-ecology") };
    const a = await review.createReviewTask(t.db, { kind: "cycle_update", subject, reasonCodes: ["key_change"], evidence: [], priority: 5, dueAt: null }, NOW);
    const b = await review.createReviewTask(t.db, { kind: "cycle_update", subject, reasonCodes: ["quote_missing"], evidence: [], priority: 2, dueAt: "2026-11-12T00:00:00Z" }, NOW);
    expect(a.ok && b.ok && a.value.id === b.value.id).toBe(true);
    const queue = await review.listReviewQueue(t.db, NOW);
    expect(queue).toHaveLength(1);
    const task = review.toReviewTask(queue[0]!, new Map());
    expect(ReviewTaskSchema.safeParse(task).success).toBe(true);
    expect(task).toMatchObject({ priority: 2, reasonCodes: ["key_change", "quote_missing"], dueAt: "2026-11-12T00:00:00.000Z" });

    const curator = sampleIds.curator();
    expect((await review.claimReviewTask(t.db, task.id, curator, NOW)).ok).toBe(true);
    expect((await review.resolveReviewTask(t.db, task.id, curator, "approve", "ok", NOW, 30)).ok).toBe(true);
    // Resolved tasks free the dedupe key.
    const c = await review.createReviewTask(t.db, { kind: "cycle_update", subject, reasonCodes: ["key_change"], evidence: [], priority: 5, dueAt: null }, NOW);
    expect(c.ok && c.value.created).toBe(true);
  });

  it("appends access audit entries with field names only and supports tombstones", async () => {
    const t = await freshDb();
    await audit.appendAccessAudit(t.db, { at: NOW, actor: { kind: "user", ref: "self" }, action: "export", purpose: "account export", fields: ["classYear"], subjectKey: "hmac:abc" });
    expect((await audit.listAccessAuditForSubject(t.db, "hmac:abc"))[0]).toMatchObject({ log: "access", fields: ["classYear"], action: "export" });
    await audit.tombstoneAccessAudit(t.db, "hmac:abc", "t1");
    expect(await audit.listAccessAuditForSubject(t.db, "hmac:abc")).toEqual([]);
  });
});

describe("alerts and notifications", () => {
  it("fans out idempotently, serves an inbox and queues one notification per channel", async () => {
    const t = await seededDb();
    const user = await createUser(t.db);
    const cycle = sampleIds.cycle("sample-sprinternship");
    t.raw.exec(`INSERT INTO tracker_items (id, user_id, program_cycle_id, created_at, updated_at) VALUES ('ti', '${user}', '${cycle}', 1, 1)`);
    const recipients = await notifications.recipientsForCycle(t.db, cycle);
    expect(recipients.map((r) => r.recipientKey)).toEqual([`u:${user}`]);
    const alert = { type: "deadline.changed" as const, userId: user, programCycleId: cycle, dedupeKey: "ce1:deadline.changed", title: "Deadline moved", body: "Sample", scheduledFor: NOW };
    await notifications.insertAlerts(t.db, [alert], NOW);
    await notifications.insertAlerts(t.db, [alert], NOW);
    const inbox = await notifications.listInbox(t.db, user, NOW, { limit: 10 });
    expect(inbox).toHaveLength(1);
    expect(InboxItemSchema.safeParse(inbox[0]).success).toBe(true);
    expect(await notifications.unreadCount(t.db, user, NOW)).toBe(1);
    const awaiting = await notifications.alertsAwaitingNotification(t.db, NOW, "email", 10);
    expect(awaiting).toHaveLength(1);
    await notifications.queueNotifications(t.db, [{ alertId: inbox[0]!.id, channel: "email", expiresAt: NOW + 86_400_000 }], NOW);
    await notifications.queueNotifications(t.db, [{ alertId: inbox[0]!.id, channel: "email", expiresAt: NOW + 86_400_000 }], NOW);
    expect(await notifications.alertsAwaitingNotification(t.db, NOW, "email", 10)).toEqual([]);
    const due = await notifications.dueNotifications(t.db, NOW, 10);
    expect(due).toHaveLength(1);
    expect(due[0]?.userEmail).toMatch(/@example\.org$/);
    await notifications.markNotification(t.db, due[0]!.notification.id, "sent", NOW);
    expect(await notifications.dueNotifications(t.db, NOW, 10)).toEqual([]);
    expect(await notifications.markAlertRead(t.db, user, inbox[0]!.id, NOW)).toBe(true);
  });

  it("Remind-me for an identity-audience program needs consent; normal programs work", async () => {
    const t = await seededDb();
    const contact = await notifications.upsertContact(t.db, { email: "x@example.org", emailHmac: "h1", hmacKeyId: "k1", deleteAfter: NOW + 7 * 86_400_000 }, NOW);
    expect(await notifications.upsertContact(t.db, { email: "x@example.org", emailHmac: "h1", hmacKeyId: "k1", deleteAfter: NOW }, NOW)).toBe(contact);
    const ok = await notifications.subscribe(t.db, { contactId: contact, kind: "remind_me", programCycleId: sampleIds.cycle("sample-reu-site-ecology") }, NOW);
    expect(ok.ok).toBe(true);
    const refused = await notifications.subscribe(t.db, { contactId: contact, kind: "remind_me", programCycleId: sampleIds.cycle("sample-women-in-computing-cohort") }, NOW);
    expect(refused).toMatchObject({ ok: false, error: "consent_required" });
    // Unconfirmed contacts receive nothing but the confirmation.
    expect(await notifications.recipientsForCycle(t.db, sampleIds.cycle("sample-reu-site-ecology"))).toEqual([]);
    await notifications.confirmContact(t.db, contact, NOW, null);
    expect((await notifications.recipientsForCycle(t.db, sampleIds.cycle("sample-reu-site-ecology"))).map((r) => r.recipientKey)).toEqual([`c:${contact}`]);
  });

  it("calendar feeds rotate and email action tokens are single use", async () => {
    const t = await seededDb();
    const user = await createUser(t.db);
    await notifications.createCalendarFeed(t.db, user, "hash-a", false, NOW);
    await notifications.rotateCalendarFeed(t.db, user, "hash-b", true, NOW + 1);
    expect(await notifications.findCalendarFeed(t.db, "hash-a")).toBeNull();
    expect((await notifications.findCalendarFeed(t.db, "hash-b"))?.neutralTitles).toBe(true);
    t.raw.exec(`INSERT INTO tracker_items (id, user_id, program_cycle_id, created_at, updated_at) VALUES ('ti', '${user}', '${sampleIds.cycle("sample-sprinternship")}', 1, 1)`);
    await notifications.createEmailActionToken(t.db, { tokenHash: "tok", userId: user, trackerItemId: "ti", action: "mark_submitted", expiresAt: NOW + 1000 }, NOW);
    expect((await notifications.consumeEmailActionToken(t.db, "tok", NOW))?.action).toBe("mark_submitted");
    expect(await notifications.consumeEmailActionToken(t.db, "tok", NOW)).toBeNull();
  });
});

describe("novus-events", () => {
  it("drops events with sensitive-looking properties and counts program days", async () => {
    const { edb, raw } = await freshEventsDb();
    const n = await events.recordAnalyticsEvents(
      edb,
      [
        { name: "page_view", deviceId: "dev_1234567890abcdef", at: NOW, path: "/", props: { theme: "ember" } },
        { name: "filter_change", deviceId: "dev_1234567890abcdef", at: NOW, path: "/", props: { citizenship: "x" } },
      ],
      NOW,
    );
    expect(n).toBe(1);
    await events.incrementProgramDailyCount(edb, "p1", "2026-11-11", "program_view");
    await events.incrementProgramDailyCount(edb, "p1", "2026-11-11", "program_view");
    expect(raw.query<{ n: number }>("SELECT n FROM program_daily_counts")[0]?.n).toBe(2);
  });

  it("reserves LLM budget up to the cap and settles at actual cost", async () => {
    const { edb } = await freshEventsDb();
    const base = { routeId: "readiness.explain", budgetClass: "student", month: "2026-11", capMicros: 1000, ttlMs: 60_000 };
    const r1 = await events.reserveLlmBudget(edb, { ...base, idempotencyKey: "r1", estimateMicros: 600 }, NOW);
    expect(r1).not.toBeNull();
    expect(await events.reserveLlmBudget(edb, { ...base, idempotencyKey: "r2", estimateMicros: 600 }, NOW)).toBeNull();
    expect(await events.reserveLlmBudget(edb, { ...base, idempotencyKey: "r1", estimateMicros: 600 }, NOW)).toBe(r1);
    await events.settleLlmReservation(edb, r1 as string, "2026-11", 100);
    expect((await events.llmSpend(edb, "2026-11"))[0]).toMatchObject({ reservedMicros: 0, settledMicros: 100 });
    expect(await events.reserveLlmBudget(edb, { ...base, idempotencyKey: "r3", estimateMicros: 800 }, NOW)).not.toBeNull();
    await events.appendEmailLedger(edb, { notificationId: "n1", stream: "transactional", outcome: "sent" }, NOW);
    expect(await events.emailsSentSince(edb, NOW - 1)).toBe(1);
    await events.recordLlmCall(edb, { routeId: "readiness.explain", routeVersion: "1", modelRequested: "gemini-model", status: "ok", inputTokens: 10, outputTokens: 5, costMicros: 3 }, NOW);
  });
});
