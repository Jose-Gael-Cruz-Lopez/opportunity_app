/**
 * A signed-in student (state saved by auth.setup.ts): Explore, a program, the four readiness
 * parts, and adding the program to the Tracker.
 */
import { expect, expectNoStudentScore, test } from "./support/fixtures";

const PROGRAM = { slug: "sample-summer-research-fellowship", name: "Sample Summer Research Fellowship" };

const PARTS = ["Part 1 · Eligibility", "Part 2 · Requirements", "Part 3 · Competitiveness", "Part 4 · Next actions"];

test("explore, open a program, read readiness in four parts and track it", async ({ page }) => {
  await test.step("Explore lists sample programs and searches them", async () => {
    await page.goto("/app/explore");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1, name: "Explore" })).toBeVisible();
    await expect(main.getByText(/\d+ programs · each one checked by a person/)).toBeVisible();
    const cards = main.getByRole("article");
    await expect(cards.first()).toBeVisible();
    const all = await cards.count();

    await main.getByRole("searchbox", { name: "Search programs" }).fill("research");
    await expect.poll(() => cards.count()).toBeLessThan(all);
    await expect(main.getByRole("link", { name: PROGRAM.name })).toBeVisible();
    await main.getByRole("link", { name: PROGRAM.name }).click();
  });

  await test.step("program page", async () => {
    await expect(page).toHaveURL(new RegExp(`/app/programs/${PROGRAM.slug}`));
    await expect(page.getByRole("heading", { level: 1, name: PROGRAM.name })).toBeVisible();
    await expect(page.getByRole("main")).toContainText("Sample data");
    await expect(page.getByRole("link", { name: /Apply on the official site/ })).toBeVisible();
  });

  await test.step("readiness: exactly four parts, never one score", async () => {
    const readiness = page.getByRole("region", { name: "Your readiness" });
    await expect(readiness).toContainText("Four parts. Never one score.");
    for (const part of PARTS) await expect(readiness.getByText(part, { exact: true })).toBeVisible();
    await expect(readiness.getByRole("article")).toHaveCount(4);
    // Signed in, parts 2 to 4 come from the Worker's report for this student.
    await expect(readiness.getByRole("list", { name: "Eligibility rules" }).getByRole("listitem").first()).toBeVisible();
    const checklist = readiness.getByRole("list", { name: "Requirements checklist" }).getByRole("checkbox");
    await expect(checklist.first()).toBeVisible();
    await expect(checklist.first()).toHaveAccessibleName(/ by [A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}/);
    await expect(readiness.getByRole("article", { name: "How competitive" })).toContainText("never a score about you");
    await expect(readiness.getByRole("list", { name: "Next actions" }).getByRole("listitem").first()).toBeVisible();
    await expectNoStudentScore(page, readiness);
  });

  await test.step("the full readiness page shows the same four parts", async () => {
    const programUrl = page.url();
    await page.getByRole("region", { name: "Your readiness" }).getByRole("link", { name: "Full readiness" }).click();
    await expect(page).toHaveURL(/\/app\/readiness\/[^/?]+\?program=/);
    for (const part of PARTS) await expect(page.getByText(part, { exact: true })).toBeVisible();
    await expectNoStudentScore(page);

    // The report behind it has the four parts and no composite number about the student.
    const cycleId = new URL(page.url()).pathname.split("/").pop() ?? "";
    const res = await page.request.get(`/api/v1/me/readiness/${cycleId}`);
    expect(res.status()).toBe(200);
    const { report } = (await res.json()) as { report: Record<string, unknown> };
    for (const key of ["eligibility", "requirements", "competitiveness", "nextActions"]) expect(report).toHaveProperty(key);
    expect(JSON.stringify(report)).not.toMatch(/"(score|percent|percentage|matchScore|match)"\s*:/i);
    await page.goto(programUrl);
  });

  await test.step("add to Tracker", async () => {
    const track = page.getByRole("button", { name: "Track", exact: true });
    const tracking = page.getByRole("button", { name: "Tracking", exact: true });
    await expect(track.or(tracking)).toBeVisible();
    if (await tracking.isVisible()) {
      // A retried run: untrack first so the add below is real.
      await tracking.click();
      await expect(page.getByRole("status").filter({ hasText: "Removed from your Tracker." })).toBeVisible();
    }
    await track.click();
    await expect(page.getByRole("status").filter({ hasText: "Added to your Tracker." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tracking" })).toBeVisible();

    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Tracker" }).click();
    await expect(page).toHaveURL(/\/app\/tracker$/);
    const interested = page.getByRole("region", { name: "Interested" });
    await expect(interested.getByRole("link", { name: PROGRAM.name })).toBeVisible();
    await expect(interested.getByRole("combobox", { name: `Move ${PROGRAM.name} to` })).toHaveValue(/.+/);
  });
});

test("on a phone, the notification center is reachable from the bell and the account menu", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("/app/explore");

  await page.getByRole("button", { name: /^Notifications/ }).click();
  await page.getByRole("link", { name: "See all notifications" }).click();
  await expect(page).toHaveURL(/\/app\/notifications$/);
  await expect(page.getByRole("heading", { level: 1, name: "Notifications" })).toBeVisible();

  await page.goto("/app/explore");
  await page.getByRole("button", { name: "Account and settings" }).click();
  await page.getByRole("navigation", { name: "Account" }).getByRole("link", { name: "Notifications" }).click();
  await expect(page).toHaveURL(/\/app\/notifications$/);
});
