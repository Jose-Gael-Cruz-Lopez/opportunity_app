import { LANDING_CSS } from "./landing-css";
import { LANDING_JS } from "./landing-js";
import { PAGE_JS } from "./page-js";
import { SITE_CSS } from "./site-css";

/**
 * Page assets are bundled with the Worker as strings and served from content-hashed URLs, so the
 * HTML can reference them under `script-src 'self'` and `style-src 'self'` and browsers can keep
 * them forever. They live under /p/ because /assets/* is answered by the static build before the
 * Worker runs (wrangler `run_worker_first`).
 */

export const PAGE_ASSET_PREFIX = "/p/";

export type PageAssetName = "site.css" | "landing.css" | "landing.js" | "page.js";

interface PageAsset {
  readonly body: string;
  readonly contentType: string;
  readonly path: string;
}

/** 32-bit FNV-1a as 8 hex digits: enough to bust caches when the text changes. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function asset(name: PageAssetName, body: string): PageAsset {
  const dot = name.lastIndexOf(".");
  const ext = name.slice(dot + 1);
  const contentType = ext === "css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
  return { body, contentType, path: `${PAGE_ASSET_PREFIX}${name.slice(0, dot)}.${contentHash(body)}.${ext}` };
}

const ASSETS: Readonly<Record<PageAssetName, PageAsset>> = {
  "site.css": asset("site.css", SITE_CSS),
  "landing.css": asset("landing.css", LANDING_CSS),
  "landing.js": asset("landing.js", LANDING_JS),
  "page.js": asset("page.js", PAGE_JS),
};

/** The hashed URL path of an asset, for `<link>` and `<script>` tags. */
export function assetPath(name: PageAssetName): string {
  return ASSETS[name].path;
}

/**
 * The asset served at a request path. `current` is false when the hash is not today's: HTML cached
 * before a deploy still gets the file (the newest one), but browsers must not keep it forever.
 */
export function assetForPath(path: string): { body: string; contentType: string; current: boolean } | undefined {
  const match = /^\/p\/([a-z-]+)\.([0-9a-f]{8})\.(css|js)$/.exec(path);
  if (!match) return undefined;
  const name = `${match[1]}.${match[3]}`;
  if (!(name in ASSETS)) return undefined;
  const found = ASSETS[name as PageAssetName];
  return { body: found.body, contentType: found.contentType, current: found.path === path };
}
