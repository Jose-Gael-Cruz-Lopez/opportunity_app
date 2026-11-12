import { eq, ne } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { findSensitiveKeys } from "@shared/contracts/sensitive";
import * as s from "@server/db/schema";
import { freshEventsDb, seededDb } from "@server/db/testing/fixtures";
import { Budget } from "@server/jobs/budget";
import { silentLogger } from "@server/jobs/types";
import { createDryRunProvider, dispatchNotifications, emailLookupHmac } from "@server/services/email";
import { notifications } from "@server/db/repos";
import { loadAudience } from "@server/services/reminders/store";
import { applyUnsubscribe } from "@server/services/email/unsubscribe";
import type { UnsubscribeClaims } from "@server/services/email/tokens";
import { createRemindLinkRoutes, createRemindRoutes, type RemindBindings } from "./index";
import { adultFrom, ageInYears, confirmationCopy, networkOf } from "./service";
import { signConfirmToken, verifyConfirmToken } from "./token";

// Cloudflare's published Turnstile test secrets (always pass / always fail); no real keys here.
const PASS_SECRET = "1x0000000000000000000000000000000AA";
const FAIL_SECRET = "2x0000000000000000000000000000000AA";
// Test-only root secret: synthetic.
const SECRET = "test-only-root-secret-0123456789abcdef0123";
const NOW = Date.UTC(2026, 10, 11, 15, 0);
const HOUR = 3_600_000;

/** Stands in for siteverify: the test secrets behave as Cloudflare documents. */
const siteverify = async (_url: string, init: RequestInit) => {
  const secret = (init.body as FormData).get("secret");
  if (secret === PASS_SECRET) return Response.json({ success: true });
  return Response.json({ success: false, "error-codes": ["invalid-input-response"] });
};

async function setup(program = "Sample Job Shadow Week") {
  const t = await seededDb();
  const [cycle] = await t.db
    .select({ id: s.programCycles.id })
    .from(s.programCycles)
    .innerJoin(s.programs, eq(s.programs.id, s.programCycles.programId))
    .innerJoin(s.deadlines, eq(s.deadlines.programCycleId, s.programCycles.id))
    .where(eq(s.programs.name, program))
    .limit(1);
  if (!cycle) throw new Error("seed is missing the sample program");
  let clock = NOW;
  const app = createRemindRoutes({ now: () => clock, fetch: siteverify });
  const links = createRemindLinkRoutes({ now: () => clock });
  const env = (over: Partial<RemindBindings> = {}): RemindBindings => ({ DB: t.raw.d1, BETTER_AUTH_SECRET: SECRET, TURNSTILE_SECRET_KEY: PASS_SECRET, ...over });
  const post = (body: Record<string, unknown>, over: Partial<RemindBindings> = {}, ip = "203.0.113.9") =>
    app.request(
      "/remind-me",
      { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ turnstileToken: "XXXX.DUMMY.TOKEN.XXXX", programCycleId: cycle.id, birthYearMonth: "2004-03", ...body }) },
      env(over),
    );
  return { ...t, cycleId: cycle.id, post, links, env, setClock: (ms: number) => (clock = ms) };
}

const confirmations = async (t: Awaited<ReturnType<typeof setup>>) => t.db.select().from(s.alerts).where(eq(s.alerts.type, "contact.confirmation"));

