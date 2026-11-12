/**
 * Sign-in with an emailed code, through the real UI. The code is read from the local email
 * capture (Miniflare writes every message the EMAIL binding sends to wrangler's log).
 *
 * Runs as the `setup` project; the signed-in browser state it saves is reused by
 * `student.spec.ts`, so the suite sends as few codes as possible (the limit is 2 a minute).
 */
import { writeFileSync } from "node:fs";
import { codesFor, uniqueEmail } from "./support/email";
import { STUDENT_EMAIL_FILE, STUDENT_STATE } from "./support/env";
import { expect, signInThroughUi, test } from "./support/fixtures";

test("signs in with the emailed code and lands a new account on /app/start", async ({ page, allowConsoleError }) => {
  // The deliberately wrong code below is answered 400 by Better Auth.
  allowConsoleError(/status of 400/);
  const email = uniqueEmail("student");

  await test.step("an implausible address is refused before any code is sent", async () => {
    await page.goto("/app/sign-in");
    await page.getByLabel("Birth month").selectOption({ label: "March" });
    await page.getByLabel("Birth year").selectOption("2006");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Email address").fill("not-an-email");
    await page.getByRole("button", { name: "Email me a code" }).click();
    await expect(page.getByRole("alert")).toContainText("like name@example.com");
    // Nothing was sent for an implausible address.
    expect(codesFor("not-an-email")).toEqual([]);
  });

  await test.step("the real code signs in", async () => {
    await signInThroughUi(page, email, { wrongCodeFirst: true });
    // New accounts start with the guided first five minutes.
    await expect(page).toHaveURL(/\/app\/start$/);
    await expect(page.getByRole("heading", { level: 1, name: /Find the opportunities that fit you/ })).toBeVisible();
  });

  await test.step("the session is a __Host- cookie, httpOnly and Secure", async () => {
    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === "__Host-novus.session");
    expect(session, "session cookie").toBeDefined();
    expect(session?.httpOnly).toBe(true);
    expect(session?.secure).toBe(true);
    expect(session?.path).toBe("/");

    const res = await page.request.get("/api/v1/me/session");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { user: { onboarded: boolean } | null };
    expect(body.user).not.toBeNull();
    expect(body.user?.onboarded).toBe(false);
  });

  await page.context().storageState({ path: STUDENT_STATE });
  writeFileSync(STUDENT_EMAIL_FILE, email);
});
