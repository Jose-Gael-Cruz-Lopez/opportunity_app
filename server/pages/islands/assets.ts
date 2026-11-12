import { Hono } from "hono";
import { buildCsp } from "@server/config/security";
import { contentHash } from "../assets";
import { BROWSER_CACHE } from "../headers";
import { ISLANDS_CSS } from "./islands-css";
import { REMIND_JS } from "./remind-me-js";

/**
 * Island files, served like the page assets (content-hashed, immutable) but under /p/i/ so this
 * module owns its own list: /p/{name}.{hash}.{ext} stays with server/pages/assets.
 *
 *   /p/i/remind-me.{hash}.js   the Remind me island
 *   /p/i/islands.{hash}.css    island styles
 */

export const ISLAND_ASSET_PREFIX = "/p/i/";

export type IslandAssetName = "remind-me.js" | "islands.css";

interface IslandAsset {
  readonly body: string;
  readonly contentType: string;
  readonly path: string;
}

function asset(name: IslandAssetName, body: string): IslandAsset {
  const dot = name.lastIndexOf(".");
  const ext = name.slice(dot + 1);
  const contentType = ext === "css" ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
  return { body, contentType, path: `${ISLAND_ASSET_PREFIX}${name.slice(0, dot)}.${contentHash(body)}.${ext}` };
}

const ASSETS: Readonly<Record<IslandAssetName, IslandAsset>> = {
  "remind-me.js": asset("remind-me.js", REMIND_JS),
  "islands.css": asset("islands.css", ISLANDS_CSS),
};

export function islandAssetPath(name: IslandAssetName): string {
  return ASSETS[name].path;
}

/** The island file at a request path; `current` is false for an old hash (served, not immutable). */
export function islandAssetForPath(path: string): { body: string; contentType: string; current: boolean } | undefined {
  const match = /^\/p\/i\/([a-z-]+)\.([0-9a-f]{8})\.(css|js)$/.exec(path);
  if (!match) return undefined;
  const name = `${match[1]}.${match[3]}`;
  if (!(name in ASSETS)) return undefined;
  const found = ASSETS[name as IslandAssetName];
  return { body: found.body, contentType: found.contentType, current: found.path === path };
}

/** Mount at "/" in the pages router (before its 404): GET /p/i/:file. */
export function createIslandAssetRoutes() {
  const app = new Hono();
  app.get("/p/i/:file", (c) => {
    const found = islandAssetForPath(new URL(c.req.url).pathname);
    if (!found) return c.notFound();
    return c.body(found.body, 200, {
      "content-type": found.contentType,
      "cache-control": found.current ? BROWSER_CACHE.immutable : BROWSER_CACHE.editorial,
    });
  });
  return app;
}

export const islandAssetRoutes = createIslandAssetRoutes();

/**
 * The CSP a page carrying the Remind me island needs: the base policy plus Turnstile's script
 * and frame origin (https://challenges.cloudflare.com). The Program page handler sets it; the
 * global securityHeaders middleware fills the base policy only where a handler set none.
 */
export const REMIND_PAGE_CSP = buildCsp({ turnstile: true });
