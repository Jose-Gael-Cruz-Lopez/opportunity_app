import { createAi } from "@server/ai";
import { getDb } from "@server/db/client";
import type { StudentDeps } from "./ports";
import { createD1ReadinessBandsSource } from "./readiness-bands";
import { createStudentRoutes, requireSignedIn } from "./routes";
import { createD1StudentStore } from "./store";

/**
 * Signed-in student API. server/app.ts mounts `studentRoutes` at /api/v1, after the global
 * sessionMiddleware has resolved c.var.user and the sensitive-key guard has run.
 *
 * Routes (shared/contracts/routes.ts, mount "student"): session, profile, tracker, notification
 * preferences, consents, calendar feed rotation, requirement progress, roadmap, readiness, the
 * in-app inbox, and the three Gemini assistant routes (readiness explanation, statement feedback,
 * Ask Novus), and account deletion. Data export answers 503 until its job exists; outcome
 * reports are not built here yet.
 */

export { createStudentRoutes, requireSignedIn, publicSessionUser, DEFAULT_AI_RATE_RULES } from "./routes";
export { createD1StudentStore } from "./store";
export { computeReadiness, markPrivateChecks, privateCheckRuleIds, programSources, studentTimeZone } from "./readiness";
export { buildRoadmap, programIdFromItemKey, ROADMAP_ALGO_VERSION } from "./roadmap";
export type { CycleFacts, ProgramFacts, ReadinessSource, StudentDeps, StudentStore, TrackedCycle } from "./ports";

export const studentDeps: StudentDeps = {
  store: (c) => createD1StudentStore(getDb(c.env.DB)),
  // One Ai per request is cheap: the circuit breaker and memory ledger live per isolate in server/ai.
  ai: (c) => createAi(c.env),
  now: () => Date.now(),
  origin: (c) => c.env.APP_ORIGIN,
  requireStudent: requireSignedIn,
  // Stored band models (band_models) and held cycles (outcome_cycle_holds) for readiness.
  bands: (c) => createD1ReadinessBandsSource(getDb(c.env.DB)),
};

export const studentRoutes = createStudentRoutes(studentDeps);
