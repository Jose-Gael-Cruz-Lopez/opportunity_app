/**
 * The guided first five minutes at /app/start, as a newly signed-in student:
 * quiz, a pasted resume read on the device, the redaction preview, matches without any
 * percentage, then the first door's four readiness parts and quick steps, and saving the plan.
 *
 * Privacy is asserted on the wire: the resume's contact lines and raw text never appear in any
 * request, nothing is sent to the AI route without consent, and with no Gemini key the page
 * says AI is off.
 */
import { uniqueEmail } from "./support/email";
import { expect, expectNoStudentScore, signInThroughUi, test } from "./support/fixtures";
import { MATCHES_HEADING, RESUME_HEADING, SAMPLE_RESUME, answerQuizUntil, screenHeading } from "./support/onboarding";

const TIERS = /^(Strong fit|Good fit|Stretch: worth a try)/;

test("a new student goes from quiz to a started first application", async ({ page, outgoing }) => {
  test.setTimeout(180_000);
  await signInThroughUi(page, uniqueEmail("onboarding"));
  await expect(page).toHaveURL(/\/app\/start$/);

  await test.step("welcome", async () => {
    await expect(page).toHaveTitle(/Novus/);
    await expect(page.getByRole("list", { name: "What happens next" }).getByRole("listitem")).toHaveCount(4);
    await page.getByRole("button", { name: "Let's go" }).click();
    await expect(page.getByRole("progressbar", { name: "Onboarding progress" })).toBeVisible();
  });

  await test.step("quiz up to the resume step", async () => {
    const seen = await answerQuizUntil(page, RESUME_HEADING);
    expect(seen[0]).toBe("What are you looking for?");
  });

  await test.step("paste a resume; it is read on this device", async () => {
    const resume = page.getByRole("region", { name: RESUME_HEADING });
    await expect(resume).toContainText("The file is never uploaded");
    const read = resume.getByRole("button", { name: "Read my resume" });
    await expect(read).toBeDisabled();
    await resume.getByRole("textbox", { name: "Or paste your resume text" }).fill(SAMPLE_RESUME.text);
    await read.click();

    const review = page.getByRole("region", { name: "Here's what Novus read. Fix anything that's off." });
    await expect(review.getByRole("note")).toContainText("Stays on this device:");
    await expect(review.getByRole("note")).toContainText("Email");
    await expect(review.getByRole("textbox", { name: "Major or intended major" })).toHaveValue("Biology");
    await expect(review.getByRole("button", { name: "Remove Python" })).toBeVisible();

    // Removing a chip by keyboard keeps focus in the list (never drops to <body>); put it back.
    await review.getByRole("button", { name: "Remove Python" }).focus();
    await page.keyboard.press("Enter");
    await expect(review.getByRole("button", { name: "Remove Python" })).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
    await review.getByRole("textbox", { name: "Add skills" }).fill("Python");
    await page.keyboard.press("Enter");
    await expect(review.getByRole("button", { name: "Remove Python" })).toBeVisible();

    await review.getByRole("button", { name: "Looks right" }).click();
  });

  await test.step("redaction preview: exactly what AI would read, AI off by default and off on this server", async () => {
    const preview = page.getByRole("region", { name: "Your matches use these signals" });
    const outgoingText = preview.locator("pre");
    await expect(outgoingText).toBeVisible();
    const shown = await outgoingText.innerText();
    expect(shown).toContain("Biology");
    expect(shown).toContain("Python");
    for (const secret of [SAMPLE_RESUME.name, SAMPLE_RESUME.email, SAMPLE_RESUME.phone, "Sample State University"]) {
      expect(shown, `preview leaks "${secret}"`).not.toContain(secret);
    }
    await expect(preview).toContainText(/Taken out first: \d+ contact or name details?/);

    // The device-only list of what was removed.
    await preview.getByText("What was taken out (only you can see this)").click();
    await expect(preview.locator("details")).toContainText(SAMPLE_RESUME.email);

    // Consent is off by default, and with no Gemini key the server reports AI as off.
    const consent = preview.getByRole("switch", { name: "Let AI read this text" });
    await expect(consent).toHaveAttribute("aria-checked", "false");
    await expect(preview).toContainText("AI reading is switched off on this server");
    await consent.click();
    await expect(preview.getByRole("button", { name: "Send this text" })).toBeDisabled();

    await preview.getByRole("button", { name: /^Next: |^Continue$/ }).click();
  });

  await test.step("rest of the quiz, with resume answers offered as confirmations", async () => {
    await answerQuizUntil(page, MATCHES_HEADING);
  });

  let chosenName = "";
  await test.step("matches: tiers and plain reasons, never a percentage", async () => {
    const matches = page.getByRole("region", { name: MATCHES_HEADING });
    await expect(matches).toContainText("Every card says why it's here.");
    const cards = page.getByRole("main").getByRole("article");
    await expect(cards.first()).toBeVisible();
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const card = cards.nth(i);
      await expect(card).toContainText(TIERS);
      await expect(card).toContainText("Sample");
      const reasons = card.getByRole("list", { name: "Why this is here" }).getByRole("listitem");
      expect(await reasons.count()).toBeGreaterThanOrEqual(1);
    }
    await expectNoStudentScore(page);

    // "Why this?" opens a plain-language explanation, still without a number about the student.
    await cards.first().getByText("Why this?").click();
    await expectNoStudentScore(page, cards.first());
    chosenName = (await cards.first().getByRole("heading", { level: 3 }).innerText()).trim();
    await page.getByRole("button", { name: "Pick your first door" }).click();
  });

  await test.step("first door: the student picks; readiness shows four parts", async () => {
    await expect(screenHeading(page)).toHaveText("Pick one to start today");
    const option = page.getByRole("article", { name: chosenName });
    await option.getByRole("button", { name: "Start this one" }).click();

    const readiness = page.getByRole("region", { name: "Four things to know" });
    await expect(readiness.getByRole("heading", { level: 4 })).toHaveText([
      "1 · Eligibility",
      "2 · Requirements",
      "3 · Competitiveness",
      "4 · Next actions",
    ]);
    await expect(readiness).toContainText("Novus never shows a chance or a score about you.");
    await expectNoStudentScore(page, readiness);
  });

  await test.step("first quick steps: save, eligibility, two sentences", async () => {
    const plan = page.getByRole("region", { name: "Your plan for this application" });
    // By keyboard: the finished panel closes, focus moves to the next step and a status says so.
    await plan.getByRole("button", { name: "Save to my Tracker" }).focus();
    await page.keyboard.press("Enter");
    await expect(plan.getByRole("button", { name: /^Save it to your Tracker .*· done/ })).toBeVisible();
    await expect(plan.getByRole("button", { name: /^Check the eligibility rules privately/ })).toBeFocused();
    await expect(plan.getByRole("status").filter({ hasText: "Done: Save it to your Tracker" })).toHaveCount(1);

    await plan.getByRole("button", { name: "Confirmed" }).click();
    await expect(plan.getByRole("button", { name: /^Check the eligibility rules privately .*· done/ })).toBeVisible();

    const draft = plan.getByRole("textbox", { name: "Why this program? Two sentences." });
    await expect(plan).toContainText("AI feedback is off.");
    await draft.fill(
      "I analyzed plant growth data with Python for a campus ecology lab and want to keep building hands-on skills in a paid setting. " +
        "This program stands out because it pairs real work with mentoring from people who do it every day.",
    );
    await expect(plan.getByRole("list", { name: "Novus checks" })).toContainText("No contact details in the draft.");
    await plan.getByRole("button", { name: /^(I'm happy with this|Good enough for now)$/ }).click();
    await expect(plan).toContainText("Quick steps done");
    await plan.getByRole("button", { name: /^(I'm all set|Finish for today)$/ }).click();
  });

  await test.step("done: save the plan to the account", async () => {
    await expect(page.getByRole("heading", { level: 1, name: "You've started your first application." })).toBeVisible();
    await expect(page.getByRole("main")).toContainText(chosenName);
    await expect(page.getByRole("main")).toContainText(/3\/\d+\s*steps done/);

    const saved = page.waitForResponse((r) => r.url().endsWith("/api/v1/onboarding/first-door") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Save my plan" }).click();
    expect((await saved).status()).toBeLessThan(300);

    const session = (await (await page.request.get("/api/v1/me/session")).json()) as { user: { onboarded: boolean } };
    expect(session.user.onboarded).toBe(true);
  });

  await test.step("the first door is on the Tracker", async () => {
    await page.goto("/app/tracker");
    await expect(page.getByRole("main").getByText(chosenName).first()).toBeVisible();
  });

  await test.step("privacy on the wire and on the device", async () => {
    expect(outgoing.some((r) => r.url.includes("/onboarding/resume/extract")), "resume text sent without consent").toBe(false);
    for (const req of outgoing) {
      for (const secret of [SAMPLE_RESUME.email, SAMPLE_RESUME.phone, SAMPLE_RESUME.name, SAMPLE_RESUME.employer]) {
        expect(req.body, `${req.method} ${req.url} carries "${secret}"`).not.toContain(secret);
        expect(req.url, `${req.url} carries "${secret}"`).not.toContain(encodeURIComponent(secret));
      }
    }
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    for (const secret of [SAMPLE_RESUME.email, SAMPLE_RESUME.phone, SAMPLE_RESUME.employer]) {
      expect(stored, `browser storage keeps "${secret}"`).not.toContain(secret);
    }
  });
});
