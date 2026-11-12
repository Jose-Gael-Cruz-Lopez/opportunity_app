/** @jsxImportSource hono/jsx */
import { Page, type SiteContext } from "../components/layout";
import type { PageMeta } from "../seo";

/** Error pages: never indexed, never cached, and free of any detail about the failure. */

function errorMeta(title: string, path: string): PageMeta {
  return { title: `${title} | Novus`, description: title, path, indexable: false };
}

export function NotFoundPage(props: { site: SiteContext; path: string }) {
  return (
    <Page meta={errorMeta("Page not found", props.path)} site={props.site} nav="none" island={false}>
      <section class="dusk" aria-labelledby="nf-h">
        <div class="wrap">
          <span class="label kick">404</span>
          <h1 id="nf-h">
            This door is <em>not here</em>.
          </h1>
          <p class="lede">The program may have been renamed or removed, or the link has a typo.</p>
        </div>
      </section>
      <div class="day">
        <div class="wrap">
          <p>
            <a class="pill solid" href="/explore">
              Explore every program
            </a>{" "}
            <a class="pill" href="/deadlines">
              See upcoming deadlines
            </a>
          </p>
        </div>
      </div>
    </Page>
  );
}

export function UnavailablePage(props: { site: SiteContext; path: string }) {
  return (
    <Page meta={errorMeta("Briefly unavailable", props.path)} site={props.site} nav="none" island={false}>
      <section class="dusk" aria-labelledby="un-h">
        <div class="wrap">
          <span class="label kick">Briefly unavailable</span>
          <h1 id="un-h">
            We can't load this page <em>right now</em>.
          </h1>
          <p class="lede">
            Program data is briefly unavailable. Please try again in a few minutes, and check the official program site before you rely on a
            date.
          </p>
        </div>
      </section>
    </Page>
  );
}
