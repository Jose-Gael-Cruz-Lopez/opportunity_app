/**
 * Shared Playwright fixtures and helpers.
 *
 * `test` adds two automatic fixtures to every spec:
 *   - `outgoing`: every request the page sends (method, URL, body), so a spec can prove that
 *     private text (resume contact lines, sensitive answers) never left the browser.
 *   - console and page errors: a spec fails on an uncaught page error or a console error that is
 *     not on the short list of expected ones (signed-out 401s, the missing favicon).
 */
import { expect, test as base, type Page, type Request } from "@playwright/test";
import { codesFor, waitForCode } from "./email";

export interface OutgoingRequest {
  method: string;
  url: string;
  body: string;
}

/** Console errors that are expected and harmless. Everything else fails the test. */
const EXPECTED_CONSOLE = [
  // Signed-out probes (/api/v1/onboarding/state, /api/v1/me/*) answer 401 by design.
  /status of 401 .*\/api\/v1\//,
  // A rate-limited code send, shown to the student as a message (signInThroughUi waits it out).
  /status of 429 .*\/api\/auth\/email-otp\/send-verification-otp/,
  // The SPA links /favicon.png and browsers probe /favicon.ico; neither ships yet (see docs/testing.md).
  /status of 404 .*\/favicon\.(png|ico)$/,
];

export const test = base.extend<{
  outgoing: OutgoingRequest[];
  /** Lets one test expect a specific console error (for example a deliberately wrong code). */
  allowConsoleError: (pattern: RegExp) => void;
}>({
  outgoing: [
    async ({ page }, use) => {
      const seen: OutgoingRequest[] = [];
      const record = (req: Request) => {
        seen.push({ method: req.method(), url: req.url(), body: req.postData() ?? "" });
      };
      page.on("request", record);
      await use(seen);
      page.off("request", record);
    },
    { auto: true },
  ],
  allowConsoleError: [
    async ({ page }, use, testInfo) => {
      const allowed = [...EXPECTED_CONSOLE];
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() !== "error") return;
        // Resource errors name the URL only in the location, so match against both.
        const text = `${msg.text()} @ ${msg.location().url}`;
        if (allowed.some((re) => re.test(text))) return;
        errors.push(text);
      });
      page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
      await use((pattern) => allowed.push(pattern));
      if (testInfo.status === testInfo.expectedStatus) {
        expect(errors, "unexpected console or page errors").toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Signs in through the real UI: birth month and year, email, then the 6-digit code read from
 * the local email capture (./email.ts). Leaves the page wherever the app sends a signed-in user.
 * Retries the send once after the per-IP limit window (2 sends a minute) if it was hit.
 */
export async function signInThroughUi(page: Page, email: string, options: { wrongCodeFirst?: boolean } = {}): Promise<void> {
  await page.goto("/app/sign-in");
  const ageStep = page.getByRole("heading", { level: 1, name: "Sign in to Novus" });
  const emailStep = page.getByRole("heading", { level: 1, name: "Your email" });
  await expect(ageStep.or(emailStep)).toBeFocused();
  // The age step is skipped when this browser already answered it (a month and year only).
  if (await ageStep.isVisible()) {
    await page.getByLabel("Birth month").selectOption({ label: "March" });
    await page.getByLabel("Birth year").selectOption("2006");
    await page.getByRole("button", { name: "Continue" }).click();
  }
  await expect(emailStep).toBeFocused();
  await page.getByLabel("Email address").fill(email);
  const seen = codesFor(email).length;
  await page.getByRole("button", { name: "Email me a code" }).click();

  const checkEmail = page.getByRole("heading", { level: 1, name: "Check your email" });
  const limited = page.getByRole("alert");
  await expect(checkEmail.or(limited)).toBeVisible();
  if (!(await checkEmail.isVisible())) {
    // Rate limited by an earlier spec in the same minute: wait out the window and send again.
    await page.waitForTimeout(61_000);
    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(checkEmail).toBeVisible();
  }

  const code = await waitForCode(email, seen);
  if (options.wrongCodeFirst) {
    const wrong = code === "000000" ? "111111" : "000000";
    await page.getByLabel("Code").fill(wrong);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page).toHaveURL(/\/app\/sign-in/);
  }
  await page.getByLabel("Code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/app/sign-in"));
}

/**
 * Readiness is four parts and never one number about the student: no percentage, no
 * "match %", no score. Checks the visible text of `scope`.
 */
export async function expectNoStudentScore(page: Page, scope = page.locator("main")): Promise<void> {
  const text = (await scope.innerText()).replace(/\s+/g, " ");
  expect(text, "a percentage is shown").not.toMatch(/\d\s*%|\bpercent\b/i);
  expect(text, "a match score is shown").not.toMatch(/\bmatch(ing)?\s*(score|%|rate)\b/i);
  expect(text, "a score about the student is shown").not.toMatch(/\byour score\b|\bscore:\s*\d/i);
}
