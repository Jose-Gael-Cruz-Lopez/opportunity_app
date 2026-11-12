import { describe, expect, it } from "vitest";
import { draftTips, templateDraft } from "./draft";
import { LETTER_LEAD_DAYS, askBy, askEmail, mailtoHref } from "./letters";

const seed = {
  programName: "Sample Coastal Data Summer Fellowship",
  organizationName: "Sample Ocean Lab",
  skills: ["Python", "Data analysis", "SQL"],
  interest: "climate",
  experience: "a research project",
};

describe("practice draft", () => {
  it("fills a template from non-PII signals and leaves blanks for the student", () => {
    const t = templateDraft(seed);
    expect(t).toContain("Sample Coastal Data Summer Fellowship");
    expect(t).toContain("Python and Data analysis");
    expect(t).toContain("In a research project");
    expect(t).toMatch(/\[what you did/);
  });

  it("uses blanks when signals are missing, and the planner's template when given", () => {
    const t = templateDraft({ ...seed, skills: [], interest: null, experience: null });
    expect(t).toContain("[a skill you used]");
    expect(t).toContain("[the topic that pulls you in]");
    expect(templateDraft({ ...seed, template: "  Planner text.  " })).toBe("Planner text.");
  });

  it("gives pass/fix tips, never a score", () => {
    const tips = draftTips(templateDraft(seed), seed.programName);
    expect(tips.find((t) => t.id === "blanks")?.ok).toBe(false);
    const good =
      "I want to join the Coastal Data fellowship because I care about how climate change reshapes coastlines. In a research project last spring, I analyzed 3 years of tide data in Python and found a seasonal pattern my lab now tracks.";
    const ok = draftTips(good, seed.programName);
    expect(ok.every((t) => t.ok)).toBe(true);
    expect(JSON.stringify(ok)).not.toMatch(/score|percent|\d+\s*\/\s*\d+/i);
  });

  it("flags contact details in a draft", () => {
    const tips = draftTips("Email me at jane@example.com or 555-010-1234 about Coastal.", seed.programName);
    expect(tips.find((t) => t.id === "contact")?.ok).toBe(false);
  });
});

describe("letters", () => {
  it("asks three weeks before the deadline", () => {
    expect(LETTER_LEAD_DAYS).toBe(21);
    expect(askBy("2026-12-26")).toBe("2026-12-05");
    expect(askBy(null)).toBeNull();
  });

  it("builds an ask email with placeholders when names are not given", () => {
    const e = askEmail({ programName: "Sample Program", deadline: "2026-12-26" });
    expect(e.subject).toBe("Letter of recommendation for Sample Program");
    expect(e.body).toContain("Dear [their name],");
    expect(e.body).toContain("Saturday, December 26");
    expect(e.body).toContain("[your name]");
  });

  it("uses a name and focus when the student typed them, and handles rolling programs", () => {
    const e = askEmail({ programName: "P", deadline: null, recommenderName: " Dr. Rivera ", focus: "my lab work" });
    expect(e.body.startsWith("Dear Dr. Rivera,")).toBe(true);
    expect(e.body).toContain("my lab work");
    expect(e.body).toContain("rolling basis");
  });

  it("encodes a mailto link without a recipient", () => {
    const href = mailtoHref("A & B", "line 1\nline 2");
    expect(href).toBe("mailto:?subject=A%20%26%20B&body=line%201%0Aline%202");
  });
});
