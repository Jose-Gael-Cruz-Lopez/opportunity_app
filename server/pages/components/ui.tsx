/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import type { ProgramCard } from "@shared/contracts";
import { PRODUCT } from "@shared/config/product";
import { formatDate } from "../format";
import {
  classYearText,
  compensationText,
  describeStatus,
  describeVerification,
  nextDeadline,
  primaryGroupLabel,
  type DeadlineDisplay,
  type StatusDisplay,
  type Tone,
  type VerificationDisplayLine,
} from "../view-model";
import { Icon } from "./layout";

/** Small shared pieces of public pages. Colour always comes with a word and an icon. */

const TONE_ICON: Readonly<Record<Tone, string>> = { good: "check", warn: "clock", late: "alert", neutral: "info" };

export function StatusChip(props: { status: StatusDisplay }) {
  return (
    <span class={`chip ${props.status.tone}`}>
      <span class="led" aria-hidden="true" />
      {props.status.label}
    </span>
  );
}

export function SampleTag() {
  return (
    <span class="sample-tag" title="Invented record for demonstration">
      Sample
    </span>
  );
}

export function VerificationLine(props: { line: VerificationDisplayLine }) {
  const { line } = props;
  return (
    <p class={`ver ${line.tone}`}>
      <Icon name={TONE_ICON[line.tone]} />
      <span>
        {line.label}
        {line.detail ? ` · ${line.detail}` : ""}
      </span>
    </p>
  );
}

/**
 * The deadline line: what the official page states, in its own zone, plus a placeholder the page
 * island fills with the viewer's local time. Applicant-local rows carry their date so the island
 * can count days on the viewer's clock.
 */
export function DeadlineWhen(props: { d: DeadlineDisplay; class?: string }) {
  const { d } = props;
  return (
    <span
      class={props.class}
      data-instant={d.instantIso ?? undefined}
      data-applicant-date={d.applicantLocal?.date}
      data-applicant-time={d.applicantLocal?.time ?? undefined}
    >
      {d.instantIso ? <time datetime={d.instantIso}>{d.primary}</time> : d.primary}
      {d.instantIso ? <span class="js-local local" hidden /> : null}
    </span>
  );
}

/** Day count in Doto (decorative, hidden from assistive tech) with the same fact in plain text. */
export function DaysLeft(props: { d: DeadlineDisplay; small?: boolean }) {
  const { d } = props;
  if (d.daysLeft === null) return null;
  const text = d.daysLeft === 0 ? "Due today" : d.daysLeft === 1 ? "1 day left" : `${d.daysLeft} days left`;
  return (
    <span
      class="dot"
      data-countdown-at={d.applicantLocal ? undefined : d.countdownAt ?? undefined}
      data-applicant-date={d.applicantLocal?.date}
      data-applicant-time={d.applicantLocal?.time ?? undefined}
    >
      <span class="js-days" aria-hidden="true">
        {d.daysLeft}
      </span>
      <small aria-hidden="true">{d.daysLeft === 1 ? "DAY" : "DAYS"}</small>
      <span class="sr js-days-text">{text}</span>
    </span>
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * A ruler for the application window: 31 ticks and a marker at today's position. SVG attributes,
 * not style attributes, place the marker, so the CSP needs no 'unsafe-inline'.
 */
export function WindowRuler(props: { fraction: number; label: string }) {
  const at = Math.round(Math.min(1, Math.max(0, props.fraction)) * 1000) / 10;
  const ticks = Array.from({ length: 31 }, (_, i) => i);
  return (
    <svg class="ruler" viewBox="0 0 300 38" preserveAspectRatio="none" role="img" aria-label={props.label}>
      {ticks.map((i) => (
        <rect class={i % 5 === 0 ? "mj" : undefined} x={round2(i * 9.95)} y={i % 5 === 0 ? 11 : 23} width="1.5" height={i % 5 === 0 ? 27 : 15} rx="0.75" fill="currentColor" />
      ))}
      <rect class="now" x={round2((at / 100) * 297)} y="0" width="3" height="38" rx="1.5" fill="currentColor" />
    </svg>
  );
}

/** Explore card: the header of a Program page, with the next deadline and who it is for. */
export function ProgramCardView(props: { card: ProgramCard; now: number; todayIso: string; extra?: Child }) {
  const { card, now } = props;
  const next = nextDeadline(card, now);
  const status = describeStatus(card.status, next);
  const verification = describeVerification(card.verification, props.todayIso);
  const pay = compensationText(card.compensation);
  // Day counts only for deadlines in season; further out, the date alone reads better.
  const showCount = next !== null && next.daysLeft !== null && next.daysLeft <= PRODUCT.inSeason.deadlineWithinDays;
  return (
    <li>
      <article class="pcard" aria-labelledby={`p-${card.programCycleId}`}>
        <div class="top">
          <div class="tags">
            <StatusChip status={status} />
            <span class="chip">{primaryGroupLabel(card.opportunityTypes)}</span>
          </div>
          {card.isSample ? <SampleTag /> : null}
        </div>
        <h3 id={`p-${card.programCycleId}`}>
          <a href={`/programs/${card.slug}`}>{card.name}</a>
        </h3>
        <p class="org">{card.organizationName}</p>
        <p class="meta">
          {classYearText(card.classYears)}
          {pay ? ` · ${pay}` : ""}
        </p>
        <VerificationLineLight line={verification} />
        <div class="next">
          {showCount && next ? <DaysLeft d={next} /> : <span />}
          <span class="when">
            {next ? (
              <>
                <span class="sr">{next.kindLabel}: </span>
                {next.listDate && !next.approximate ? formatDate(next.listDate) : next.primary}
              </>
            ) : (
              "No dates published yet"
            )}
          </span>
        </div>
        {props.extra ?? null}
      </article>
    </li>
  );
}

/** Verification line for paper surfaces (same words, darker icon colours from the .day scope). */
function VerificationLineLight(props: { line: VerificationDisplayLine }) {
  return (
    <p class="meta">
      {props.line.label}
      {props.line.detail ? ` · ${props.line.detail}` : ""}
    </p>
  );
}
