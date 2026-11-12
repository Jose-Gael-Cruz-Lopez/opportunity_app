import type { OpportunityCategory, ProgramCard } from "@shared/contracts";
import type { MatchView } from "./normalize";

/**
 * Student-facing copy built from match data. Counts and dates only; no sentence here turns
 * into a percentage or a score about the student (rule 4).
 */

export const OPPORTUNITY_CATEGORY_LABELS: Record<OpportunityCategory, string> = {
  internships: "Internships",
  fellowships: "Fellowships",
  research: "Research",
  apprenticeships: "Apprenticeships",
  scholarships: "Scholarships",
  insight_weeks: "Insight weeks",
  sprints: "Sprints",
  conferences: "Conferences and competitions",
};

/** "Wed 2 Dec" from YYYY-MM-DD, formatted in UTC so the label never shifts a day by zone. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "";
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

export function feasibilityLine(m: Pick<MatchView, "startBy" | "daysLeft" | "enoughTime">): string {
  if (m.daysLeft === null && !m.startBy) return "Rolling: apply any time";
  if (!m.enoughTime) return m.daysLeft !== null ? `Tight timeline: closes in ${days(m.daysLeft)}` : "Tight timeline";
  const start = m.startBy ? `Start by ${shortDate(m.startBy)}` : "Start soon";
  return m.daysLeft !== null ? `${start} · ${days(m.daysLeft)} left` : start;
}

/** "You meet 3 of 5 listed requirements", or nothing when the program lists none. */
export function requirementsLine(met: number, total: number): string {
  if (total <= 0) return "";
  if (met >= total) return `You already have everything listed (${total} of ${total}).`;
  return `You meet ${met} of ${total} listed requirements.`;
}

const money = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;

export function compensationLabel(card: Pick<ProgramCard, "compensation">): string {
  const c = card.compensation;
  if (!c || c.kind === "none") return "";
  if (c.kind === "salary_hourly") return c.amountCents ? `Paid · ${money(c.amountCents)} an hour` : "Paid hourly";
  if (c.kind === "stipend") return c.amountCents ? `Stipend · ${money(c.amountCents)}` : "Stipend";
  if (c.kind === "award") return c.amountCents ? `Award · ${money(c.amountCents)}` : "Award";
  if (c.kind === "travel") return c.note ?? "Travel covered";
  if (c.kind === "tuition") return "Tuition support";
  return c.note ?? "Pay varies";
}

const ORDINAL = ["first", "second", "third", "fourth", "fifth"];

/** "a first-year" for 1..5 (yearInSchool is clamped to that range). */
export function yearLabel(n: number): string {
  return `a ${ORDINAL[Math.min(5, Math.max(1, Math.trunc(n))) - 1]}-year`;
}

const EXPERIENCE_PHRASES: Record<string, string> = {
  internship: "an internship",
  research: "a research project",
  "part-time": "a part-time job",
  part_time: "a part-time job",
  paid_work: "a part-time job",
  leadership: "a leadership role",
  club: "a club or team",
  volunteer: "volunteering",
  community_service: "volunteering",
  teaching: "tutoring",
  teaching_or_tutoring: "tutoring",
  independent_project: "a personal project",
  competition: "a competition",
  insight_program: "an insight program",
};

/** A phrase for the practice draft ("In a club or team, I used ..."), or null. */
export function experiencePhrase(kinds: readonly string[]): string | null {
  for (const k of kinds) if (EXPERIENCE_PHRASES[k]) return EXPERIENCE_PHRASES[k];
  return null;
}

/** "Climate and environment" -> "climate and environment"; keeps acronyms like "AI and data". */
export function lowerFirst(label: string): string {
  return /^[A-Z]{2}/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}