describe("POST /api/v1/remind-me", () => {
  it("accepts a request, stores the contact and queues one confirmation email, but no subscription yet", async () => {
    const t = await setup();
    const res = await t.post({ email: "Visitor@Example.net" });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "pending_confirmation" });
    expect(res.headers.get("cache-control")).toBe("no-store");

    const [contact] = await t.db.select().from(s.contacts);
    expect(contact).toMatchObject({ email: "visitor@example.net", confirmedAt: null, deleteAfter: NOW + 7 * 24 * HOUR, minorUntil: null });
    const lookup = await emailLookupHmac(SECRET, "visitor@example.net");
    expect(contact!.emailHmac).toBe(lookup.hmac);
    // Nothing is subscribed and no consent exists until the address owner confirms.
    expect(await t.db.select().from(s.subscriptions)).toHaveLength(0);
    expect(await t.db.select().from(s.consents)).toHaveLength(0);
    const [alert] = await confirmations(t);
    expect(alert).toMatchObject({ contactId: contact!.id, priority: "p0", programCycleId: t.cycleId });
    expect(alert!.href).toMatch(/^\/e\/rc\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(alert!.body).toContain("Sample Job Shadow Week");

    // Unconfirmed contacts get nothing but the confirmation.
    expect(await loadAudience(t.db)).toHaveLength(0);

    // notify.dispatch sends it as essential mail with the absolute confirmation link.
    const provider = createDryRunProvider();
    const { edb } = await freshEventsDb();
    await dispatchNotifications({ db: t.db, edb, provider, appOrigin: "https://novus.example.org", secret: SECRET, now: () => NOW + 60_000, budget: new Budget({ ms: 60_000, calls: 900 }, () => NOW), log: silentLogger });
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.to).toBe("visitor@example.net");
    expect(provider.sent[0]!.text).toContain(`https://novus.example.org${alert!.href}`);
  });

  it("sends at most one confirmation per address per day and says the same thing every time", async () => {
    const t = await setup();
    expect((await t.post({ email: "visitor@example.net" })).status).toBe(202);
    t.setClock(NOW + HOUR);
    const again = await t.post({ email: "visitor@example.net" });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ status: "pending_confirmation" });
    expect(await confirmations(t)).toHaveLength(1);
    t.setClock(NOW + 25 * HOUR);
    await t.post({ email: "visitor@example.net" });
    expect(await confirmations(t)).toHaveLength(2);
  });

  it("verifies Turnstile on every request and fails closed", async () => {
    const t = await setup();
    expect((await t.post({ email: "a@example.net" }, { TURNSTILE_SECRET_KEY: FAIL_SECRET })).status).toBe(403);
    expect((await t.post({ email: "a@example.net" }, { TURNSTILE_SECRET_KEY: undefined })).status).toBe(503);
    const outage = createRemindRoutes({ now: () => NOW, fetch: async () => new Response("down", { status: 502 }) });
    const res = await outage.request(
      "/remind-me",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@example.net", programCycleId: t.cycleId, turnstileToken: "tok", birthYearMonth: "2004-03" }) },
      t.env(),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await t.db.select().from(s.contacts)).toHaveLength(0);
  });

  it("validates the body and answers 404 for an unknown cycle", async () => {
    const t = await setup();
    expect((await t.post({ email: "not-an-address" })).status).toBe(400);
    expect((await t.post({ email: "a@example.net", extra: 1 })).status).toBe(400);
    expect((await t.post({ email: "a@example.net", programCycleId: "0190a0a0-0000-7000-8000-000000000999" })).status).toBe(404);
    expect(await t.db.select().from(s.contacts)).toHaveLength(0);
  });

  it("stores nothing for visitors under 16 and requires the age screen", async () => {
    const t = await setup();
    const res = await t.post({ email: "young@example.net", birthYearMonth: "2011-06" });
    expect(res.status).toBe(400);
    expect(await t.db.select().from(s.contacts)).toHaveLength(0);
    // Leaving the field out is not a way around the screen.
    expect((await t.post({ email: "young@example.net", birthYearMonth: undefined })).status).toBe(400);
    expect(await t.db.select().from(s.contacts)).toHaveLength(0);
    expect((await t.post({ email: "older@example.net", birthYearMonth: "2004-06" })).status).toBe(202);
    expect((await t.db.select().from(s.contacts))[0]?.minorUntil).toBeNull();
  });

  it("sets minor mode on the contact for ages 16-17 until they can be 18", async () => {
    const t = await setup();
    expect((await t.post({ email: "teen@example.net", birthYearMonth: "2009-06" })).status).toBe(202);
    const [contact] = await t.db.select().from(s.contacts);
    expect(contact?.minorUntil).toBe(Date.UTC(2027, 6, 1));
    expect(adultFrom("2009-06")).toBe(Date.UTC(2027, 6, 1));
    expect(ageInYears("2009-06", Date.UTC(2027, 6, 1))).toBe(18);
    expect(ageInYears("2009-06", Date.UTC(2027, 6, 1) - 1)).toBe(17);
  });

  it("limits each network to 10 requests an hour", async () => {
    const t = await setup();
    for (let i = 0; i < 10; i++) expect((await t.post({ email: `v${i}@example.net` }, {}, "198.51.100.7")).status).toBe(202);
    const limited = await t.post({ email: "v10@example.net" }, {}, "198.51.100.99");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await t.post({ email: "v11@example.net" }, {}, "192.0.2.1")).status).toBe(202);
  });

  it("gives suppressed addresses the same answer and writes nothing", async () => {
    const t = await setup();
    const h = await emailLookupHmac(SECRET, "bounced@example.net");
    await notifications.suppressEmail(t.db, h.hmac, h.keyId, "bounce", 1);
    const res = await t.post({ email: "bounced@example.net" });
    expect(res.status).toBe(202);
    expect(await t.db.select().from(s.contacts)).toHaveLength(0);
  });

  it("needs the opt-in and a published consent text for status-defined programs, records consent only at confirmation, and keeps copy neutral", async () => {
    const t = await setup("Sample PhD Pathway Program");
    expect((await t.post({ email: "a@example.net" })).status).toBe(409);
    expect((await t.post({ email: "a@example.net", sensitiveOptIn: true })).status).toBe(409); // no consent text yet
    t.raw.exec("INSERT INTO consent_texts (version, kind, text_sha256, published_at) VALUES ('st-1', 'sensitive_tracking', 'x', 1)");
    expect((await t.post({ email: "a@example.net", sensitiveOptIn: true })).status).toBe(202);
    // The request (which anyone can make for any address) writes no consent and no subscription.
    expect(await t.db.select().from(s.consents)).toHaveLength(0);
    expect(await t.db.select().from(s.subscriptions)).toHaveLength(0);
    const [alert] = await confirmations(t);
    expect(`${alert?.title} ${alert?.body}`).not.toContain("PhD Pathway");

    const view = await (await t.links.request(alert!.href as string, {}, t.env())).text();
    expect(view).not.toContain("PhD Pathway");
    expect(view).toContain("records your consent");
    expect((await t.links.request(alert!.href as string, { method: "POST" }, t.env())).status).toBe(200);
    const [consent] = await t.db.select().from(s.consents);
    expect(consent).toMatchObject({ kind: "sensitive_tracking", textVersion: "st-1", method: "email_link", scopeType: "program" });
    const [sub] = await t.db.select().from(s.subscriptions);
    expect(sub).toMatchObject({ programCycleId: t.cycleId, nameInMessages: false, deleteAfter: null });
  });

  it("does not trip the sensitive-key guard", () => {
    expect(findSensitiveKeys({ email: "a@example.net", programCycleId: "x", turnstileToken: "t", sensitiveOptIn: true, birthYearMonth: "2008-01" })).toEqual([]);
  });
});

