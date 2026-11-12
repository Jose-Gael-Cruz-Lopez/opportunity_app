import path from "node:path";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Tests that must run inside workerd, the Workers runtime, through the Workers Vitest pool
 * (@cloudflare/vitest-pool-workers 0.23.0). Files are named *.worker.test.ts; the root config and
 * infra/vitest.config.ts exclude them. Run:
 *
 *   npx vitest run --config infra/vitest.workers.config.ts
 *
 * The isolate gets the production compatibility flags but no bindings and no `main` Worker: the
 * suites here exercise shared code (the eligibility golden cases first), which needs no D1 or R2.
 */
const root = path.resolve(import.meta.dirname, "..");

export default defineConfig({
  root,
  plugins: [
    cloudflareTest({
      miniflare: {
        // Production (infra/wrangler/wrangler.toml) uses 2026-11-01, but the workerd that ships
        // with the pool (miniflare 5.20260815) supports dates up to 2026-08-22 only. The suites
        // here run pure shared code that no compatibility flag between the two dates changes.
        // Raise to the production date when the pool's workerd supports it.
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  resolve: {
    alias: {
      "@shared": path.resolve(root, "shared"),
      "@server": path.resolve(root, "server"),
    },
  },
  test: {
    include: ["infra/**/*.worker.test.ts", "shared/**/*.worker.test.ts", "server/**/*.worker.test.ts"],
    exclude: ["node_modules", "legacy", "dist"],
  },
});
