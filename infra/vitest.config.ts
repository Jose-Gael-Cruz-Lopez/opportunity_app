import { defineConfig } from "vitest/config";
import path from "node:path";

// Tests for infra/ (CI guards, backup encryption). The root vitest.config.ts does not include
// infra/**, so CI runs: npx vitest run --config infra/vitest.config.ts
const root = path.resolve(import.meta.dirname, "..");

export default defineConfig({
  root,
  resolve: {
    alias: {
      "@shared": path.resolve(root, "shared"),
      "@server": path.resolve(root, "server"),
    },
  },
  test: {
    include: ["infra/**/*.test.ts"],
    // workerd suites run under infra/vitest.workers.config.ts.
    exclude: ["**/*.worker.test.ts", "node_modules"],
    environment: "node",
  },
});
