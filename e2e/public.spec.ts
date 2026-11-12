/**
 * Public, signed-out pages rendered by the Worker (server/pages): the landing page, the public
 * Explore list and a public program page. Every program in the local database is SAMPLE data,
 * and these pages must say so.
 */
import type { Response } from "@playwright/test";
import { codesFor, uniqueEmail, waitForCode } from "./support/email";
import { BASE_URL } from "./support/env";
import { expect, test } from "./support/fixtures";

const PROGRAM = { slug: "sample-summer-research-fellowship", name: "Sample Summer Research Fellowship" };

test.describe("landing page", () => {
  test("introduces Novus, labels sample data and links into the registry", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.status()).toBe(200);
    expect(res?.headers()["content-security-policy"]).toContain("default-src 'self'");
    expect(res?.headers()["x-content-type-options"]).toBe("nosniff");

    await expect(page).toHaveTitle(/Novus/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Find the doors that open early/);
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Explore" })).toHaveAttribute("href", "/explore");
    await expect(nav.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/app");

    // The five doors carry live counts from the SAMPLE registry, labelled as such.
    const doors = page.getByRole("region", { name: /Pick a door/ });
    await expect(doors.getByRole("heading", { level: 3 })).toHaveCount(5);
    await expect(doors).toContainText("Counts include invented sample records");

    // Closing soon: dated rows from the seed, each one marked Sample.
    const closing = page.getByRole("list", { name: "The next doors to close." });
    await expect(closing.getByRole("listitem").first()).toContainText("Sample");
    await expect(closing.getByRole("listitem").first()).toContainText(/\d+ days? left/);
    await expect(page.getByText("Rows marked Sample are invented records")).toBeVisible();

    await expect(page.getByText("never shows a single score about you")).toBeVisible();
  });

  test("the public Explore page lists and filters sample programs", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Explore" }).click();
    await expect(page).toHaveURL(/\/explore$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("checked by a person");
    await expect(page.getByRole("note")).toContainText("are invented for this preview");
    const all = await page.getByRole("main").getByRole("article").count();
    expect(all).toBeGreaterThan(10);

    // A server-rendered GET form: works without JavaScript.
    await page.getByRole("searchbox", { name: "Search" }).fill("research");
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/q=research/);
    const filtered = page.getByRole("main").getByRole("article");
    await expect(filtered.first()).toBeVisible();
    expect(await filtered.count()).toBeLessThan(all);
    await expect(page.getByRole("main").getByRole("link", { name: PROGRAM.name })).toBeVisible();
  });
});

test.describe("public program page", () => {
  test("shows dates, rules, requirements, sources and a calendar file", async ({ page, request }) => {
    const res = await page.goto(`/programs/${PROGRAM.slug}`);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveTitle(new RegExp(`${PROGRAM.name}.*Novus`));
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`/programs/${PROGRAM.slug}$`));

    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText(PROGRAM.name);
    await expect(main.getByText("Sample", { exact: true }).first()).toBeVisible();
    await expect(main.getByRole("link", { name: "Apply on the official site" })).toBeVisible();

    // Eligibility is checked on the device, never on this server-rendered page.
    const canApply = main.getByRole("region", { name: "Can I apply?" });
    await expect(canApply).toContainText("it is checked in your browser");
    await expect(canApply.getByRole("link", { name: "Start the check" })).toHaveAttribute(
      "href",
      `/app/programs/${PROGRAM.slug}#check`,
    );
    await expect(main.getByRole("region", { name: "What you need" }).getByRole("listitem").first()).toBeVisible();
    await expect(main.getByRole("region", { name: "Key dates" }).getByRole("listitem").first()).toBeVisible();

    // Track hands off to the app; the calendar link is a real ICS file.
    await expect(main.getByRole("link", { name: "Track" })).toHaveAttribute("href", `/app/programs/${PROGRAM.slug}?track=1`);
    const cal = main.getByRole("link", { name: "Add to calendar" });
    const ics = await request.get((await cal.getAttribute("href")) ?? "");
    expect(ics.status()).toBe(200);
    expect(ics.headers()["content-type"]).toContain("text/calendar");
    const body = await ics.text();
    expect(body).toContain("BEGIN:VCALENDAR");
    expect(body).toContain("BEGIN:VEVENT");
  });

  test("the Explore breadcrumb returns to the list, and an unknown slug is a 404 page", async ({ page, allowConsoleError }) => {
    allowConsoleError(/status of 404 .*\/programs\/sample-does-not-exist$/);
    await page.goto(`/programs/${PROGRAM.slug}`);
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Explore" }).click();
    await expect(page).toHaveURL(/\/explore$/);

    const res = await page.goto("/programs/sample-does-not-exist");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});

test.describe("Curator console host", () => {
  // The console lives on curate.<app host>; Chrome resolves *.localhost to this machine.
  const CONSOLE_ORIGIN = BASE_URL.replace("://localhost", "://curate.localhost");

  test("code sign-in posts carry the console Origin and pass the CSRF checks", async ({ page, allowConsoleError }) => {
    // Signed in but not staff: the console's own API reads answer 403 (no role, no second factor).
    allowConsoleError(/status of 403 .*\/api\/v1\//);
    const email = uniqueEmail("curator");
    const authPost = (path: string) => page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(path));
    const expectConsoleOrigin = async (res: Response) => {
      expect(await res.request().headerValue("origin"), res.url()).toBe(CONSOLE_ORIGIN);
      expect(res.status(), res.url()).not.toBe(403);
    };

    const res = await page.goto(`${CONSOLE_ORIGIN}/curate`);
    expect(res?.status()).toBe(200);
    // A no-referrer document sends "Origin: null" on its own POSTs, which the checks refuse.
    expect(await page.locator('meta[name="referrer"]').getAttribute("content")).not.toBe("no-referrer");

    await expect(page.getByRole("heading", { name: "Curator sign-in" })).toBeVisible();
    await page.getByLabel("Email").fill(email);
    const seen = codesFor(email).length;
    let [sent] = await Promise.all([authPost("/email-otp/send-verification-otp"), page.getByRole("button", { name: "Email me a code" }).click()]);
    await expectConsoleOrigin(sent);
    if (sent.status() === 429) {
      // Rate limited by an earlier spec in the same minute (2 sends a minute): wait it out.
      await page.waitForTimeout(61_000);
      [sent] = await Promise.all([authPost("/email-otp/send-verification-otp"), page.getByRole("button", { name: "Email me a code" }).click()]);
      await expectConsoleOrigin(sent);
    }
    expect(sent.status()).toBe(200);

    await page.getByLabel("Code from the email").fill(await waitForCode(email, seen));
    const [signedIn] = await Promise.all([authPost("/sign-in/email-otp"), page.getByRole("button", { name: "Sign in" }).click()]);
    await expectConsoleOrigin(signedIn);
    expect(signedIn.status()).toBe(200);
    // Past the code step. A new account is not staff, so the console now refuses its reads.
    await expect(page.getByRole("heading", { name: "Curator sign-in" })).toBeHidden();
  });
});
