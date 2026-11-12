/**
 * Repositories: the only code that touches D1. Every function takes the Drizzle client first
 * (`getDb(env.DB)` or `getEventsDb(env.EVENTS_DB)`), so a driver swap stays inside server/db.
 * Import a namespace: `import { registry, students } from "@server/db/repos"`.
 */
export * as registry from "./registry";
export * as students from "./students";
export * as notifications from "./notifications";
export * as advisor from "./advisor";
export * as outcomes from "./outcomes";
export * as jobs from "./jobs";
export * as audit from "./audit";
export * as review from "./review";
export * as events from "./events";
export * as onboarding from "./onboarding";
export * as bands from "./bands";
export * from "./common";
