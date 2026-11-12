import type { Context } from "hono";
import { requireSignedIn } from "@server/api/v1/student/routes";
import { getDb } from "@server/db/client";
import type { AppEnv } from "@server/env";
import { subjectKeyFor } from "@server/services/audit";
import { programBandGates } from "./band-status";
import { createD1OutcomesStore } from "./d1";
import type { OutcomesDeps } from "./ports";

/**
 * Binds the Outcome routes to D1 (the session user from the session middleware, the
 * access_audit pseudonym from BETTER_AUTH_SECRET). The summary's band status comes from the
 * stored band_models rows and the same read-time gates readiness applies (./band-status.ts), so
 * the two can never disagree; with no stored model it is "official base rate only".
 */
export const outcomesDeps: OutcomesDeps = {
  store: (c: Context<AppEnv>) => {
    const db = getDb(c.env.DB);
    const secret = c.env.BETTER_AUTH_SECRET;
    return createD1OutcomesStore(db, {
      subjectKey: secret ? (userId) => subjectKeyFor(secret, userId) : undefined,
      bandGates: (programId) => programBandGates(db, programId, Date.now()),
    });
  },
  requireStudent: requireSignedIn,
  userId: (c) => c.get("user")?.id ?? null,
  now: () => Date.now(),
};
