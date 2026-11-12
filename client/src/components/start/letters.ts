/**
 * Picking recommenders during onboarding. The student chooses a role ("a professor", "a
 * manager") and, optionally, a first name that stays in React memory only: third-party names
 * are never autosaved, sent to a server or shown to an AI. The ask email is a template the
 * student copies into their own mail app.
 */

export const RECOMMENDER_ROLES = [
  { id: "professor", label: "A professor or instructor", hint: "Someone whose class you did well in or spoke up in" },
  { id: "ta", label: "A TA or lab lead", hint: "Knows your work week to week" },
  { id: "manager", label: "A manager or supervisor", hint: "From a job, internship or volunteer role" },
  { id: "advisor", label: "A club or research advisor", hint: "Saw you lead or build something" },
  { id: "teacher", label: "A high-school teacher", hint: "Fine for first-years when allowed" },
  { id: "coach", label: "A coach or mentor", hint: "Can speak to commitment and growth" },
] as const;
export type RecommenderRoleId = (typeof RECOMMENDER_ROLES)[number]["id"];

export interface RecommenderPick {
  role: RecommenderRoleId;
  /** Optional, in memory only. */
  name?: string;
}

/** Letter lead time used across Novus (plan 06): ask at least 21 days before it is due. */
export const LETTER_LEAD_DAYS = 21;

/** The latest date to ask, YYYY-MM-DD, or null when the deadline is rolling. */
export function askBy(deadline: string | null): string | null {
  if (!deadline) return null;
  const t = Date.parse(`${deadline}T00:00:00Z`) - LETTER_LEAD_DAYS * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export interface AskEmailInput {
  programName: string;
  deadline: string | null;
  recommenderName?: string;
  /** What the student wants the recommender to speak to; their own words. */
  focus?: string;
}

function longDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

export function askEmail(input: AskEmailInput): { subject: string; body: string } {
  const greet = input.recommenderName?.trim() ? `Dear ${input.recommenderName.trim()},` : "Dear [their name],";
  const due = input.deadline ? `The letter is due ${longDate(input.deadline)}.` : "The program reviews applications on a rolling basis.";
  const focus = input.focus?.trim() || "[the class, project or role where you worked together]";
  return {
    subject: `Letter of recommendation for ${input.programName}`,
    body: [
      greet,
      "",
      `I'm applying to ${input.programName}, and I'd be grateful if you would write a letter of recommendation for me. I think you could speak well to ${focus}.`,
      "",
      `${due} I'll send my resume, a short summary of the program and a reminder a week before. If you can't this time, I completely understand.`,
      "",
      "Thank you,",
      "[your name]",
    ].join("\n"),
  };
}

export function mailtoHref(subject: string, body: string): string {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
