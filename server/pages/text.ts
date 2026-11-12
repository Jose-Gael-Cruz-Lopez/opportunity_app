import type { ProgramCard } from "@shared/contracts";
import { canonicalUrl } from "./seo";
import { AUDIT_PATH, AUDIT_REPORTS } from "./audit";
import { availableHubs, hubLabel, hubPath } from "./hubs";
import { browseOrder } from "./views/explore";
import { classYearText, primaryGroupLabel } from "./view-model";

/**
 * Plain-text and XML files served beside the pages: robots.txt, sitemap.xml, llms.txt and
 * security.txt. Sample records never appear in any of them, so invented programs are never
 * offered to crawlers as real.
 */

/** Static editorial paths that belong in the sitemap and llms.txt. */
export const EDITORIAL_PATHS = ["/", "/explore", "/deadlines", "/methods", "/pledge", AUDIT_PATH] as const;

/**
 * Crawler policy (plan s09): search and user-initiated fetchers are admitted, AI training
 * crawlers are blocked until the founders decide after the AI audit, and private paths are
 * disallowed for everyone. Outside production everything is disallowed.
 */
export const TRAINING_CRAWLERS = ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended"] as const;
export const PRIVATE_PATHS = ["/app", "/api/", "/internal/", "/mcp", "/out/", "/e/", "/r/", "/go/", "/cal/u/", "/lists/u/"] as const;

export function robotsTxt(origin: string, production: boolean): string {
  if (!production) return "User-agent: *\nDisallow: /\n";
  const lines: string[] = [];
  for (const bot of TRAINING_CRAWLERS) lines.push(`User-agent: ${bot}`, "Disallow: /", "");
  lines.push("User-agent: *", ...PRIVATE_PATHS.map((p) => `Disallow: ${p}`), "Allow: /", "");
  lines.push(`Sitemap: ${canonicalUrl(origin, "/sitemap.xml")}`, "");
  return lines.join("\n");
}

function xmlEscape(text: string): string {
  return text.replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[ch] ?? ch);
}

/** Real, published programs only, in browse order. */
export function indexableCards(cards: readonly ProgramCard[], now: number): ProgramCard[] {
  return browseOrder(
    cards.filter((c) => !c.isSample),
    now,
  );
}

/** sitemap.xml; a program's lastmod is the day a person last verified it (plan s10). */
export function sitemapXml(origin: string, cards: readonly ProgramCard[], now: number): string {
  const urls: string[] = EDITORIAL_PATHS.map((p) => `<url><loc>${xmlEscape(canonicalUrl(origin, p))}</loc></url>`);
  for (const report of AUDIT_REPORTS.filter((r) => !r.isSample)) {
    urls.push(`<url><loc>${xmlEscape(canonicalUrl(origin, `${AUDIT_PATH}/${report.id}`))}</loc><lastmod>${report.publishedOn}</lastmod></url>`);
  }
  // Hubs only where real verified programs alone pass the bar (sample records never count).
  for (const key of availableHubs(cards, now, { indexableOnly: true })) {
    urls.push(`<url><loc>${xmlEscape(canonicalUrl(origin, hubPath(key)))}</loc></url>`);
  }
  for (const card of indexableCards(cards, now)) {
    const lastmod = card.verification.verifiedOn ? `<lastmod>${card.verification.verifiedOn}</lastmod>` : "";
    urls.push(`<url><loc>${xmlEscape(canonicalUrl(origin, `/programs/${card.slug}`))}</loc>${lastmod}</url>`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

/** Markdown links cannot contain raw brackets or newlines; curated names are cleaned, not trusted. */
function mdText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/[[\]]/g, "");
}

/** llms.txt (llmstxt.org): what Novus is and where the facts are, programs linked by name. */
export function llmsTxt(origin: string, cards: readonly ProgramCard[], now: number, max = 500): string {
  const real = indexableCards(cards, now).slice(0, max);
  const lines = [
    "# Novus",
    "",
    "> A verified map of internships, fellowships, research programs, apprenticeships, scholarships, insight weeks, sprints and conferences for first- and second-year college students. Every program page links to the official page each fact was read from and shows who verified it and when.",
    "",
    "Always confirm dates on the official program page before relying on them. Deadlines are published in the time zone the official page states.",
    "",
    "## Pages",
    "",
    `- [Explore](${canonicalUrl(origin, "/explore")}): every listed program`,
    `- [Deadlines](${canonicalUrl(origin, "/deadlines")}): what closes next, soonest first`,
    `- [How we verify](${canonicalUrl(origin, "/methods")}): sources, freshness labels, time zones, accuracy, AI use and corrections`,
    `- [Our pledge](${canonicalUrl(origin, "/pledge")}): what Novus never does with student data`,
    `- [AI deadline-accuracy audit](${canonicalUrl(origin, AUDIT_PATH)}): how often AI assistants give the right deadline`,
    ...availableHubs(cards, now, { indexableOnly: true }).map((k) => `- [${mdText(hubLabel(k))}](${canonicalUrl(origin, hubPath(k))}): every verified program of this kind`),
    "",
    "## Programs",
    "",
  ];
  if (real.length === 0) lines.push("No verified programs are published yet.");
  for (const card of real) {
    lines.push(
      `- [${mdText(card.name)}](${canonicalUrl(origin, `/programs/${card.slug}`)}): ${mdText(card.organizationName)} · ${primaryGroupLabel(card.opportunityTypes)} · ${classYearText(card.classYears)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** security.txt (RFC 9116). Expires a year from `now`, recomputed on every render. */
export function securityTxt(origin: string, now: number): string {
  const host = new URL(origin).hostname;
  const expires = new Date(now + 365 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    `Contact: mailto:security@${host}`,
    `Expires: ${expires}`,
    "Preferred-Languages: en",
    `Canonical: ${canonicalUrl(origin, "/.well-known/security.txt")}`,
    `Policy: ${canonicalUrl(origin, "/methods#corrections")}`,
    "",
  ].join("\n");
}
