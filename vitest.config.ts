import { defineConfig } from "vitest/config";
import path from "node:path";

// Unit tests for shared/ and server/ run in Node. Worker-runtime tests (server/**/*.worker.test.ts)
// get their own config in infra/ once the Workers pool is wired.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@server": path.resolve(import.meta.dirname, "server"),
      "@": path.resolve(import.meta.dirname, "client", "src"),
    },
  },
  test: {
    include: ["shared/**/*.test.ts", "server/**/*.test.ts", "client/src/**/*.test.ts"],
    exclude: ["**/*.worker.test.ts", "node_modules", "legacy"],
    environment: "node",
  },
});
