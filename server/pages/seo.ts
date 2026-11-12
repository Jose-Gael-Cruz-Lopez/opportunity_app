import type { ProgramCard, ProgramDetail } from "@shared/contracts";
import { typeLabels, classYearText, compensationText } from "./view-model";

/**
 * SEO metadata and JSON-LD. JSON-LD uses EducationalOccupationalProgram (never JobPosting), and is
 * emitted only for records that are not sample data, so invented facts are never offered to search
 * engines as real.
 */

/**
 * The only way to put data inside a `<script>` element. The HTML tokenizer ends any script, data
 * blocks included, at `</script`, so `<`, `>` and `&` are escaped as JSON unicode escapes; U+2028
 * and U+2029 are escaped for old JavaScript parsers.
 */
export function jsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export interface PageMeta {
  /** Full `<title>` text. */
  readonly title: string;
  readonly description: string;
  /** Path of the canonical URL, starting with "/". */
  readonly path: string;
  /** False adds `noindex` (sample records, non-production environments, error pages). */
  readonly indexable: boolean;
  readonly ogType?: "website" | "article";
  /** JSON-LD nodes; each becomes its own data block. */
  readonly jsonLd?: readonly Record<string, unknown>[];
  /** "no-referrer" for pages whose URL is a capability (unlisted lists). */
  readonly referrer?: "no-referrer";
}

export function canonicalUrl(origin: string, path: string): string {
  return `${origin.replace(/\/$/, "")}${path}`;
}

/** Meta descriptions are cut at a word boundary near 160 characters. */
export function metaDescription(text: string, max = 160): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max - 20))}…`;
}

export function organizationJsonLd(origin: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: "Novus",
    url: canonicalUrl(origin, "/"),
  };
}

export function websiteJsonLd(origin: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Novus",
    url: canonicalUrl(origin, "/"),
    potentialAction: {
      "@type": "SearchAction",
      target: `${canonicalUrl(origin, "/explore")}?q={query}`,
      "query-input": "required name=query",
    },
  };
}

export function breadcrumbJsonLd(origin: string, items: readonly { name: string; path: string }[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: canonicalUrl(origin, item.path),
    })),
  };
}

/**
 * EducationalOccupationalProgram for one Program page. Only verified facts: the official
 * application deadline, opening date, provider and prerequisites taken from the rule text.
 */
export function programJsonLd(
  origin: string,
  detail: ProgramDetail,
  summary: string,
  applicationDeadline: string | null,
): Record<string, unknown> {
  const node: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "EducationalOccupationalProgram",
    name: detail.program.name,
    description: summary,
    url: canonicalUrl(origin, `/programs/${detail.program.slug}`),
    sameAs: detail.program.officialUrl,
    provider: {
      "@type": "Organization",
      name: detail.organization.name,
      ...(detail.organization.websiteUrl ? { url: detail.organization.websiteUrl } : {}),
    },
    programType: typeLabels(detail.program.opportunityTypes).join(", "),
  };
  if (applicationDeadline) node.applicationDeadline = applicationDeadline;
  if (detail.cycle.opensOn) node.applicationStartDate = detail.cycle.opensOn;
  if (detail.cycle.eventStart) node.startDate = detail.cycle.eventStart;
  if (detail.cycle.eventEnd) node.endDate = detail.cycle.eventEnd;
  const prerequisites = (detail.ruleSet?.rules ?? []).map((r) => r.officialText);
  if (prerequisites.length) node.programPrerequisites = prerequisites;
  const pay = compensationText(detail.cycle.compensation);
  if (detail.cycle.applicationFeeCents === null || detail.cycle.applicationFeeCents === 0) {
    node.offers = { "@type": "Offer", price: 0, priceCurrency: "USD", description: pay ?? "No cost to apply" };
  }
  return node;
}

/** ItemList for Explore: links only, so the list stays small. */
export function programListJsonLd(origin: string, cards: readonly ProgramCard[]): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: cards.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: canonicalUrl(origin, `/programs/${c.slug}`),
      name: c.name,
    })),
  };
}

/** Title in the form plan s10 asks for: "{Program} {cycle year}: deadlines, eligibility and odds | Novus". */
export function programTitle(name: string, termLabel: string): string {
  return `${name} ${termLabel}: deadlines, eligibility and requirements | Novus`;
}

export function programDescription(card: Pick<ProgramCard, "name" | "organizationName" | "classYears">, summary: string): string {
  return metaDescription(`${summary} ${classYearText(card.classYears)}. Verified dates, eligibility and requirements on Novus.`);
}

/**
 * CollectionPage for a hub, an Organization page or a public list, with its programs as an
 * ItemList of links. Callers pass real records only.
 */
export function collectionPageJsonLd(
  origin: string,
  page: { name: string; description: string; path: string },
  cards: readonly Pick<ProgramCard, "slug" | "name">[],
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: page.name,
    description: page.description,
    url: canonicalUrl(origin, page.path),
    isPartOf: { "@type": "WebSite", name: "Novus", url: canonicalUrl(origin, "/") },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: cards.length,
      itemListElement: cards.map((c, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: canonicalUrl(origin, `/programs/${c.slug}`),
        name: c.name,
      })),
    },
  };
}

/** The Organization behind programs on Novus; `sameAs` is its own website. */
export function providerJsonLd(origin: string, org: { name: string; slug: string; websiteUrl: string | null }): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: org.name,
    url: canonicalUrl(origin, `/orgs/${org.slug}`),
    ...(org.websiteUrl ? { sameAs: org.websiteUrl } : {}),
  };
}

/** A plain WebPage node for editorial pages (the pledge, the audit before its first report). */
export function webPageJsonLd(origin: string, page: { name: string; description: string; path: string; dateModified?: string }): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: page.name,
    description: page.description,
    url: canonicalUrl(origin, page.path),
    ...(page.dateModified ? { dateModified: page.dateModified } : {}),
    publisher: { "@type": "Organization", name: "Novus", url: canonicalUrl(origin, "/") },
  };
}

/** A published audit edition. */
export function reportJsonLd(origin: string, report: { title: string; description: string; path: string; publishedOn: string }): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Report",
    headline: report.title,
    description: report.description,
    url: canonicalUrl(origin, report.path),
    datePublished: report.publishedOn,
    author: { "@type": "Organization", name: "Novus", url: canonicalUrl(origin, "/") },
    publisher: { "@type": "Organization", name: "Novus", url: canonicalUrl(origin, "/") },
  };
}
