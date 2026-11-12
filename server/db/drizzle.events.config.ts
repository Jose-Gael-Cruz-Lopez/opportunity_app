import { defineConfig } from "drizzle-kit";

// Migrations for D1 `novus-events` (the root drizzle.config.ts covers `novus-main`).
// Run: npx drizzle-kit generate --config server/db/drizzle.events.config.ts
export default defineConfig({
  dialect: "sqlite",
  schema: "./server/db/events-schema.ts",
  out: "./server/db/migrations-events",
});