describe("confirmation link /e/rc/:token", () => {
  it("GET lists the program and changes nothing; POST confirms the contact and creates that one subscription", async () => {
    const t = await setup();
    await t.post({ email: "visitor@example.net" });
    const [alert] = await confirmations(t);
    const path = alert!.href as string;

    const view = await t.links.request(path, {}, t.env());
    expect(view.status).toBe(200);
    expect(view.headers.get("cache-control")).toBe("no-store");
    const html = await view.text();
    expect(html).toContain('method="post"');
    expect(html).toContain("Sample Job Shadow Week");
    expect((await t.db.select().from(s.contacts))[0]?.confirmedAt).toBeNull();
    expect(await t.db.select().from(s.subscriptions)).toHaveLength(0);

    t.setClock(NOW + HOUR);
    const done = await t.links.request(path, { method: "POST" }, t.env());
    expect(done.status).toBe(200);
    const [contact] = await t.db.select().from(s.contacts);
    expect(contact).toMatchObject({ confirmedAt: NOW + HOUR, deleteAfter: null });
    const subs = await t.db.select().from(s.subscriptions);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({ contactId: contact!.id, programCycleId: t.cycleId, deleteAfter: null, nameInMessages: true });
    expect((await loadAudience(t.db)).map((a) => a.recipientKey)).toEqual([`c:${contact!.id}`]);
    // Idempotent.
    expect((await t.links.request(path, { method: "POST" }, t.env())).status).toBe(200);
    expect(await t.db.select().from(s.subscriptions)).toHaveLength(1);
  });

  it("turns on only the cycle its own request named, never reminders a stranger asked for", async () => {
    const t = await setup();
    const others = await t.db.select({ id: s.programCycles.id }).from(s.programCycles).where(ne(s.programCycles.id, t.cycleId)).limit(3);
    // A stranger asks for other cycles for the victim's address first (one email, the rest capped).
    for (const o of others) expect((await t.post({ email: "victim@example.net", programCycleId: o.id })).status).toBe(202);
    const strangerLinks = (await confirmations(t)).map((a) => a.href);
    expect(strangerLinks).toHaveLength(1);
    // A day later the owner asks for the one program they want: never 429, a fresh link.
    t.setClock(NOW + 25 * HOUR);
    expect((await t.post({ email: "victim@example.net" })).status).toBe(202);
    const own = (await confirmations(t)).find((a) => !strangerLinks.includes(a.href));
    expect(own?.programCycleId).toBe(t.cycleId);
    await t.links.request(own!.href as string, { method: "POST" }, t.env());
    const subs = await t.db.select().from(s.subscriptions);
    expect(subs.map((x) => x.programCycleId)).toEqual([t.cycleId]);
  });

  it("does not alert or remind for cycles the confirmed address never confirmed", async () => {
    const t = await setup();
    await t.post({ email: "visitor@example.net" });
    const [alert] = await confirmations(t);
    await t.links.request(alert!.href as string, { method: "POST" }, t.env());
    const [contact] = await t.db.select().from(s.contacts);
    const [other] = await t.db.select({ id: s.programCycles.id }).from(s.programCycles).where(ne(s.programCycles.id, t.cycleId)).limit(1);
    t.setClock(NOW + 25 * HOUR);
    expect((await t.post({ email: "visitor@example.net", programCycleId: other!.id })).status).toBe(202);
    expect(await notifications.recipientsForCycle(t.db, other!.id)).toEqual([]);
    expect((await notifications.recipientsForCycle(t.db, t.cycleId)).map((r) => r.contactId)).toEqual([contact!.id]);
    // A legacy pending row (delete_after set) is not live either.
    await notifications.subscribe(t.db, { contactId: contact!.id, kind: "remind_me", programCycleId: other!.id, deleteAfter: NOW + 99 * HOUR }, NOW);
    expect(await notifications.recipientsForCycle(t.db, other!.id)).toEqual([]);
  });

  it("refuses forged, expired or old-version tokens", async () => {
    const t = await setup();
    expect((await t.links.request("/e/rc/abc.def", { method: "POST" }, t.env())).status).toBe(404);
    const token = await signConfirmToken(SECRET, "0190a0a0-0000-7000-8000-000000000001", t.cycleId, NOW - 8 * 24 * HOUR);
    expect((await t.links.request(`/e/rc/${token}`, {}, t.env())).status).toBe(404);
    expect(await verifyConfirmToken("another-secret-0123456789abcdef0123456", await signConfirmToken(SECRET, "0190a0a0-0000-7000-8000-000000000001", t.cycleId, NOW), NOW)).toBeNull();
    // A token for a contact that no longer exists confirms nothing.
    const gone = await signConfirmToken(SECRET, "0190a0a0-0000-7000-8000-000000000001", t.cycleId, NOW);
    expect((await t.links.request(`/e/rc/${gone}`, { method: "POST" }, t.env())).status).toBe(404);
    expect(await t.db.select().from(s.subscriptions)).toHaveLength(0);
  });
});

