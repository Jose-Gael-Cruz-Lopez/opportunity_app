/** @jsxImportSource hono/jsx */
import { Page, type SiteContext } from "../components/layout";
import { ClosingNext, collectionCounts, countStats, Crumbs, SampleNote, StatTiles } from "../components/collection";
import { ProgramCardView } from "../components/ui";
import type { PublicListData } from "../data";
import { formatDate, plural } from "../format";
import { collectionPageJsonLd, metaDescription, type PageMeta } from "../seo";
import { todayIso } from "../view-model";

/**
 * Advisor list (/lists/:slug public, /lists/u/:token unlisted; plan s01 P2 concierge pilot): a
 * set of programs an advising office chose, in its order, with its own notes. The page shows the
 * list's words and public registry cards, nothing about the office's workspace or students.
 *
 * Search engines see a list only when it is public, holds no status- or identity-defined program
 * (`restricted`) and no sample record. An unlisted list's token is its capability: its URL is
 * never canonical, indexed or sent on as a referrer, and the page is never cached.
 */

export interface ListModel {
  readonly list: PublicListData;
  /** The path this list was opened at (canonical only for public lists). */
  readonly path: string;
  readonly now: number;
}

export function listIndexable(list: PublicListData): boolean {
  return list.visibility === "public" && !list.restricted && list.entries.length > 0 && !list.entries.some((e) => e.card.isSample);
}

export function listPageMeta(model: ListModel, site: SiteContext): PageMeta {
  const { list } = model;
  const description = metaDescription(
    list.description ?? `${plural(list.entries.length, "program")} chosen by an advising office, with verified deadlines, eligibility and requirements for each.`,
  );
  const indexable = listIndexable(list);
  return {
    title: `${list.title} | Novus`,
    description,
    // An unlisted list never names its own URL anywhere a crawler or another site could read it.
    path: list.visibility === "public" ? model.path : "/explore",
    indexable,
    ...(list.visibility === "unlisted" ? { referrer: "no-referrer" as const } : {}),
    jsonLd: indexable ? [collectionPageJsonLd(site.origin, { name: list.title, description, path: model.path }, list.entries.map((e) => e.card))] : [],
  };
}

export function ListPage(props: { model: ListModel; site: SiteContext }) {
  const { model, site } = props;
  const { list, now } = model;
  const cards = list.entries.map((e) => e.card);
  const today = todayIso(now);
  return (
    <Page meta={listPageMeta(model, site)} site={site} nav="none">
      <section class="dusk" aria-labelledby="list-h">
        <div class="wrap">
          <Crumbs items={[{ name: "Explore", href: "/explore" }, { name: "Advisor list" }]} />
          <span class="label kick">{list.visibility === "public" ? "Advisor list" : "Shared list"}</span>
          <h1 id="list-h">{list.title}</h1>
          {list.description ? <p class="lede">{list.description}</p> : null}
          <p class="version label">
            Chosen by an advising office · updated {formatDate(list.updatedAt.slice(0, 10), { weekday: false })}
          </p>
          <StatTiles stats={countStats(collectionCounts(cards, now))} label="This list in numbers" />
        </div>
      </section>
      <div class="day">
        <div class="wrap">
          <SampleNote show={cards.some((c) => c.isSample)} />
          {list.entries.length === 0 ? (
            <p class="empty">
              This list has no published programs right now. <a href="/explore">Explore every program</a>.
            </p>
          ) : (
            <>
              <ClosingNext cards={cards} now={now} headingId="list-soon" />
              <section class="section" aria-labelledby="list-all">
                <div class="section-head">
                  <h2 id="list-all">
                    The <em>list</em>
                  </h2>
                  <span class="note">In the order the office chose</span>
                </div>
                <ol class="grid listed">
                  {list.entries.map((entry) => (
                    <ProgramCardView
                      card={entry.card}
                      now={now}
                      todayIso={today}
                      extra={
                        entry.note || entry.cycleKey ? (
                          <div class="advisor-note">
                            {entry.note ? (
                              <p>
                                <span class="label">Advisor's note</span>
                                {entry.note}
                              </p>
                            ) : null}
                            {entry.cycleKey ? <p class="note">The office picked the {entry.cycleKey} cycle; this card shows the current one.</p> : null}
                          </div>
                        ) : undefined
                      }
                    />
                  ))}
                </ol>
              </section>
            </>
          )}
          <p class="note">
            Advising offices choose and annotate their lists; Novus verifies the programs. Notes are the office's own words. An office can see how
            many times its list was opened, never by whom.
          </p>
        </div>
      </div>
    </Page>
  );
}
