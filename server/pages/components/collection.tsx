/** @jsxImportSource hono/jsx */
import type { ProgramCard } from "@shared/contracts";
import { DaysLeft, DeadlineWhen, ProgramCardView, SampleTag } from "./ui";
import { upcomingDeadlines } from "../views/deadlines";
import { primaryGroupLabel, todayIso } from "../view-model";

/**
 * Pieces shared by the collection pages (type hubs, Organization pages, advisor lists): a
 * breadcrumb, a row of counted facts, the "closing next" list and the card grid. Every number
 * they show is counted from registry records at render time.
 */

export interface Crumb {
  readonly name: string;
  readonly href?: string;
}

export function Crumbs(props: { items: readonly Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" class="crumbs label">
      <ol>
        {props.items.map((item) => (
          <li aria-current={item.href ? undefined : "page"}>{item.href ? <a href={item.href}>{item.name}</a> : item.name}</li>
        ))}
      </ol>
    </nav>
  );
}

export interface Stat {
  readonly value: number;
  readonly label: string;
}

/** Counted facts in Doto numerals; the number and its words are read together by screen readers. */
export function StatTiles(props: { stats: readonly Stat[]; label: string }) {
  return (
    <dl class="stats" aria-label={props.label}>
      {props.stats.map((s) => (
        <div class="stat">
          <dt class="label">{s.label}</dt>
          <dd class="dot">{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface CollectionCounts {
  readonly listed: number;
  readonly verified: number;
  readonly open: number;
  readonly closingSoon: number;
}

/** Listed, verified by a person, open now, and closing within `soonDays` (national deadlines). */
export function collectionCounts(cards: readonly ProgramCard[], now: number, soonDays = 30): CollectionCounts {
  const closing = new Set(upcomingDeadlines(cards, now, soonDays).map((r) => r.card.programId));
  return {
    listed: cards.length,
    verified: cards.filter((c) => c.verification.state === "verified").length,
    open: cards.filter((c) => c.status === "open" || c.status === "relaunched").length,
    closingSoon: closing.size,
  };
}

export function countStats(counts: CollectionCounts): Stat[] {
  return [
    { value: counts.listed, label: "Listed" },
    { value: counts.verified, label: "Verified by a person" },
    { value: counts.open, label: "Open now" },
    { value: counts.closingSoon, label: "Closing in 30 days" },
  ];
}

/** The next national deadlines among `cards`, soonest first (the Deadlines page's row design). */
export function ClosingNext(props: { cards: readonly ProgramCard[]; now: number; days?: number; limit?: number; headingId: string }) {
  const rows = upcomingDeadlines(props.cards, props.now, props.days ?? 90).slice(0, props.limit ?? 5);
  if (rows.length === 0) return null;
  return (
    <section class="section" aria-labelledby={props.headingId}>
      <div class="section-head">
        <h2 id={props.headingId}>
          Closing <em>next</em>
        </h2>
        <a class="linkish" href="/deadlines">
          Every deadline
        </a>
      </div>
      <ul class="soon">
        {rows.map(({ card, d }) => (
          <li class={d.daysLeft !== null && d.daysLeft <= 14 ? "urgent" : undefined}>
            {d.daysLeft !== null ? (
              <DaysLeft d={d} />
            ) : (
              <span class="dot" aria-hidden="true">
                ~
              </span>
            )}
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
  );
}

export function CardGrid(props: { cards: readonly ProgramCard[]; now: number }) {
  const today = todayIso(props.now);
  return (
    <ul class="grid">
      {props.cards.map((card) => (
        <ProgramCardView card={card} now={props.now} todayIso={today} />
      ))}
    </ul>
  );
}

export function SampleNote(props: { show: boolean }) {
  return props.show ? (
    <p class="callout" role="note">
      Records marked <strong>Sample</strong> are invented for this preview. They are not real programs.
    </p>
  ) : null;
}
