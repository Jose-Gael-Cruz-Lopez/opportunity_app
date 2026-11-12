/**
 * Staff second factor: TOTP enrollment, per-session step-up and recovery codes.
 *
 * A staff member signs in with an emailed code like everyone else, then proves the second factor
 * for that session. The proof is a `session_second_factors` row tied to the session id, so
 * signing out or losing the session drops it, and it expires after at most 12 hours.
 */
import { and, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@server/db/client";
import { decryptString, encryptString, hmacHex } from "./crypto";
import { sessionSecondFactors, staffSecondFactors } from "./schema";
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from "./totp";
import type { SecondFactorState } from "./types";

/** A step-up proof lasts at most this long, matching the console's 12-hour sessions. */
export const SECOND_FACTOR_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** Consecutive failures before a lockout; each further block of failures doubles it. */
export const MAX_FAILED_ATTEMPTS = 5;
export const BASE_LOCKOUT_MS = 15 * 60 * 1000;
export const MAX_LOCKOUT_MS = 24 * 60 * 60 * 1000;
export const TOTP_ISSUER = "Novus";

const SECRET_PURPOSE = "staff-totp-secret";
const RECOVERY_PURPOSE = "staff-recovery-code";

export type SecondFactorFailure = "not_enrolled" | "already_enrolled" | "invalid_code" | "locked";
export type SecondFactorResult = { ok: true } | { ok: false; reason: SecondFactorFailure; retryAfterMs?: number };

export interface SessionRef {
  userId: string;
  sessionId: string;
  sessionExpiresAt: number;
}

export interface Enrollment {
  secret: string;
  otpauthUri: string;
  /** Shown once; only keyed hashes are stored. */
  recoveryCodes: string[];
}

/** The lockout after `failed` consecutive failures (0 below the threshold). */
export function lockoutMs(failed: number): number {
  if (failed < MAX_FAILED_ATTEMPTS) return 0;
  const blocks = Math.floor(failed / MAX_FAILED_ATTEMPTS) - 1;
  return Math.min(BASE_LOCKOUT_MS * 2 ** blocks, MAX_LOCKOUT_MS);
}

async function hashRecoveryCode(authSecret: string, code: string): Promise<string> {
  return hmacHex(`${authSecret}:${RECOVERY_PURPOSE}`, normalizeRecoveryCode(code));
}

async function getFactor(db: Db, userId: string) {
  const rows = await db.select().from(staffSecondFactors).where(eq(staffSecondFactors.userId, userId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Starts (or restarts) enrollment. A pending enrollment is replaced, which also invalidates the
 * recovery codes it showed; a confirmed one must be reset by an admin, not overwritten here.
 */
export async function startEnrollment(
  db: Db,
  input: { userId: string; accountLabel: string; authSecret: string; now: number },
): Promise<{ ok: true; enrollment: Enrollment } | { ok: false; reason: "already_enrolled" }> {
  const existing = await getFactor(db, input.userId);
  if (existing?.confirmedAt) return { ok: false, reason: "already_enrolled" };

  const secret = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes();
  const secretEnc = await encryptString(input.authSecret, SECRET_PURPOSE, secret);
  const hashes = await Promise.all(recoveryCodes.map((c) => hashRecoveryCode(input.authSecret, c)));
  const values = {
    secretEnc,
    confirmedAt: null,
    lastUsedStep: null,
    failedCount: 0,
    lockedUntil: null,
    recoveryCodeHashes: hashes,
    updatedAt: input.now,
  };
  await db
    .insert(staffSecondFactors)
    .values({ userId: input.userId, createdAt: input.now, ...values })
    .onConflictDoUpdate({ target: staffSecondFactors.userId, set: values, setWhere: isNull(staffSecondFactors.confirmedAt) });

  return {
    ok: true,
    enrollment: { secret, otpauthUri: otpauthUri(TOTP_ISSUER, input.accountLabel, secret), recoveryCodes },
  };
}

/**
 * Claims one attempt before the code is checked, atomically: one UPDATE adds 1 to
 * `failed_count`, sets the lockout the new count earns, and only runs while the factor is not
 * locked. D1 runs statements one at a time, so N parallel guesses get N distinct counts and the
 * fifth sets the lock that refuses the sixth; no stale read can hand out extra attempts. A
 * correct code then resets the count (see the callers). The lockout table matches `lockoutMs`:
 * 15 minutes doubling per block of 5, capped at 24 hours (2^7 blocks exceed the cap).
 */
async function claimAttempt(db: Db, userId: string, now: number): Promise<{ ok: true; failed: number; lockedUntil: number | null } | { ok: false; retryAfterMs: number }> {
  // Integer constants are inlined so SQLite divides integers (bound JS numbers may bind as REAL).
  const max = sql.raw(String(MAX_FAILED_ATTEMPTS));
  const base = sql.raw(String(BASE_LOCKOUT_MS));
  const cap = sql.raw(String(MAX_LOCKOUT_MS));
  const next = sql`(${staffSecondFactors.failedCount} + 1)`;
  const rows = await db
    .update(staffSecondFactors)
    .set({
      failedCount: next,
      lockedUntil: sql`CASE WHEN ${next} < ${max} THEN NULL
        WHEN ${next} / ${max} - 1 >= 7 THEN ${now} + ${cap}
        ELSE ${now} + min(${base} * (1 << (${next} / ${max} - 1)), ${cap}) END`,
      updatedAt: now,
    })
    .where(and(eq(staffSecondFactors.userId, userId), or(isNull(staffSecondFactors.lockedUntil), lte(staffSecondFactors.lockedUntil, now))))
    .returning({ failed: staffSecondFactors.failedCount, lockedUntil: staffSecondFactors.lockedUntil });
  const row = rows[0];
  if (row) return { ok: true, failed: row.failed, lockedUntil: row.lockedUntil };
  const current = await getFactor(db, userId);
  return { ok: false, retryAfterMs: Math.max(1000, (current?.lockedUntil ?? now) - now) };
}

/** The answer for a wrong code whose attempt was already counted by `claimAttempt`. */
function failedAttempt(claim: { failed: number; lockedUntil: number | null }, now: number): SecondFactorResult {
  return claim.lockedUntil !== null && claim.lockedUntil > now
    ? { ok: false, reason: "locked", retryAfterMs: claim.lockedUntil - now }
    : { ok: false, reason: "invalid_code" };
}

async function markSessionVerified(db: Db, ref: SessionRef, method: "totp" | "recovery_code", now: number): Promise<void> {
  const expiresAt = Math.min(ref.sessionExpiresAt, now + SECOND_FACTOR_MAX_AGE_MS);
  await db
    .insert(sessionSecondFactors)
    .values({ sessionId: ref.sessionId, userId: ref.userId, method, verifiedAt: now, expiresAt })
    .onConflictDoUpdate({ target: sessionSecondFactors.sessionId, set: { method, verifiedAt: now, expiresAt } });
}

/**
 * Accepts a TOTP code for this session. With `confirming`, it also completes a pending
 * enrollment; without it, the user must already be enrolled.
 */
export async function verifyTotpForSession(
  db: Db,
  ref: SessionRef,
  input: { code: string; authSecret: string; now: number; confirming?: boolean },
): Promise<SecondFactorResult> {
  const factor = await getFactor(db, ref.userId);
  if (!factor) return { ok: false, reason: "not_enrolled" };
  if (input.confirming ? factor.confirmedAt !== null : factor.confirmedAt === null) {
    return { ok: false, reason: input.confirming ? "already_enrolled" : "not_enrolled" };
  }
  const claim = await claimAttempt(db, ref.userId, input.now);
  if (!claim.ok) return { ok: false, reason: "locked", retryAfterMs: claim.retryAfterMs };

  const secret = await decryptString(input.authSecret, SECRET_PURPOSE, factor.secretEnc);
  const check = await verifyTotp(secret, input.code, input.now, factor.lastUsedStep);
  if (!check.ok) return failedAttempt(claim, input.now);

  // The step guard in the WHERE clause makes a concurrent replay of the same code lose the race.
  const updated = await db
    .update(staffSecondFactors)
    .set({
      lastUsedStep: check.step,
      failedCount: 0,
      lockedUntil: null,
      updatedAt: input.now,
      ...(input.confirming ? { confirmedAt: input.now } : {}),
    })
    .where(
      and(
        eq(staffSecondFactors.userId, ref.userId),
        or(isNull(staffSecondFactors.lastUsedStep), lt(staffSecondFactors.lastUsedStep, check.step)),
      ),
    )
    .returning({ userId: staffSecondFactors.userId });
  if (updated.length === 0) return { ok: false, reason: "invalid_code" };

  await markSessionVerified(db, ref, "totp", input.now);
  return { ok: true };
}

/** Spends one recovery code for this session. Each code works once. */
export async function useRecoveryCode(
  db: Db,
  ref: SessionRef,
  input: { code: string; authSecret: string; now: number },
): Promise<SecondFactorResult> {
  const factor = await getFactor(db, ref.userId);
  if (!factor?.confirmedAt) return { ok: false, reason: "not_enrolled" };
  const claim = await claimAttempt(db, ref.userId, input.now);
  if (!claim.ok) return { ok: false, reason: "locked", retryAfterMs: claim.retryAfterMs };
  const hash = await hashRecoveryCode(input.authSecret, input.code);
  if (!factor.recoveryCodeHashes.includes(hash)) return failedAttempt(claim, input.now);

  const remaining = factor.recoveryCodeHashes.filter((h) => h !== hash);
  // Compare-and-set on the stored list so two concurrent uses of one code cannot both succeed.
  const updated = await db
    .update(staffSecondFactors)
    .set({ recoveryCodeHashes: remaining, failedCount: 0, lockedUntil: null, updatedAt: input.now })
    .where(
      and(
        eq(staffSecondFactors.userId, ref.userId),
        sql`${staffSecondFactors.recoveryCodeHashes} = ${JSON.stringify(factor.recoveryCodeHashes)}`,
      ),
    )
    .returning({ userId: staffSecondFactors.userId });
  if (updated.length === 0) return { ok: false, reason: "invalid_code" };

  await markSessionVerified(db, ref, "recovery_code", input.now);
  return { ok: true };
}

export async function remainingRecoveryCodes(db: Db, userId: string): Promise<number> {
  const factor = await getFactor(db, userId);
  return factor?.confirmedAt ? factor.recoveryCodeHashes.length : 0;
}

/**
 * Whether the user has an authenticator and whether this session passed it. Any database error
 * (for example the tables not migrated yet) reads as "not verified", so staff routes fail closed.
 */
export async function secondFactorState(db: Db, userId: string, sessionId: string, now: number): Promise<SecondFactorState> {
  try {
    const factor = await getFactor(db, userId);
    const enrolled = factor?.confirmedAt != null;
    if (!enrolled) return { enrolled: false, verified: false };
    const proof = await db
      .select({ sessionId: sessionSecondFactors.sessionId })
      .from(sessionSecondFactors)
      .where(
        and(
          eq(sessionSecondFactors.sessionId, sessionId),
          eq(sessionSecondFactors.userId, userId),
          gt(sessionSecondFactors.expiresAt, now),
        ),
      )
      .limit(1);
    return { enrolled, verified: proof.length > 0 };
  } catch {
    return { enrolled: false, verified: false };
  }
}

/** Drops a user's authenticator and every session proof (an admin reset after a lost phone). */
export async function resetSecondFactor(db: Db, userId: string): Promise<void> {
  await db.delete(sessionSecondFactors).where(eq(sessionSecondFactors.userId, userId));
  await db.delete(staffSecondFactors).where(eq(staffSecondFactors.userId, userId));
}

/** Removes expired session proofs (call from the hourly sweep). */
export async function sweepSecondFactorProofs(db: Db, now: number): Promise<void> {
  await db.delete(sessionSecondFactors).where(lt(sessionSecondFactors.expiresAt, now));
}
