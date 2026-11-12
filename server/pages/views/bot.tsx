/** @jsxImportSource hono/jsx */
import { Page, type SiteContext } from "../components/layout";
import { metaDescription, type PageMeta } from "../seo";

/**
 * /bot: the page NovusBot's User-Agent links to, so site owners can see what it does, how often
 * it calls and how to opt out (plan s04 politeness rules).
 */

export function botPageMeta(): PageMeta {
  return {
    title: "NovusBot: how Novus checks official program pages | Novus",
    description: metaDescription(
      "NovusBot reads public program pages to notice changes to dates and rules. It obeys robots.txt, makes at most one request per second per host and never logs in.",
    ),
    path: "/bot",
    indexable: true,
  };
}

export function BotPage(props: { site: SiteContext }) {
  return (
    <Page meta={botPageMeta()} site={props.site} nav="none" island={false}>
      <section class="dusk" aria-labelledby="bot-h">
        <div class="wrap">
          <span class="label kick">NovusBot</span>
          <h1 id="bot-h">
            A careful <em>reader</em>.
          </h1>
          <p class="lede">NovusBot reads public program pages so a person can check when dates or rules change.</p>
        </div>
      </section>
      <div class="day">
        <div class="wrap prose">
          <h2 id="what">What it does</h2>
          <ul>
            <li>It fetches public pages about programs for students: application pages, eligibility pages and deadline announcements.</li>
            <li>It compares each page with the last copy and flags changes for a person to review. It never publishes anything on its own.</li>
            <li>It does not log in, solve CAPTCHAs, fill in forms or rotate IP addresses.</li>
          </ul>
          <h2 id="polite">How it behaves</h2>
          <ul>
            <li>It obeys robots.txt, including rules addressed to NovusBot.</li>
            <li>It makes at most one request per second to any host, and usually far fewer: most pages are checked weekly or less.</li>
            <li>It sends conditional requests, so an unchanged page costs you a 304.</li>
          </ul>
          <h2 id="optout">Opting out</h2>
          <p>
            Add <code>User-agent: NovusBot</code> with <code>Disallow: /</code> to your robots.txt. To ask us to remove a program or correct a
            fact, use the "Report an error" link on its Novus page, or see <a href="/methods#corrections">corrections</a>. Removal requests
            are handled within five business days.
          </p>
        </div>
      </div>
    </Page>
  );
}
