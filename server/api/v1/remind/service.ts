import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { RemindMeRequestSchema } from "@shared/contracts/student";
import type { Db } from "@server/db/client";
import { uuidv7 } from "@server/db/columns";
import { notifications, registry } from "@server/db/repos";
import { isConsentRequired, runBatch, type Stmt } from "@server/db/repos/common";
import * as s from "@server/db/schema";
import { deriveSubkey, hmacSha256Hex } from "@server/internal/crypto";
import { consumeD1Window, type WindowRule } from "@server/lib/rate-limit";
import { DEFAULT_DAILY_QUOTA, utcDayStart } from "@server/services/email/policy";
import { readDailyQuota } from "@server/services/email/store";
import { emailLookupHmac } from "@server/services/email/tokens";
import { CONFIRM_TTL_MS, confirmPath, signConfirmToken } from "./token";

/**
 * Remind me (plan 6.7.1, s01 F-08): an email-only Subscription to one ProgramCycle for a visitor
 * without an account, created only when the address owner confirms it. Abuse limits (plan 6.7.1):
 * - Turnstile on every request, failing closed (the route checks it before this module runs);
 * - per network: 10 requests an hour (IPv4 /24, IPv6 /64), keyed by an HMAC, never the address;
 * - per address: at most 1 confirmation per 24 hours and 3 per 30 days;
 * - confirmation sends capped at 10% of the provider's daily quota;
 * - suppressed (bounced or complained) addresses get nothing; unconfirmed contacts go after 7 days.
 * A request stores only the Contact and its confirmation email. The emailed link names the one
 * cycle that request asked for; confirming creates that subscription and, for status- or
 * identity-defined programs, records the consent then, from the address owner's own click. So a
 * stranger who types someone's address can neither turn on other reminders nor plant a consent.
 * Answers never reveal whether an address is known, confirmed or suppressed.
 */

const DAY = 86_400_000;

/**
 * The shared contract, with `birthYearMonth` (the age screen, required) narrowed to a real month
 * 01-12 so ageInYears never sees an out-of-range value.
 */
export const RemindMeBodySchema = RemindMeRequestSchema.extend({
  birthYearMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
});
export type RemindMeBody = z.infer<typeof RemindMeBodySchema>;

export const IP_RULE: WindowRule = { limit: 10, windowMs: 3_600_000 };
export const CONFIRMATIONS_PER_DAY = 1;
export const CONFIRMATIONS_PER_30_DAYS = 3;
/** Share of the daily send quota confirmations may use (plan 6.7.1). */
export const CONFIRMATION_QUOTA_SHARE = 0.1;
export const MIN_AGE_YEARS = 16;
export const ADULT_AGE_YEARS = 18;