describe("retention", () => {
  it("unsubscribing the last reminder deletes the contact, its consents and alerts", async () => {
    const t = await setup("Sample PhD Pathway Program");
    t.raw.exec("INSERT INTO consent_texts (version, kind, text_sha256, published_at) VALUES ('st-1', 'sensitive_tracking', 'x', 1)");
    await t.post({ email: "a@example.net", sensitiveOptIn: true });
    const [alert] = await confirmations(t);
    await t.links.request(alert!.href as string, { method: "POST" }, t.env());
    const [contact] = await t.db.select().from(s.contacts);
    expect(await t.db.select().from(s.consents)).toHaveLength(1);
    await applyUnsubscribe(t.db, { v: 1, r: `c:${contact!.id}`, l: "cycle_reminders", c: t.cycleId, x: NOW } satisfies UnsubscribeClaims, NOW);
    expect(await t.db.select().from(s.contacts)).toHaveLength(0);
    expect(await t.db.select().from(s.consents)).toHaveLength(0);
    expect(await t.db.select().from(s.alerts)).toHaveLength(0);
  });

  it("the sweep removes confirmed reminders 30 days after their cycle closes, then the contact", async () => {
    const t = await setup();
    await t.post({ email: "visitor@example.net" });
    const [alert] = await confirmations(t);
    await t.links.request(alert!.href as string, { method: "POST" }, t.env());
    await notifications.sweepExpiredContacts(t.db, NOW + HOUR);
    expect(await t.db.select().from(s.subscriptions)).toHaveLength(1);
    t.raw.exec(`UPDATE program_cycles SET status = 'closed', status_changed_at = ${NOW + 2 * HOUR} WHERE id = '${t.cycleId}'`);
    await notifications.sweepExpiredContacts(t.db, NOW + 2 * HOUR + 29 * 24 * HOUR);
    expect(await t.db.select().from(s.subscriptions)).toHaveLength(1);
    await notifications.sweepExpiredContacts(t.db, NOW + 2 * HOUR + 30 * 24 * HOUR);
    expect(await t.db.select().from(s.subscriptions)).toHaveLength(0);
    expect(await t.db.select().from(s.contacts)).toHaveLength(0);
    expect(await t.db.select().from(s.alerts)).toHaveLength(0);
  });

  it("the sweep removes a confirmed reminder 30 days after its last deadline, even while the cycle is open", async () => {
    const t = await setup(); // Sample Job Shadow Week: last live deadline 23 Nov 2026
    await t.post({ email: "visitor@example.net" });
    const [alert] = await confirmations(t);
    await t.links.request(alert!.href as string, { method: "POST" }, t.env());
    const last = await t.db.select({ localDate: s.deadlines.localDate }).from(s.deadlines).where(eq(s.deadlines.programCycleId, t.cycleId));
    const latest = last.map((d) => d.localDate ?? "").sort().at(-1)!;
    const dayAfter = (iso: string, days: number) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) + days * 24 * HOUR;
    await notifications.sweepExpiredContacts(t.db, dayAfter(latest, 30));
    expect(await t.db.select().from(s.subscriptions)).toHaveLength(1);
    await notifications.sweepExpiredContacts(t.db, dayAfter(latest, 32));
    expect(await t.db.select().from(s.subscriptions)).toHaveLength(0);
    expect(await t.db.select().from(s.contacts)).toHaveLength(0);
  });

  it("the sweep keeps a confirmed contact asking again while its new link is live", async () => {
    const t = await setup();
    await t.post({ email: "visitor@example.net" });
    const [alert] = await confirmations(t);
    await t.links.request(alert!.href as string, { method: "POST" }, t.env());
    const [contact] = await t.db.select().from(s.contacts);
    await applyUnsubscribe(t.db, { v: 1, r: `c:${contact!.id}`, l: "weekly", x: NOW } satisfies UnsubscribeClaims, NOW);
    expect(await t.db.select().from(s.contacts)).toHaveLength(0);
    t.setClock(NOW + 25 * HOUR);
    await t.post({ email: "visitor@example.net" });
    await notifications.sweepExpiredContacts(t.db, NOW + 26 * HOUR);
    expect(await t.db.select().from(s.contacts)).toHaveLength(1);
  });
});

describe("helpers", () => {
  it("keys networks by IPv4 /24 and IPv6 /64", () => {
    expect(networkOf("203.0.113.9")).toBe("203.0.113.0/24");
    expect(networkOf("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(networkOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(networkOf("unknown")).toBe("unknown");
  });

  it("reads age conservatively from a birth month", () => {
    expect(ageInYears("2010-11", NOW)).toBe(15);
    expect(ageInYears("2010-10", NOW)).toBe(16);
  });

  it("adds the campus warning for nomination-gated programs", () => {
    const copy = confirmationCopy({ programName: "Sample National STEM Scholarship", termLabel: "2027", isSample: true, sensitiveAudience: false, identityAudience: [], nominationGated: true });
    expect(copy.body).toContain("Campus deadlines for this program come weeks before the national one");
    expect(copy.body).toContain("[sample listing]");
  });
});
