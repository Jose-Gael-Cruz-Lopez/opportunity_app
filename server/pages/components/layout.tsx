/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { assetPath } from "../assets";
import { canonicalUrl, jsonForScript, type PageMeta } from "../seo";

/**
 * Document shell for public pages. No inline scripts and no style attributes (the CSP allows
 * neither); JSON-LD goes through DataBlock, the only place a script body is written.
 */

export interface SiteContext {
  readonly origin: string;
  /** Whether this environment may be indexed at all (production only). */
  readonly indexable: boolean;
  readonly containsSample: boolean;
  /** For the copyright line. */
  readonly year: number;
  /** Shown at the top of the page, e.g. when it was rendered from the saved release. */
  readonly notice?: string | null;
}

/** The "saved copy" banner; the edge cache injects the same class into last-good copies. */
export function NoticeBanner(props: { site: SiteContext }) {
  return props.site.notice ? (
    <div class="stale-banner" role="status">
      {props.site.notice}
    </div>
  ) : null;
}

/** A non-executed `<script>` data block, escaped with jsonForScript. */
export function DataBlock(props: { type: "application/ld+json" | "application/json"; id?: string; data: unknown }) {
  return <script type={props.type} id={props.id} dangerouslySetInnerHTML={{ __html: jsonForScript(props.data) }} />;
}

export function Head(props: { meta: PageMeta; site: SiteContext; styles: readonly string[]; scripts?: readonly string[] }) {
  const { meta, site } = props;
  const url = canonicalUrl(site.origin, meta.path);
  const robots = meta.indexable && site.indexable ? "index, follow" : "noindex, nofollow";
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
      <title>{meta.title}</title>
      <meta name="description" content={meta.description} />
      <meta name="robots" content={robots} />
      {meta.referrer ? <meta name="referrer" content={meta.referrer} /> : null}
      <link rel="canonical" href={url} />
      <meta name="theme-color" content="#090A0C" />
      <link rel="icon" href="/icons/favicon.svg" type="image/svg+xml" />
      <link rel="icon" href="/icons/favicon-32.png" type="image/png" sizes="32x32" />
      <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
      <link rel="manifest" href="/manifest.webmanifest" />
      <meta name="color-scheme" content="dark light" />
      <meta property="og:site_name" content="Novus" />
      <meta property="og:type" content={meta.ogType ?? "website"} />
      <meta property="og:title" content={meta.title} />
      <meta property="og:description" content={meta.description} />
      <meta property="og:url" content={url} />
      <meta name="twitter:card" content="summary" />
      {props.styles.map((href) => (
        <link rel="stylesheet" href={href} />
      ))}
      {(props.scripts ?? []).map((src) => (
        <script src={src} defer />
      ))}
      {(meta.jsonLd ?? []).map((node) => (
        <DataBlock type="application/ld+json" data={node} />
      ))}
    </head>
  );
}

