import { PRODUCT } from "@shared/config/product";
import { analyzeRequirement, progressMap, READINESS_CONFIG, type ProgressEntry } from "@shared/readiness";
import { addDays } from "@shared/time/iso";
import { absoluteLink, escapeHtml, safeSubject } from "@server/services/email/templates";
import { deadlineLine, effectiveFor, formatDay, isNeutral, type CycleInfo, type FollowedCycle, type RecipientContext, type ReminderDraft } from "./plan";
import { recipientToday } from "./policy";

/**
 * The weekly email (plan 6.7.2-6.7.3), one composer for every recipient: every start-by date and
 * deadline in the next 14 days for the cycles they follow, any T−2 reminder that falls on the
 * weekly day, and the week's changes to those cycles that waited for this email. Skipped when
 * all three are empty. Plain text first; no tracking pixel, no remote images, no promotions.
 */

export interface WeeklyEntry {
  readonly date: string;
  readonly kind: "deadline" | "start_by";
  readonly program: string;
  readonly text: string;
  readonly href: string;
}

export interface WeeklyChange {
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
}

export interface WeeklyInput {
  readonly recipient: RecipientContext;
  readonly cycles: readonly { readonly followed: FollowedCycle; readonly info: CycleInfo }[];
  /** The recipient's requirement progress (accounts only), so finished items are not listed. */
  readonly progress: readonly ProgressEntry[];
  readonly changes: readonly WeeklyChange[];
  /** T−2 reminders merged into this email (plan 6.7.2). */
  readonly dueSoon: readonly ReminderDraft[];
  readonly now: number;
}

export interface WeeklyContent {
  readonly entries: readonly WeeklyEntry[];
  readonly changes: readonly WeeklyChange[];
  readonly dueSoon: readonly ReminderDraft[];
  readonly today: string;
}

const NEUTRAL_PROGRAM = "A program you saved";

function programName(info: CycleInfo, neutral: boolean): string {
  if (neutral) return NEUTRAL_PROGRAM;
  return `${info.programName} (${info.termLabel})${info.isSample ? " [sample listing]" : ""}`;
}

/** Collects the email's items; empty arrays everywhere mean "skip this week". */
export function collectWeekly(input: WeeklyInput): WeeklyContent {
  const today = recipientToday(input.now, input.recipient.zone);
  const end = addDays(today, PRODUCT.weekly.windowDays);
  const progress = progressMap(input.progress);
  const entries: WeeklyEntry[] = [];
  for (const { followed, info } of input.cycles) {
    const eff = effectiveFor(input.recipient, followed, info, input.now);
    if (!eff || eff.closed) continue;
    const neutral = isNeutral(info, followed);
    const program = programName(info, neutral);
    const href = neutral ? "/app/tracker" : `/programs/${encodeURIComponent(info.programSlug)}`;
    if (!eff.passed && eff.date >= today && eff.date <= end) {
      entries.push({ date: eff.date, kind: "deadline", program, text: `${neutral ? "Deadline" : eff.label}: ${deadlineLine(eff)}`, href });
    }
    const ownDeadlineDates = new Map<string, string>();
    for (const d of info.deadlines) if (d.localDate && d.localDate.length === 10) ownDeadlineDates.set(d.id, d.localDate);
    const campusScoped = eff.scope === "campus" || eff.step === "campus_estimate_e1" || eff.step === "campus_estimate_e2";
    const gated = info.requirements.some((r) => r.kind === "campus_nomination") || info.deadlines.some((d) => d.kind === "nomination");
    for (const r of info.requirements) {
      const a = analyzeRequirement(r, {
        dueDate: eff.passed ? null : eff.date,
        ownDeadlineDates,
        progress,
        eligibility: null,
        hoursPerDay: READINESS_CONFIG.hoursPerDay,
        campusScoped,
        nominationGated: gated,
      });
      const startBy = a.isolatedLatestStart;
      if (!a.open || !startBy || startBy < today || startBy > end) continue;
      entries.push({
        date: startBy,
        kind: "start_by",
        program,
        text: neutral ? `Start by ${formatDay(startBy)}: a requirement` : `Start by ${formatDay(startBy)}: ${r.label}`,
        href,
      });
    }
  }
  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === b.kind ? a.program.localeCompare(b.program) : a.kind === "start_by" ? -1 : 1));
  return { entries, changes: input.changes, dueSoon: input.dueSoon, today };
}

