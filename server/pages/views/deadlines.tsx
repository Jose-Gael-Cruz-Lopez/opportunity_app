/** @jsxImportSource hono/jsx */
import type { ProgramCard } from "@shared/contracts";
import { formatMonth, plural } from "../format";
import { Page, type SiteContext } from "../components/layout";
import { DaysLeft, DeadlineWhen, SampleTag } from "../components/ui";
import { metaDescription, type PageMeta } from "../seo";
import { describeDeadline, isSubmissionDeadline, primaryGroupLabel, type DeadlineDisplay } from "../view-model";

/**
 * Deadlines (/deadlines): every upcoming national submission deadline in a window, soonest first,
 * grouped by month. Month-only rows sit at the start of their month and say so.
 */

export const DEADLINE_RANGES = [30, 90, 180] as const;
export type DeadlineRange = (typeof DEADLINE_RANGES)[number];
export const DEFAULT_RANGE: DeadlineRange = 90;

export function parseRange(value: string | undefined): DeadlineRange {
  const n = Number(value);
  return (DEADLINE_RANGES as readonly number[]).includes(n) ? (n as DeadlineRange) : DEFAULT_RANGE;
}

export interface DeadlineRow {
  readonly card: ProgramCard;
  readonly d: DeadlineDisplay;
}

/** Upcoming national deadlines due within `days`, soonest first. */
export function upcomingDeadlines(cards: readonly ProgramCard[], now: number, days: number): DeadlineRow[] {
  const rows: DeadlineRow[] = [];
  for (const card of cards) {
    if (card.status === "ended" || card.status === "paused") continue;
    for (const dv of card.deadlines) {
      if (dv.scope !== "national" || !isSubmissionDeadline(dv) || dv.basis === "predicted") continue;
      const d = describeDeadline(dv, now);
      if (!d.listDate || d.passed) continue;
      const within = d.daysLeft !== null ? d.daysLeft <= days : monthStartsWithin(d.listDate, now, days);
      if (within) rows.push({ card, d });
    }
  }
  return rows.sort((a, b) => (a.d.listDate ?? "").localeCompare(b.d.listDate ?? "") || a.card.name.localeCompare(b.card.name));
}

function monthStartsWithin(isoDate: string, now: number, days: number): boolean {
  const start = Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, 1);
  return start - now <= days * 86_400_000;
}

/** Rows grouped under "December 2026" style headings, keeping order. */
export function groupByMonth(rows: readonly DeadlineRow[]): { month: string; rows: DeadlineRow[] }[] {
  const out: { month: string; rows: DeadlineRow[] }[] = [];
  for (const row of rows) {
    const month = formatMonth(row.d.listDate ?? "");
    const last = out[out.length - 1];
    if (last && last.month === month) last.rows.push(row);
    else out.push({ month, rows: [row] });
  }
  return out;
}

export interface DeadlinesModel {
  readonly cards: readonly ProgramCard[];
  readonly range: DeadlineRange;
  readonly now: number;
}

export function deadlinesPageMeta(model: DeadlinesModel): PageMeta {
  return {
    title: "Upcoming deadlines for internships, fellowships and scholarships | Novus",
    description: metaDescription(
      "What closes next, soonest first, with each deadline in the time zone the official page states. Checked by a person.",
    ),
    path: "/deadlines",
    indexable: model.range === DEFAULT_RANGE,
  };
}

export function DeadlinesPage(props: { model: DeadlinesModel; site: SiteContext }) {
  const { model, site } = props;
  const rows = upcomingDeadlines(model.cards, model.now, model.range);
  const months = groupByMonth(rows);
  const rolling = model.cards.filter((c) => c.status === "open" && c.deadlines.some((d) => d.precision === "rolling")).length;
  const sample = rows.some((r) => r.card.isSample);
  return (
    <Page meta={deadlinesPageMeta(model)} site={site} nav="deadlines">
      <section class="dusk" aria-labelledby="dl-h">
        <div class="wrap">
          <span class="label kick">Deadlines</span>
          <h1 id="dl-h">
            The next doors <em>to close</em>.
          </h1>
          <p class="lede">
            Each date is shown in the time zone the official page states, with your own time next to it. Date-only deadlines say so: plan to
            submit a day early.
          </p>
          <nav class="ranges" aria-label="Time window">
            {DEADLINE_RANGES.map((r) => (
              <a class="pill" href={r === DEFAULT_RANGE ? "/deadlines" : `/deadlines?days=${r}`} aria-current={r === model.range ? "page" : undefined}>
                Next {r} days
              </a>
            ))}
          </nav>
        </div>
      </section>
      <div class="day">
        <div class="wrap">
          <p aria-live="polite">
            <strong>{plural(rows.length, "deadline")}</strong> in the next {model.range} days
            {rolling ? (
              <>
                {" "}
                · <a href="/explore?status=open">{plural(rolling, "program")}</a> take applications on a rolling basis
              </>
            ) : null}
          </p>
          {sample ? (
            <p class="callout" role="note">
              Rows marked <strong>Sample</strong> are invented for this preview, with dates counted from today. They are not real programs.
            </p>
          ) : null}
          {rows.length === 0 ? <p class="empty">Nothing closes in this window. Try a longer one.</p> : null}
          {months.map((m) => (
            <section aria-labelledby={`m-${m.rows[0]?.d.listDate?.slice(0, 7) ?? "x"}`}>
              <h2 class="month" id={`m-${m.rows[0]?.d.listDate?.slice(0, 7) ?? "x"}`}>
                {m.month}
              </h2>
              <ul class="soon">
                {m.rows.map(({ card, d }) => (
                  <li class={d.daysLeft !== null && d.daysLeft <= 14 ? "urgent" : undefined}>
                    {d.daysLeft !== null ? <DaysLeft d={d} /> : <span class="dot" aria-hidden="true">~</span>}
                    <span>
                      <b>
                        <a href={`/programs/${card.slug}`}>{card.name}</a>
                      </b>
                      <span class="org">
                        {card.organizationName} · {d.kindLabel}
                      </span>
                    </span>
                    <span class="when">
                      <DeadlineWhen d={d} />
                      {d.advice ? <span class="note"> {d.advice}</span> : null}
                    </span>
                    <span class="ty">
                      <span class="chip">{primaryGroupLabel(card.opportunityTypes)}</span> {card.isSample ? <SampleTag /> : null}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </Page>
  );
}
