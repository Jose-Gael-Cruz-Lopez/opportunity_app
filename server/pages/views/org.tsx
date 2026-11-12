/** @jsxImportSource hono/jsx */
import type { Organization, ProgramCard } from "@shared/contracts";
import { OPPORTUNITY_GROUP_LABELS, type OrganizationKind } from "@shared/taxonomy";
import { Icon, Page, type SiteContext } from "../components/layout";
import { CardGrid, ClosingNext, collectionCounts, countStats, Crumbs, SampleNote, StatTiles } from "../components/collection";
import { joinList, plural } from "../format";
import { HUB_MIN_VERIFIED, verifiedCount } from "../hubs";
import { breadcrumbJsonLd, collectionPageJsonLd, metaDescription, providerJsonLd, type PageMeta } from "../seo";
import { countByGroup } from "../view-model";
import { browseOrder } from "./explore";

/**
 * Organization page (/orgs/:slug): who runs a set of programs, with every published one listed.
 * Any Organization with a published program has a page (Program pages link to it), but only one
 * with HUB_MIN_VERIFIED or more real verified programs is offered to search engines, the same
 * bar as type hubs, so a thin page of one or two programs is never indexed on its own.
 */

export const ORGANIZATION_KIND_LABELS: Readonly<Record<OrganizationKind, string>> = {
  federal_agency: "Federal agency",
  state_agency: "State agency",
  foundation: "Foundation",
  nonprofit: "Nonprofit",
  company: "Company",
  university: "University",
  national_lab: "National laboratory",
  professional_society: "Professional society",
  other: "Organization",
};

export interface OrgModel {
  readonly organization: Organization;
  readonly cards: readonly ProgramCard[];
  readonly now: number;
}

export function orgIndexable(model: OrgModel): boolean {
  return !model.organization.isSample && verifiedCount(model.cards, { realOnly: true }) >= HUB_MIN_VERIFIED;
}

/** "Research and Fellowships": the families of an Organization's programs, largest first. */
export function familyText(cards: readonly ProgramCard[]): string {
  const groups = [...countByGroup(cards).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => OPPORTUNITY_GROUP_LABELS[g].toLowerCase());
  return joinList(groups);
}

export function orgLede(model: OrgModel): string {
  const verified = verifiedCount(model.cards);
  return `${model.organization.name} runs ${plural(model.cards.length, "program")} listed on Novus (${familyText(model.cards)}), ${verified} verified by a person against the official page.`;
}

export function orgPageMeta(model: OrgModel, site: SiteContext): PageMeta {
  const { organization } = model;
  const path = `/orgs/${organization.slug}`;
  const description = metaDescription(`${orgLede(model)} Deadlines, eligibility and requirements for each.`);
  const indexable = orgIndexable(model);
  const cards = browseOrder(model.cards, model.now);
  return {
    title: `${organization.name}: programs, deadlines and eligibility | Novus`,
    description,
    path,
    indexable,
    jsonLd: indexable
      ? [
          providerJsonLd(site.origin, organization),
          collectionPageJsonLd(site.origin, { name: `Programs from ${organization.name}`, description, path }, cards),
          breadcrumbJsonLd(site.origin, [
            { name: "Explore", path: "/explore" },
            { name: organization.name, path },
          ]),
        ]
      : [],
  };
}

export function OrgPage(props: { model: OrgModel; site: SiteContext }) {
  const { model, site } = props;
  const { organization, now } = model;
  const cards = browseOrder(model.cards, now);
  const sampleOrg = organization.isSample && !/sample|example/i.test(organization.name);
  return (
    <Page meta={orgPageMeta(model, site)} site={site} nav="explore">
      <section class="dusk" aria-labelledby="org-h">
        <div class="wrap">
          <Crumbs items={[{ name: "Explore", href: "/explore" }, { name: organization.name }]} />
          <span class="label kick">{ORGANIZATION_KIND_LABELS[organization.kind]}</span>
          <h1 id="org-h">
            {organization.name}
            {sampleOrg ? " (sample organization)" : ""}
          </h1>
          <p class="lede">{orgLede(model)}</p>
          {organization.websiteUrl ? (
            <p class="actions">
              <a class="pill" href={organization.websiteUrl} rel="noopener nofollow">
                Official website <Icon name="out" />
              </a>
            </p>
          ) : null}
          <StatTiles stats={countStats(collectionCounts(cards, now))} label={`Programs from ${organization.name} in numbers`} />
        </div>
      </section>
      <div class="day">
        <div class="wrap">
          <SampleNote show={organization.isSample || cards.some((c) => c.isSample)} />
          <ClosingNext cards={cards} now={now} headingId="org-soon" />
          <section class="section" aria-labelledby="org-all">
            <div class="section-head">
              <h2 id="org-all">
                Every program from <em>{organization.name}</em>
              </h2>
            </div>
            <CardGrid cards={cards} now={now} />
            <p class="note">
              Novus is not affiliated with {organization.name}. Every listing links to the official page it was read from; confirm there before you
              apply.
            </p>
          </section>
        </div>
      </div>
    </Page>
  );
}
