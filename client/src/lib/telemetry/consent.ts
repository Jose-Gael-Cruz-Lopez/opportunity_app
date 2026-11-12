import type { MeSessionResponse } from "@shared/contracts";

/**
 * Whether this browser may send analytics for the signed-in account, from what the session
 * already holds. Minor mode (under 18 by the youngest reading of the birth month, the server's
 * rule in server/api/v1/events/store.ts) turns analytics off; no analytics consent for 16-17
 * exists yet. An account's own "analytics off" switch is not in the session payload, so the
 * server enforces it (POST /api/v1/events answers 204 and stores nothing).
 */
export function analyticsAllowedFor(session: MeSessionResponse | null | undefined, nowMs: number): boolean {
  const birth = session?.user ? session.profile?.birthYearMonth : null;
  if (!birth) return true;
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(birth);
  if (!m) return false;
  // First instant someone born in that month can be 18: the start of the next month, 18 years on.
  return nowMs >= Date.UTC(Number(m[1]) + 18, Number(m[2]), 1);
}
