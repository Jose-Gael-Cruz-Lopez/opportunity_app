/** @jsxImportSource hono/jsx */
import type { ProgramCard } from "@shared/contracts";
import { Page, type SiteContext } from "../components/layout";
import { CardGrid, ClosingNext, collectionCounts, countStats, Crumbs, SampleNote, StatTiles } from "../components/collection";
import { plural } from "../format";
import {
  exploreHref,
  GROUP_INTROS,
  hubAvailable,
  hubCards,
  hubGroup,
  hubIndexable,
  hubLabel,
  hubPath,
  subtypeCounts,
  verifiedCount,
  type HubKey,
} from "../hubs";
import { breadcrumbJsonLd, collectionPageJsonLd, metaDescription, type PageMeta } from "../seo";
import { OPPORTUNITY_GROUP_LABELS } from "@shared/taxonomy";

/**
 * Type hub (/types/:type): every listed program of one family or type, with counts generated from
 * the registry, the next deadlines and the full card grid. Rendered only when the hub passes the
 * verified-program bar (hubs.ts); indexed only when real programs alone pass it.
 */

export interface TypeHubModel {
  readonly key: HubKey;
  readonly cards: readonly ProgramCard[];
  readonly now: number;
}

/** The generated lede: counts only, so it is true on the day it renders. */
export function hubLede(key: HubKey, cards: readonly ProgramCard[]): string {
  const label = hubLabel(key).toLowerCase();
  const verified = verifiedCount(cards);
  const open = cards.filter((c) => c.status === "open" || c.status === "relaunched").length;
  return `Novus lists ${plural(cards.length, "program")} in ${label}, ${verified} of them verified by a person against the official page. ${open} ${open === 1 ? "is" : "are"} open now.`;
}

export function typeHubPageMeta(model: TypeHubModel, site: SiteContext): PageMeta {
  const cards = hubCards(model.cards, model.key, model.now);
  const label = hubLabel(model.key);
  const path = hubPath(model.key);
  const description = metaDescription(`${hubLede(model.key, cards)} Deadlines in the time zone the official page states.`);
  const indexable = hubIndexable(model.cards, model.key, model.now) && !cards.some((c) => c.isSample);
  const crumbs = [{ name: "Explore", path: "/explore" }, ...(model.key.kind === "type" ? [{ name: OPPORTUNITY_GROUP_LABELS[hubGroup(model.key)], path: hubPath({ kind: "group", group: hubGroup(model.key) }) }] : []), { name: label, path }];
  return {
    title: `${label} for first- and second-year students: verified deadlines | Novus`,
    description,
    path,
    indexable,
    jsonLd: indexable ? [collectionPageJsonLd(site.origin, { name: label, description, path }, cards), breadcrumbJsonLd(site.origin, crumbs)] : [],
  };
}

export function TypeHubPage(props: { model: TypeHubModel; site: SiteContext }) {
  const { model, site } = props;
  const { key, now } = model;
  const cards = hubCards(model.cards, key, now);
  const label = hubLabel(key);
  const group = hubGroup(key);
  const intro = GROUP_INTROS[group];
  const subtypes = subtypeCounts(cards, key);
  const parent: HubKey = { kind: "group", group };
  const parentLinked = key.kind === "type" && hubAvailable(model.cards, parent, now);
  return (
    <Page meta={typeHubPageMeta(model, site)} site={site} nav="explore">
      <section class="dusk" aria-labelledby="hub-h">
        <div class="wrap">
          <Crumbs
            items={[
              { name: "Explore", href: "/explore" },
              ...(key.kind === "type" ? [{ name: OPPORTUNITY_GROUP_LABELS[group], href: parentLinked ? hubPath(parent) : exploreHref(key) }] : []),
              { name: label },
            ]}
          />
          <span class="label kick">{key.kind === "group" ? "Type hub" : OPPORTUNITY_GROUP_LABELS[group]}</span>
          <h1 id="hub-h">
            {label}, <em>checked</em>.
          </h1>
          {intro ? <p class="lede">{intro}</p> : null}
          <p class="lede">{hubLede(key, cards)}</p>
          <StatTiles stats={countStats(collectionCounts(cards, now))} label={`${label} in numbers`} />
          {subtypes.length > 1 ? (
            <nav aria-label={`Kinds of ${label.toLowerCase()}`}>
              <ul class="toc">
                {subtypes.map((t) => (
                  <li>
                    <a class="pill" href={hubAvailable(model.cards, { kind: "type", type: t.type }, now) ? hubPath({ kind: "type", type: t.type }) : exploreHref(key)}>
                      {t.label} · {t.count}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}
        </div>
      </section>
      <div class="day">
        <div class="wrap">
          <SampleNote show={cards.some((c) => c.isSample)} />
          <ClosingNext cards={cards} now={now} headingId="hub-soon" />
          <section class="section" aria-labelledby="hub-all">
            <div class="section-head">
              <h2 id="hub-all">
                Every program in <em>{label.toLowerCase()}</em>
              </h2>
              <a class="linkish" href={exploreHref(key)}>
                Filter in Explore
              </a>
            </div>
            <CardGrid cards={cards} now={now} />
          </section>
        </div>
      </div>
    </Page>
  );
}
