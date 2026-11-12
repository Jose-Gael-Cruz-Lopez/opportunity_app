/**
 * Drives the /app/start quiz. The question order is adaptive (`@shared/onboarding`'s
 * `nextQuestion`), so the driver reads each screen's heading and answers by heading, not by
 * position. Unknown questions are skipped, which every question allows.
 */
import { expect, type Page } from "@playwright/test";

type Answer =
  | { pick: readonly string[] } // multi-select: press these, then Continue
  | { choose: string } // single choice: one press submits
  | { continue: true } // keep the prefilled or default value (slider, resume-prefilled multi)
  | { skip: true };

/** A plausible first-year life-sciences student. Labels are the visible option text. */
export const STUDENT_ANSWERS: ReadonlyArray<readonly [RegExp, Answer]> = [
  [/^What are you looking for\?/, { pick: ["Research", "Internships"] }],
  [/^What are you curious about\?/, { pick: ["Lab science", "Climate and environment"] }],
  [/^Which skills have you used\?/, { continue: true }],
  [/^What year are you in\?/, { choose: "First-year" }],
  [/^What do you study/, { choose: "Life sciences" }],
  [/^What fits your time better\?/, { choose: "Both sound good" }],
  [/^When could you do it\?/, { pick: ["Next summer"] }],
  [/^Where could you be\?/, { choose: "Happy to travel" }],
  [/^Does it need to pay you\?/, { choose: "Paid would be nice" }],
  [/^How many hours a week/, { continue: true }],
  [/^What have you done so far\?/, { pick: ["Research"] }],
  [/^What would make this a win\?/, { choose: "Get my first yes" }],
];

export const RESUME_HEADING = "Add your resume to skip some questions";
export const MATCHES_HEADING = "Here's where you fit best right now";

/** The SAMPLE resume pasted in onboarding: invented person, reserved example.com address. */
export const SAMPLE_RESUME = {
  name: "Sample Student",
  email: "sample.student@example.com",
  phone: "(555) 010-0199",
  employer: "Campus Writing Center",
  text: `Sample Student
sample.student@example.com | (555) 010-0199 | Sample City

EDUCATION
Sample State University, B.S. Biology, expected May 2029
GPA: 3.6
Relevant coursework: General Chemistry, Calculus I, Introduction to Biology

EXPERIENCE
Research Assistant, Sample Ecology Lab, Sep 2025 - Present
- Collected field samples and recorded data in Excel
- Analyzed plant growth data with Python and R

Tutor, Campus Writing Center, Jan 2025 - May 2025
- Tutored 20 students a week in writing

SKILLS
Python, R, Excel, data analysis, field research, scientific writing
`,
} as const;

/** The heading of the current onboarding screen (every screen has one h2 or, at the end, an h1). */
export function screenHeading(page: Page) {
  return page.locator("main h2").first();
}

/**
 * Answers quiz questions until `stopAt` (a heading) is on screen. Returns the headings seen,
 * in order.
 */
export async function answerQuizUntil(
  page: Page,
  stopAt: string,
  answers: ReadonlyArray<readonly [RegExp, Answer]> = STUDENT_ANSWERS,
): Promise<string[]> {
  const seen: string[] = [];
  for (let guard = 0; guard < 30; guard++) {
    const heading = screenHeading(page);
    await expect(heading).toBeVisible();
    const text = (await heading.innerText()).trim();
    if (text === stopAt) return seen;
    seen.push(text);
    const question = page.getByRole("region", { name: text });
    const answer = answers.find(([re]) => re.test(text))?.[1] ?? { skip: true };

    if ("pick" in answer) {
      for (const label of answer.pick) {
        const option = question.getByRole("button", { name: label, exact: true });
        if ((await option.getAttribute("aria-pressed")) !== "true") await option.click();
      }
      await question.getByRole("button", { name: "Continue" }).click();
    } else if ("choose" in answer) {
      await question.getByRole("radio", { name: answer.choose, exact: true }).click();
    } else if ("continue" in answer) {
      const go = question.getByRole("button", { name: "Continue" });
      if (await go.isDisabled()) {
        // Nothing prefilled: take the first answer rather than leave the question empty.
        await question.getByRole("group").getByRole("button").first().click();
      }
      await go.click();
    } else {
      await question.getByRole("button", { name: /skip/i }).click();
    }
    await expect(screenHeading(page)).not.toHaveText(text);
  }
  throw new Error(`quiz did not reach "${stopAt}"; saw ${seen.join(" / ")}`);
}
