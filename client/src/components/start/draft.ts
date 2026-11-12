/**
 * The "practise rep" inside onboarding: two opening sentences for "Why this program?".
 *
 * Without AI, Novus offers a template with blanks filled from non-PII signals (skills, field,
 * an experience type) plus deterministic checks. The checks are tips, not a grade: they never
 * add up to a score (rule 4). If the student later asks for AI feedback, the draft first goes
 * through redactForAi on the device, like the resume.
 */

export interface DraftSeed {
  programName: string;
  organizationName: string;
  /** The student's confirmed skills, already PII-free. */
  skills: readonly string[];
  /** A field or interest label such as "climate" or "computing". */
  interest: string | null;
  /** A generic experience kind such as "a class project" or "a club role". */
  experience: string | null;
  /** The planner's own template, used as-is when present. */
  template?: string | null;
}

/** A starting draft with visible [blanks] where the student has to say something specific. */
export function templateDraft(seed: DraftSeed): string {
  if (seed.template?.trim()) return seed.template.trim();
  const skill = seed.skills.slice(0, 2).join(" and ") || "[a skill you used]";
  const interest = seed.interest ?? "[the topic that pulls you in]";
  const exp = seed.experience ?? "[a class project, club or job]";
  return (
    `I want to join ${seed.programName} because I care about ${interest}, and I want to see how ${seed.organizationName} works on it up close. ` +
    `In ${exp}, I used ${skill} to [what you did and what changed because of it].`
  );
}

export interface DraftTip {
  id: "blanks" | "length" | "specific" | "program" | "contact" | "sentences";
  ok: boolean;
  text: string;
}

const CONTACT = /[\w.+-]+@[\w-]+\.[\w.]+|\+?\d[\d\s().-]{8,}\d|https?:\/\/\S+/;

function sentenceCount(text: string): number {
  return text
    .split(/[.!?]+(?:\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3).length;
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/**
 * Plain checks the student can act on. Each tip is pass/fix; none is weighted or summed.
 */
export function draftTips(text: string, programName: string): DraftTip[] {
  const words = wordCount(text);
  const sentences = sentenceCount(text);
  const hasBlank = /\[[^\]]*\]/.test(text);
  const namesProgram = programName
    .toLowerCase()
    .replace(/^sample\s+/, "")
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .some((w) => text.toLowerCase().includes(w));
  const specific = /\d/.test(text) || /\b(built|led|wrote|analy[sz]ed|designed|organized|taught|tested|measured|launched|fixed)\b/i.test(text);
  return [
    { id: "blanks", ok: !hasBlank, text: hasBlank ? "Fill in the [blanks] with your own words." : "No blanks left." },
    { id: "sentences", ok: sentences >= 2 && sentences <= 3, text: "Two or three sentences is plenty for an opening." },
    { id: "length", ok: words >= 25 && words <= 90, text: words < 25 ? "Add a little more: aim for 25 to 90 words." : words > 90 ? "Trim it: aim for 25 to 90 words." : "Good length for an opening." },
    { id: "specific", ok: specific, text: specific ? "You name something concrete you did." : "Name one concrete thing you did, with an action verb or a number." },
    { id: "program", ok: namesProgram, text: namesProgram ? "You say why this program, not just any program." : "Say why this program in particular." },
    { id: "contact", ok: !CONTACT.test(text), text: CONTACT.test(text) ? "Leave out emails, phone numbers and links here." : "No contact details in the draft." },
  ];
}
