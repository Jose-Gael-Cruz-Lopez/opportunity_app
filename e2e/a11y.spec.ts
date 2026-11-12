/**
 * Accessibility smoke tests: structure checks on the main pages, and keyboard-only use of the
 * skip link, Explore search and the onboarding quiz. Not a full audit (no axe-core in this
 * repository); it catches regressions that make a page unusable without a mouse or a screen.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./support/fixtures";
import { answerQuizUntil, RESUME_HEADING } from "./support/onboarding";

const PROGRAM_SLUG = "sample-summer-research-fellowship";

const PAGES = [
  "/",
  "/explore",
  `/programs/${PROGRAM_SLUG}`,
  "/deadlines",
  "/app",
  "/app/explore",
  `/app/programs/${PROGRAM_SLUG}`,
  "/app/start",
  "/app/sign-in",
] as const;

/** Interactive roles that must always carry an accessible name. */
const NAMED_ROLES = ["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "img"];

/** Lines of the accessibility tree where an interactive role has no name. */
function unnamed(snapshot: string): string[] {
  const re = new RegExp(`^\\s*- (${NAMED_ROLES.join("|")})(?: \\[[^\\]]*\\])*:?\\s*$`);
  return snapshot.split("\n").filter((line) => re.test(line));
}

async function activeElementSummary(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return "none";
    return `${el.tagName.toLowerCase()}[${el.getAttribute("role") ?? ""}] ${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 60)}`;
  });
}

/** Presses Tab until `target` is focused; fails after `max` presses. */
async function tabTo(page: Page, target: ReturnType<Page["locator"]>, max = 40): Promise<number> {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press("Tab");
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return i;
  }
  throw new Error(`Tab never reached the target; last focus: ${await activeElementSummary(page)}`);
}

test.describe("page structure", () => {
  for (const path of PAGES) {
    test(`${path}: language, title, one h1, landmarks, named controls`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBe(200);
      await expect(page.locator("main").first()).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();

      expect(await page.locator("html").getAttribute("lang")).toMatch(/^en/);
      expect((await page.title()).length).toBeGreaterThan(3);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("main")).toHaveCount(1);

      const tree = await page.locator("body").ariaSnapshot();
      expect(unnamed(tree), "controls without an accessible name").toEqual([]);

      // Every image is either decorative or described.
      const undescribed = await page.locator("img:not([alt]):not([aria-hidden='true'])").count();
      expect(undescribed, "img without alt").toBe(0);
    });
  }
});

test.describe("keyboard", () => {
  test("public landing: the skip link is the first stop and moves past the header", async ({ page }) => {
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible(); // visible when focused, not only to screen readers
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
    await page.keyboard.press("Tab");
    const insideMain = await page.evaluate(() => !!document.activeElement?.closest("main, #main"));
    expect(insideMain, `focus after skip: ${await activeElementSummary(page)}`).toBe(true);
  });

  test("app Explore: reach search by keyboard, filter, and open a program with Enter", async ({ page }) => {
    await page.goto("/app/explore");
    await expect(page.getByRole("main").getByRole("article").first()).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();

    const search = page.getByRole("main").getByRole("searchbox", { name: "Search programs" });
    await tabTo(page, search);
    await page.keyboard.type("research");
    const link = page.getByRole("main").getByRole("link", { name: "Sample Summer Research Fellowship" });
    await expect(link).toBeVisible();

    await tabTo(page, link, 80);
    // The focused control shows a focus indicator, on itself or on its card (:focus-within).
    const indicator = await link.evaluate((el) => {
      let node: Element | null = el;
      for (let depth = 0; node && depth < 5; depth++, node = node.parentElement) {
        const s = getComputedStyle(node);
        if (s.outlineStyle !== "none" && s.outlineWidth !== "0px") return true;
        if (node === el && (s.boxShadow !== "none" || s.textDecorationLine.includes("underline"))) return true;
      }
      return false;
    });
    expect(indicator, "focused link has no visible focus indicator").toBe(true);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/app/programs/${PROGRAM_SLUG}`));
    await expect(page.getByRole("heading", { level: 1, name: "Sample Summer Research Fellowship" })).toBeVisible();
  });

  test("onboarding quiz works with the keyboard alone", async ({ page }) => {
    await page.goto("/app/start");
    const go = page.getByRole("button", { name: "Let's go" });
    await expect(go).toBeVisible();
    await tabTo(page, go);
    await page.keyboard.press("Enter");

    // Each new question moves focus to its heading.
    const q1 = page.getByRole("heading", { level: 2, name: "What are you looking for?" });
    await expect(q1).toBeFocused();

    // Multi-select: Tab into the answers, digits toggle, then Tab to Continue and press Enter.
    const answers = page.getByRole("group", { name: "What are you looking for?" });
    await page.keyboard.press("Tab");
    await expect(answers.getByRole("button").first()).toBeFocused();
    await page.keyboard.press("3");
    await expect(answers.getByRole("button", { name: "Research", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("1");
    await expect(answers.getByRole("button", { name: "Internships", exact: true })).toHaveAttribute("aria-pressed", "true");
    await tabTo(page, page.getByRole("button", { name: "Continue" }));
    await page.keyboard.press("Enter");
    // The next question (its order adapts to the answers) takes focus on its heading.
    await expect(q1).toBeHidden();
    await expect(page.locator("#st-q-title")).toBeFocused();

    // Skip the rest of the way to a single-choice question with the shared driver.
    await answerQuizUntil(page, RESUME_HEADING);
    await tabTo(page, page.getByRole("button", { name: "Skip for now" }));
    await page.keyboard.press("Enter");
    await answerQuizUntil(page, "What year are you in?");

    // Single choice is a radio group with one tab stop: arrows check without submitting,
    // Space submits.
    const year = page.getByRole("heading", { level: 2, name: "What year are you in?" });
    await expect(year).toBeFocused();
    const radios = page.getByRole("radiogroup", { name: "What year are you in?" }).getByRole("radio");
    await page.keyboard.press("Tab");
    await expect(radios.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(radios.nth(1)).toBeFocused();
    await expect(radios.nth(1)).toHaveAttribute("aria-checked", "true");
    await expect(year).toBeVisible(); // still on the same question
    await page.keyboard.press("Space");
    await expect(year).toBeHidden();
    await expect(page.locator("main h2").first()).toBeFocused();
  });

  // The quiz tip says "Enter continues": in a multi-choice question Enter on a focused answer
  // continues (Space toggles it), handled by the answer list in quiz-step.tsx onOptionsKeyDown.
  test("Enter continues a multi-choice question from the answer list, as the tip says", async ({ page }) => {
    await page.goto("/app/start");
    await page.getByRole("button", { name: "Let's go" }).click();
    const q1 = page.getByRole("heading", { level: 2, name: "What are you looking for?" });
    await expect(q1).toBeFocused();
    await expect(page.getByRole("main")).toContainText("Enter continues");
    await page.keyboard.press("Tab");
    await page.keyboard.press("3");
    await page.keyboard.press("Enter");
    await expect(q1).toBeHidden({ timeout: 3_000 });
  });
});
