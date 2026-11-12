/** @jsxImportSource hono/jsx */
import { Page, type SiteContext } from "../components/layout";
import { Crumbs } from "../components/collection";
import { formatDate } from "../format";
import { breadcrumbJsonLd, metaDescription, webPageJsonLd, type PageMeta } from "../seo";

/**
 * The no-sale pledge (/pledge, plan s09 REQ-047). The nine promises are the plan's text; the
 * version line says plainly that counsel has not reviewed it yet. Each promise links to where
 * /methods explains how it is kept, so the page is a commitment with its mechanism beside it.
 */

export interface PledgeItem {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  /** Where the mechanism is explained. */
  readonly how?: { readonly href: string; readonly label: string };
}

export const PLEDGE_VERSION = {
  /** Draft until counsel's review (plan s09: final with counsel in Phase 1). */
  status: "Draft, awaiting review by counsel",
  updatedOn: "2026-11-11",
} as const;

export const PLEDGE_ITEMS: readonly PledgeItem[] = [
  {
    id: "no-sale",
    title: "We never sell your data.",
    text: "We never sell or rent personal data or share it for cross-context behavioral advertising, and we run no ad pixels, ad SDKs or session replay.",
    how: { href: "/methods#privacy", label: "How the site is built" },
  },
  {
    id: "private-answers",
    title: "Private answers stay on your device.",
    text: "Immigration, Pell and identity answers stay in your browser's memory and are never sent to Novus.",
    how: { href: "/methods#privacy", label: "How the private check works" },
  },
  {
    id: "device-tracking",
    title: "Some programs are tracked only on your device.",
    text: "Programs for undocumented, DACA, TPS, refugee, F-1 or Pell-only students, and for students with a health condition, are tracked only on your device unless you choose otherwise.",
  },
  {
    id: "unlinkable-counts",
    title: "Only counts that cannot be linked to you.",
    text: "Those answers never leave your device. Activity about those programs, and about programs for specific communities, enters analytics and any sponsor or institution report only as daily per-program counts that cannot be linked to you; the programs in promise 3 never enter Outcome data or advisor views.",
  },
  {
    id: "no-profiles",
    title: "Employers and sponsors never see you.",
    text: "Employers and sponsors never receive readiness information, Outcome reports or individual profiles; sponsors see totals for groups of 10 or more.",
    how: { href: "/methods#odds", label: "Disclosure thresholds" },
  },
  {
    id: "payment",
    title: "Money never buys a place.",
    text: "Payment never changes eligibility, ranking or moderation, and every paid placement is labeled “Ad”.",
    how: { href: "/methods#money", label: "How Novus makes money" },
  },
  {
    id: "ai-training",
    title: "No training generative AI on your data.",
    text: "We never use your data to train generative AI models, and our AI providers' terms forbid training on it. We fit statistical models (odds bands, reporting weights, result ordering) on Outcome reports and usage, without names, contact details or private answers, as our methods page describes; turning analytics off keeps your usage out of them.",
    how: { href: "/methods#ai", label: "Where AI is used" },
  },
  {
    id: "successors",
    title: "The pledge survives a sale.",
    text: "A buyer or successor stays bound by this pledge for data collected under it; you will be told first and can delete your account.",
  },
  {
    id: "transparency",
    title: "A yearly transparency report.",
    text: "We publish a yearly transparency report, including government requests.",
  },
];

export function pledgePageMeta(site: SiteContext): PageMeta {
  const description = metaDescription(
    "Novus's no-sale pledge: we never sell your data, private eligibility answers never leave your device, and payment never changes eligibility, ranking or moderation.",
  );
  return {
    title: "Our pledge: we never sell your data | Novus",
    description,
    path: "/pledge",
    indexable: true,
    jsonLd: [
      webPageJsonLd(site.origin, { name: "The Novus pledge", description, path: "/pledge", dateModified: PLEDGE_VERSION.updatedOn }),
      breadcrumbJsonLd(site.origin, [
        { name: "Novus", path: "/" },
        { name: "Pledge", path: "/pledge" },
      ]),
    ],
  };
}

export function PledgePage(props: { site: SiteContext }) {
  const { site } = props;
  return (
    <Page meta={pledgePageMeta(site)} site={site} nav="pledge" island={false}>
      <section class="dusk" aria-labelledby="pl-h">
        <div class="wrap">
          <Crumbs items={[{ name: "Novus", href: "/" }, { name: "Pledge" }]} />
          <span class="label kick">The pledge</span>
          <h1 id="pl-h">
            Your data is <em>not</em> the product.
          </h1>
          <p class="lede">
            Nine promises about what Novus does with what you tell it. They hold for every student, every program and every partner, and they
            bind anyone who ever owns Novus.
          </p>
          <p class="version label">
            {PLEDGE_VERSION.status} · updated {formatDate(PLEDGE_VERSION.updatedOn, { weekday: false })}
          </p>
        </div>
      </section>
      <div class="day">
        <div class="wrap">
          <ol class="pledge">
            {PLEDGE_ITEMS.map((item, i) => (
              <li id={item.id}>
                <span class="dot num" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <h2>
                    <span class="sr">Promise {i + 1}: </span>
                    {item.title}
                  </h2>
                  <p>{item.text}</p>
                  {item.how ? (
                    <p class="how">
                      <a class="linkish" href={item.how.href}>
                        {item.how.label}
                      </a>
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
          <section class="section pledge-foot" aria-labelledby="pl-q">
            <h2 id="pl-q">
              If we <em>break</em> it
            </h2>
            <p>
              If you think Novus has broken a promise on this page, write to the address in our{" "}
              <a href="/.well-known/security.txt">security contact</a>. This page shows the date of its last change.
            </p>
            <p class="actions">
              <a class="pill solid" href="/methods#privacy">
                How private eligibility works
              </a>
              <a class="pill" href="/app/settings/privacy">
                Your privacy settings
              </a>
            </p>
          </section>
        </div>
      </div>
    </Page>
  );
}