/** The network an address belongs to for rate limiting: IPv4 /24, IPv6 /64. */
export function networkOf(ip: string): string {
  if (ip.includes(":")) {
    const [head = "", tail = ""] = ip.split("::");
    const h = head.split(":").filter(Boolean);
    const t = ip.includes("::") ? tail.split(":").filter(Boolean) : [];
    const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t].slice(0, 4);
    if (groups.length < 4 || groups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return "unknown";
    return `${groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
  }
  const octets = ip.split(".");
  if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o))) return "unknown";
  return `${octets.slice(0, 3).join(".")}.0/24`;
}

/** Per-network window in D1, keyed by an HMAC of the network so no address is stored. */
export async function consumeNetworkLimit(db: Db, secret: string, ip: string, now: number) {
  const key = await deriveSubkey(secret, "remind-ip-v1");
  return consumeD1Window(db, `remind:ip:${(await hmacSha256Hex(key, networkOf(ip))).slice(0, 32)}`, IP_RULE, now);
}

/** Whole years between a `YYYY-MM` birth month and now (the youngest reading of that month). */
export function ageInYears(birthYearMonth: string, now: number): number {
  const [y, m] = birthYearMonth.split("-").map(Number) as [number, number];
  const d = new Date(now);
  let age = d.getUTCFullYear() - y;
  // Born in month m: treat the birthday as the last day of that month (never over-age anyone).
  if (d.getUTCMonth() + 1 <= m) age -= 1;
  return age;
}

export type RemindOutcome =
  | { readonly kind: "accepted"; readonly confirmationQueued: boolean }
  | { readonly kind: "not_found" }
  | { readonly kind: "under_age" }
  | { readonly kind: "consent_required" };

/**
 * The first instant someone born in `birthYearMonth` can be 18 (the youngest reading of that
 * month, as in ageInYears): the start of the month after the birth month, 18 years on.
 */
export function adultFrom(birthYearMonth: string): number {
  const [y, m] = birthYearMonth.split("-").map(Number) as [number, number];
  return Date.UTC(y + 18, m, 1);
}

interface CycleRow {
  readonly cycleId: string;
  readonly programId: string;
  readonly programName: string;
  readonly termLabel: string;
  readonly isSample: boolean;
  readonly sensitiveAudience: boolean;
  readonly identityAudience: readonly string[];
  readonly nominationGated: boolean;
}

async function publishedCycle(db: Db, cycleId: string): Promise<CycleRow | null> {
  const ctx = await registry.getCycleContext(db, cycleId);
  if (!ctx || !ctx.program.isPublished) return null;
  const [nomDeadline, nomReq] = await db.batch([
    db.select({ id: s.deadlines.id }).from(s.deadlines).where(and(eq(s.deadlines.programCycleId, cycleId), eq(s.deadlines.kind, "nomination"), isNull(s.deadlines.withdrawnAt))).limit(1),
    db.select({ id: s.requirements.id }).from(s.requirements).where(and(eq(s.requirements.programCycleId, cycleId), eq(s.requirements.kind, "campus_nomination"), isNull(s.requirements.withdrawnAt))).limit(1),
  ]);
  return {
    cycleId,
    programId: ctx.program.id,
    programName: ctx.program.name,
    termLabel: ctx.cycle.termLabel,
    isSample: ctx.program.isSample,
    sensitiveAudience: ctx.program.sensitiveAudience,
    identityAudience: ctx.program.identityAudience,
    nominationGated: nomDeadline.length > 0 || nomReq.length > 0,
  };
}

/** The newest published consent text of a kind; null means the consent cannot be recorded yet. */
async function latestConsentText(db: Db, kind: "sensitive_tracking" | "identity_tracking"): Promise<string | null> {
  const row = await db.select({ version: s.consentTexts.version }).from(s.consentTexts).where(eq(s.consentTexts.kind, kind)).orderBy(desc(s.consentTexts.publishedAt)).limit(1);
  return row[0]?.version ?? null;
}

async function countConfirmations(db: Db, where: ReturnType<typeof and>): Promise<number> {
  const rows = await db.select({ n: sql<number>`count(*)` }).from(s.alerts).where(where);
  return Number(rows[0]?.n ?? 0);
}

/** Copy for the confirmation email; neutral for status- or identity-defined programs. */
export function confirmationCopy(cycle: Pick<CycleRow, "programName" | "termLabel" | "isSample" | "sensitiveAudience" | "identityAudience" | "nominationGated">) {
  const neutral = cycle.sensitiveAudience || cycle.identityAudience.length > 0;
  const name = neutral ? "a program you chose on Novus" : `${cycle.programName} (${cycle.termLabel})${cycle.isSample ? " [sample listing]" : ""}`;
  const lines = [
    `Confirm that you want deadline reminders from Novus for ${name}.`,
    "You will get an email 2 days before each deadline, a weekly list of dates in the next two weeks, and an email if a date changes.",
    !neutral && cycle.nominationGated
      ? "Campus deadlines for this program come weeks before the national one and may already have passed: contact your fellowship office today."
      : null,
    "If you did not ask for this, ignore this email: no reminder is turned on, and an address with no confirmed reminders is deleted after 7 days.",
  ].filter((l): l is string => l !== null);
  return { title: "Confirm your Novus reminders", body: lines.join(" ").slice(0, 1000) };
}

export interface RemindRequestInput {
  readonly body: RemindMeBody;
  readonly secret: string;
  readonly now: number;
}

/** Status- and identity-defined programs: the consents a Remind-me subscription needs. */
async function neededConsents(db: Db, cycle: CycleRow): Promise<{ ok: true; sensitive: string | null; identity: string | null } | { ok: false }> {
  // Health-defined programs have no server option at all.
  if (cycle.identityAudience.includes("health")) return { ok: false };
  const sensitive = cycle.sensitiveAudience ? await latestConsentText(db, "sensitive_tracking") : null;
  const identity = cycle.identityAudience.length > 0 ? await latestConsentText(db, "identity_tracking") : null;
  if ((cycle.sensitiveAudience && !sensitive) || (cycle.identityAudience.length > 0 && !identity)) return { ok: false };
  return { ok: true, sensitive, identity };
}

/**
 * Records a Remind-me request after Turnstile and the network limit have passed. Writes nothing
 * for unknown cycles, under-16 visitors, missing opt-in or consent text, or suppressed addresses.
 * Otherwise it keeps the Contact (7 days unless confirmed) and queues one confirmation email for
 * this cycle; no subscription and no consent exist until the owner confirms.
 */
export async function requestReminder(db: Db, input: RemindRequestInput): Promise<RemindOutcome> {
  const { body, secret, now } = input;
  const age = ageInYears(body.birthYearMonth, now);
  if (age < MIN_AGE_YEARS) return { kind: "under_age" };
  const cycle = await publishedCycle(db, body.programCycleId);
  if (!cycle) return { kind: "not_found" };

  // Status- and identity-defined programs (plan 6.7.6): only with the opt-in shown with the form
  // and a published consent text to record at confirmation.
  if (cycle.sensitiveAudience || cycle.identityAudience.length > 0) {
    if (!body.sensitiveOptIn) return { kind: "consent_required" };
    if (!(await neededConsents(db, cycle)).ok) return { kind: "consent_required" };
  }

  const email = body.email.trim().toLowerCase();
  const lookup = await emailLookupHmac(secret, email);
  if (await notifications.isSuppressed(db, [lookup])) return { kind: "accepted", confirmationQueued: false };
  const contactId = await notifications.upsertContact(db, { email, emailHmac: lookup.hmac, hmacKeyId: lookup.keyId, deleteAfter: now + CONFIRM_TTL_MS }, now);

  const [live, same] = await db.batch([
    db.select({ id: s.subscriptions.id }).from(s.subscriptions).where(and(eq(s.subscriptions.contactId, contactId), isNull(s.subscriptions.deleteAfter))).limit(1),
    db
      .select({ id: s.subscriptions.id })
      .from(s.subscriptions)
      .where(and(eq(s.subscriptions.contactId, contactId), eq(s.subscriptions.kind, "remind_me"), eq(s.subscriptions.programCycleId, cycle.cycleId)))
      .limit(1),
  ]);
  // A Contact with nothing live (unconfirmed, or every subscription gone) is kept for 7 days from
  // this request, like its new link; a confirmed Contact with live subscriptions keeps no expiry.
  if (live.length === 0) {
    await db
      .update(s.contacts)
      .set({ deleteAfter: sql`max(coalesce(${s.contacts.deleteAfter}, 0), ${now + CONFIRM_TTL_MS})` })
      .where(and(eq(s.contacts.id, contactId), isNull(s.contacts.userId)));
  }
  // Ages 16-17: minor mode until the visitor can be 18 (never shortened by a later request).
  if (age < ADULT_AGE_YEARS) {
    await db
      .update(s.contacts)
      .set({ minorUntil: sql`max(coalesce(${s.contacts.minorUntil}, 0), ${adultFrom(body.birthYearMonth)})` })
      .where(eq(s.contacts.id, contactId));
  }
  if (same.length > 0) return { kind: "accepted", confirmationQueued: false };

  // Confirmation limits: per address (24 hours, 30 days) and 10% of the day's provider quota.
  const isConfirmation = and(eq(s.alerts.type, "contact.confirmation"), eq(s.alerts.contactId, contactId));
  const [day, month] = await Promise.all([
    countConfirmations(db, and(isConfirmation, sql`${s.alerts.createdAt} > ${now - DAY}`)),
    countConfirmations(db, and(isConfirmation, sql`${s.alerts.createdAt} > ${now - 30 * DAY}`)),
  ]);
  if (day >= CONFIRMATIONS_PER_DAY || month >= CONFIRMATIONS_PER_30_DAYS) return { kind: "accepted", confirmationQueued: false };
  const quota = (await readDailyQuota(db)) ?? DEFAULT_DAILY_QUOTA;
  const today = await countConfirmations(db, and(eq(s.alerts.type, "contact.confirmation"), sql`${s.alerts.createdAt} >= ${utcDayStart(now)}`));
  if (today >= Math.max(1, Math.floor(quota * CONFIRMATION_QUOTA_SHARE))) return { kind: "accepted", confirmationQueued: false };

  const token = await signConfirmToken(secret, contactId, cycle.cycleId, now);
  const copy = confirmationCopy(cycle);
  const res = await notifications.insertAlerts(
    db,
    [
      {
        type: "contact.confirmation",
        contactId,
        // A status- or identity-defined cycle is not linked to an unconfirmed address at all (the
        // audience trigger would refuse it without a consent, and none exists yet); the token
        // alone names it.
        programCycleId: cycle.sensitiveAudience || cycle.identityAudience.length > 0 ? null : cycle.cycleId,
        dedupeKey: `confirm:${now}`,
        priority: "p0",
        title: copy.title,
        body: copy.body,
        href: confirmPath(token),
        scheduledFor: now,
      },
    ],
    now,
  );
  return { kind: "accepted", confirmationQueued: res.ok };
}

/** What the confirmation page lists before the visitor confirms. */
export interface ConfirmPreview {
  /** The program as emails will name it, or neutral wording for status- or identity-defined programs. */
  readonly label: string;
  readonly neutral: boolean;
  readonly nominationGated: boolean;
  /** True when confirming also records the status opt-in or identity consent. */
  readonly recordsConsent: boolean;
}

export function previewLabel(cycle: Pick<CycleRow, "programName" | "termLabel" | "isSample" | "sensitiveAudience" | "identityAudience">): { label: string; neutral: boolean } {
  const neutral = cycle.sensitiveAudience || cycle.identityAudience.length > 0;
  return {
    neutral,
    label: neutral ? "a program you chose on Novus (its name is left out of emails)" : `${cycle.programName} (${cycle.termLabel})${cycle.isSample ? " [sample listing]" : ""}`,
  };
}

/** The reminder a valid link would turn on; null when the Contact or the cycle is gone. */
export async function previewConfirmation(db: Db, claims: { c: string; p: string }): Promise<ConfirmPreview | null> {
  const contact = await db.query.contacts.findFirst({ where: eq(s.contacts.id, claims.c), columns: { id: true } });
  if (!contact) return null;
  const cycle = await publishedCycle(db, claims.p);
  if (!cycle) return null;
  const { label, neutral } = previewLabel(cycle);
  return { label, neutral, nominationGated: cycle.nominationGated, recordsConsent: neutral };
}

export type ConfirmOutcome =
  | { readonly kind: "confirmed"; readonly activated: number; readonly preview: ConfirmPreview }
  | { readonly kind: "gone" }
  | { readonly kind: "consent_unavailable" };

/**
 * Confirms a Contact from its emailed link: the Contact is kept (no 7-day deletion) and the one
 * Remind-me subscription the link names is created, with its consent when the program is status-
 * or identity-defined (method `email_link`: the address owner's own click). One batch, so the
 * audience trigger sees the consent and nothing is half-written. Idempotent.
 */
export async function confirmContact(db: Db, claims: { c: string; p: string }, now: number): Promise<ConfirmOutcome> {
  const contact = await db.query.contacts.findFirst({ where: eq(s.contacts.id, claims.c) });
  if (!contact) return { kind: "gone" };
  const cycle = await publishedCycle(db, claims.p);
  if (!cycle) return { kind: "gone" };
  const consents = await neededConsents(db, cycle);
  if (!consents.ok) return { kind: "consent_unavailable" };
  const { label, neutral } = previewLabel(cycle);

  const stmts: Stmt[] = [];
  for (const [kind, version, scopeId] of [
    ["sensitive_tracking", consents.sensitive, cycle.programId],
    ["identity_tracking", consents.identity, null],
  ] as const) {
    if (!version) continue;
    stmts.push(
      db
        .insert(s.consents)
        .values({ id: uuidv7(now), contactId: contact.id, kind, scopeType: scopeId ? "program" : null, scopeId, textVersion: version, method: "email_link", grantedAt: now })
        .onConflictDoNothing(),
    );
  }
  const subscriptionId = uuidv7(now);
  stmts.push(
    db
      .insert(s.subscriptions)
      .values({ id: subscriptionId, contactId: contact.id, kind: "remind_me", programCycleId: cycle.cycleId, nameInMessages: !neutral, deleteAfter: null, createdAt: now })
      .onConflictDoNothing(),
    db
      .update(s.contacts)
      .set({ confirmedAt: contact.confirmedAt ?? now, deleteAfter: null })
      .where(eq(s.contacts.id, contact.id)),
  );
  try {
    await runBatch(db, stmts);
  } catch (err) {
    if (isConsentRequired(err)) return { kind: "consent_unavailable" };
    throw err;
  }
  const created = await db.select({ id: s.subscriptions.id }).from(s.subscriptions).where(eq(s.subscriptions.id, subscriptionId)).limit(1);
  return { kind: "confirmed", activated: created.length, preview: { label, neutral, nominationGated: cycle.nominationGated, recordsConsent: neutral } };
}