export function isEmptyWeekly(content: WeeklyContent): boolean {
  return content.entries.length === 0 && content.changes.length === 0 && content.dueSoon.length === 0;
}

export interface RenderedWeekly {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Short line for the in-app notification center. */
  readonly summary: string;
}

function countLine(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Renders the weekly email. Subjects never name a program, so inbox previews reveal nothing. */
export function renderWeekly(content: WeeklyContent, opts: { appOrigin: string; unsubscribeUrl: string | null }): RenderedWeekly {
  const parts: string[] = [];
  if (content.dueSoon.length > 0) parts.push(countLine(content.dueSoon.length, "deadline in 2 days", "deadlines in 2 days"));
  if (content.entries.length > 0) parts.push(countLine(content.entries.length, "date in the next two weeks", "dates in the next two weeks"));
  if (content.changes.length > 0) parts.push(countLine(content.changes.length, "change", "changes"));
  const summary = parts.join(", ");
  const subject = safeSubject(content.dueSoon.length > 0 ? `Due in 2 days, plus your next two weeks` : `Your next two weeks on Novus: ${summary}`);

  const text: string[] = [`Your week ahead (from ${formatDay(content.today)})`, ""];
  const html: string[] = [
    '<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:560px">',
    `<h1 style="font-size:18px;margin:0 0 12px">Your week ahead</h1>`,
  ];
  const section = (heading: string, lines: { text: string; href: string | null }[]) => {
    if (lines.length === 0) return;
    text.push(heading, ...lines.map((l) => `- ${l.text}${l.href ? ` (${absoluteLink(opts.appOrigin, l.href)})` : ""}`), "");
    html.push(`<h2 style="font-size:15px;margin:20px 0 6px">${escapeHtml(heading)}</h2><ul style="padding-left:18px;margin:0">`);
    for (const l of lines) {
      const label = escapeHtml(l.text);
      html.push(`<li style="margin:0 0 6px">${l.href ? `<a href="${escapeHtml(absoluteLink(opts.appOrigin, l.href))}">${label}</a>` : label}</li>`);
    }
    html.push("</ul>");
  };
  section(
    "Due in 2 days",
    content.dueSoon.map((d) => ({ text: `${d.neutral ? NEUTRAL_PROGRAM : d.title.replace(/^Due in 2 days: /, "")}: ${d.deadlineLine}`, href: d.href })),
  );
  section(
    `Next ${PRODUCT.weekly.windowDays} days`,
    content.entries.map((e) => ({ text: `${formatDay(e.date)} · ${e.program} · ${e.text}`, href: e.href })),
  );
  section(
    "Changes to programs you follow",
    content.changes.map((c) => ({ text: `${c.title}. ${c.body}`, href: c.href })),
  );

  const footer = [
    "Always confirm dates on the program's official page before you rely on them.",
    "You get this email because you follow programs on Novus.",
    `Email settings: ${absoluteLink(opts.appOrigin, "/app/settings")}`,
    opts.unsubscribeUrl ? `Stop the weekly email: ${opts.unsubscribeUrl}` : null,
  ].filter((l): l is string => l !== null);
  text.push("--", ...footer);
  html.push('<hr style="border:none;border-top:1px solid #ddd;margin-top:24px">');
  for (const line of footer) {
    if (opts.unsubscribeUrl && line.startsWith("Stop the weekly email")) {
      html.push(`<p style="font-size:12px;color:#555"><a href="${escapeHtml(opts.unsubscribeUrl)}">Stop the weekly email</a></p>`);
    } else {
      html.push(`<p style="font-size:12px;color:#555">${escapeHtml(line)}</p>`);
    }
  }
  html.push("</body></html>");
  return { subject, text: text.join("\n"), html: html.join(""), summary };
}
