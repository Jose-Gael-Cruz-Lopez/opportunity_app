/**
 * End-to-end tests against a real local Worker (wrangler dev + fresh local D1 + SAMPLE seed).
 * See docs/testing.md. Run with `npx playwright test`.
 *
 * Browser: the system Google Chrome (channel "chrome"), so no Playwright browser download is
 * needed. Set E2E_CHANNEL=chromium to use a downloaded Chromium (`npx playwright install chromium`).
 */
import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, STUDENT_STATE } from "./e2e/support/env";

const requested = process.env.E2E_CHANNEL ?? "chrome";
const browser = { ...devices["Desktop Chrome"], channel: requested === "chromium" ? undefined : requested };

export default defineConfig({
  testDir: "./e2e",
  // Everything a run writes stays under .wrangler/e2e (git-ignored).
  outputDir: "./.wrangler/e2e/results",
  globalSetup: "./e2e/global-setup.ts",
  // One Worker and one D1 for the whole run. Code sends are limited to 2 a minute per IP, and
  // specs share the database, so run in order on one worker.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: "./.wrangler/e2e/report" }]]
    : [["list"]],
  use: {
    ...browser,
    baseURL: BASE_URL,
    headless: process.env.E2E_HEADED !== "1",
    timezoneId: "America/Chicago",
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    // Signs a student in through the UI and saves the session for `student`.
    { name: "setup", testMatch: /auth\.setup\.ts$/ },
    { name: "public", testMatch: /(public|a11y)\.spec\.ts$/ },
    // Signs in its own new student, so it does not depend on `setup`.
    { name: "onboarding", testMatch: /onboarding\.spec\.ts$/ },
    { name: "student", testMatch: /student\.spec\.ts$/, dependencies: ["setup"], use: { storageState: STUDENT_STATE } },
  ],
});
