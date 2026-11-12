import { createOutcomesRoutes } from "./routes";
import { outcomesDeps } from "./wiring";

/**
 * Outcome reporting and the public, disclosure-safe summary. Mounted by integration under
 * /api/v1 (server/app.ts): student routes `/me/outcomes*` and the public
 * `/programs/:slug/outcomes/summary`. See README.md.
 */
export const outcomesRoutes = createOutcomesRoutes(outcomesDeps);

export { createOutcomesRoutes } from "./routes";
export { createD1OutcomesStore } from "./d1";
export type { OutcomesDeps, OutcomesStore } from "./ports";