/** Icons used across pages, drawn once and referenced with `<use href="#i-…">`. */
export function IconSprite() {
  return (
    <svg class="sprite sr" aria-hidden="true" focusable="false">
      <symbol id="i-check" viewBox="0 0 24 24">
        <path d="m5.5 12.5 4 4 9-9.5" />
      </symbol>
      <symbol id="i-lock" viewBox="0 0 24 24">
        <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
        <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
      </symbol>
      <symbol id="i-clock" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7.5V12l3 2" />
      </symbol>
      <symbol id="i-out" viewBox="0 0 24 24">
        <path d="M7.5 16.5 16.5 7.5M9.5 7.5h7v7" />
      </symbol>
      <symbol id="i-alert" viewBox="0 0 24 24">
        <path d="M12 4 21 19.5H3z" />
        <path d="M12 10v4.5M12 17.2v.1" />
      </symbol>
      <symbol id="i-info" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 11v5.5M12 8v.1" />
      </symbol>
      <symbol id="i-track" viewBox="0 0 24 24">
        <path d="M10.5 6.5h9.5M10.5 12h9.5M10.5 17.5h9.5" />
        <path d="m3.8 6.4 1.5 1.5 2.5-2.7M3.8 11.9l1.5 1.5 2.5-2.7" />
        <circle cx="5.7" cy="17.5" r="1.7" />
      </symbol>
      <symbol id="i-doc" viewBox="0 0 24 24">
        <path d="M7 3.5h7l4.5 4.5v12.5H7z" />
        <path d="M14 3.5V8h4.5M9.5 12.5h6M9.5 16h6" />
      </symbol>
      <symbol id="i-send" viewBox="0 0 24 24">
        <path d="M4.5 11.8 19.5 4.5l-4.6 15-3.1-6.1z" />
        <path d="m11.8 13.4 7.7-8.9" />
      </symbol>
      <symbol id="i-compass" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" />
        <path d="m15.4 8.6-2.1 4.7-4.7 2.1 2.1-4.7z" />
      </symbol>
      <symbol id="i-leaf" viewBox="0 0 24 24">
        <path d="M5 19c0-8 5-13.5 14-14-.5 9-6 14-14 14z" />
        <path d="M5 19 13 11" />
      </symbol>
    </svg>
  );
}

export function Icon(props: { name: string; class?: string; label?: string }) {
  return (
    <svg class={`ic ${props.class ?? ""}`.trim()} aria-hidden={props.label ? undefined : "true"} role={props.label ? "img" : undefined} aria-label={props.label}>
      <use href={`#i-${props.name}`} />
    </svg>
  );
}

export type NavKey = "explore" | "deadlines" | "methods" | "pledge" | "none";

const NAV: readonly { key: NavKey; href: string; label: string }[] = [
  { key: "explore", href: "/explore", label: "Explore" },
  { key: "deadlines", href: "/deadlines", label: "Deadlines" },
  { key: "methods", href: "/methods", label: "How we verify" },
];

export function SiteHeader(props: { current: NavKey }) {
  return (
    <header class="site-head">
      <div class="wrap">
        <a class="word" href="/" aria-label="Novus home">
          novus
        </a>
        <nav class="site-nav label" aria-label="Main">
          {NAV.map((item) => (
            <a href={item.href} aria-current={item.key === props.current ? "page" : undefined}>
              {item.label}
            </a>
          ))}
          <a class="pill" href="/app">
            Sign in
          </a>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter(props: { site: SiteContext }) {
  return (
    <footer class="site-foot label">
      <div class="wrap">
        <nav aria-label="Footer">
          <a href="/explore">Explore</a>
          <a href="/deadlines">Deadlines</a>
          <a href="/methods">How we verify</a>
          <a href="/pledge">Our pledge</a>
          <a href="/research/ai-deadline-audit">AI deadline audit</a>
          <a href="/methods#corrections">Report an error</a>
          <a href="/app/settings">Privacy settings</a>
        </nav>
        <span>
          © {props.site.year} Novus{props.site.containsSample ? " · includes sample data" : ""}
        </span>
      </div>
    </footer>
  );
}

/** A complete inner page: dark header, the caller's dusk band and paper body, footer, page island. */
export function Page(props: { meta: PageMeta; site: SiteContext; nav: NavKey; children?: Child; island?: boolean }) {
  return (
    <html lang="en">
      <Head meta={props.meta} site={props.site} styles={[assetPath("site.css")]} scripts={props.island === false ? [] : [assetPath("page.js")]} />
      <body>
        <a class="skip" href="#main">
          Skip to content
        </a>
        <NoticeBanner site={props.site} />
        <IconSprite />
        <SiteHeader current={props.nav} />
        <main id="main">{props.children}</main>
        <SiteFooter site={props.site} />
      </body>
    </html>
  );
}

/** Serializes a JSX document with its doctype. Components are synchronous, so this is a string. */
export function renderDocument(node: Child): string {
  return `<!doctype html>${String(node)}`;
}
