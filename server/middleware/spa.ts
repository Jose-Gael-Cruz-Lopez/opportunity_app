import type { Handler } from "hono";
import type { AppEnv } from "../env";
import { getConfig } from "../config";
import { CACHE, buildCsp } from "../config/security";
import { problemFor } from "../lib/problem";

/**
 * Serves the SPA shell for /app and /app/* from the ASSETS binding (plan 02 2.3.1). The Worker
 * runs first for these paths, so the shell gets the security headers, a CSP that admits
 * Turnstile, and `no-store` (signed-in pages and island answers must not enter the back-forward
 * cache). Client-side routing (wouter, path mode) takes over in the browser.
 *
 * The shell is fetched as `/index.html`. Workers static assets may redirect that to `/` (its
 * html_handling), so one same-origin redirect is followed.
 */

export const SPA_SHELL_PATH = "/index.html";
const SPA_CSP = buildCsp({ turnstile: true, inlineStyles: true });

async function fetchShell(assets: Fetcher, origin: string, shellPath: string = SPA_SHELL_PATH): Promise<Response> {
  let res = await assets.fetch(new Request(`${origin}${shellPath}`, { method: "GET" }));
  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("location");
    if (location) {
      const next = new URL(location, origin);
      if (next.origin === origin) res = await assets.fetch(new Request(next.toString(), { method: "GET" }));
    }
  }
  return res;
}

export const spaShell: Handler<AppEnv> = async (c) => {
  if (!c.env?.ASSETS) return problemFor(c, "unavailable", { detail: "The app shell is not built." });
  const origin = new URL(c.req.url).origin;
  let res: Response;
  try {
    res = await fetchShell(c.env.ASSETS, origin);
  } catch {
    return problemFor(c, "unavailable");
  }
  if (!res.ok) return problemFor(c, "unavailable", { detail: "The app shell is not built." });

  const headers = new Headers();
  headers.set("content-type", res.headers.get("content-type") ?? "text/html; charset=utf-8");
  headers.set("cache-control", CACHE.noStore);
  headers.set("content-security-policy", SPA_CSP);
  return new Response(c.req.method === "HEAD" ? null : res.body, { status: 200, headers });
};

/**
 * Curator console shell for /curate and /curate/* (docs/curator.md, "Registration"). The console
 * is a second Vite entry (client/src/console/index.html, emitted at /src/console/index.html). It
 * gets a stricter CSP than the student app: no Turnstile and no inline styles (React sets styles
 * through the CSSOM, which CSP allows). Outside local development the console exists only on the
 * staff host (`curate.<domain>`, behind Cloudflare Access); on any other host it is a 404.
 */
export const CONSOLE_SHELL_PATH = "/src/console/index.html";
export const CONSOLE_CSP = buildCsp({ turnstile: false, inlineStyles: false });

export function isConsoleHostAllowed(environment: string, hostname: string): boolean {
  return environment === "local" || hostname.startsWith("curate.");
}

export const consoleShell: Handler<AppEnv> = async (c) => {
  const url = new URL(c.req.url);
  if (!isConsoleHostAllowed(getConfig(c.env ?? {}).environment, url.hostname)) return c.notFound();
  if (!c.env?.ASSETS) return problemFor(c, "unavailable", { detail: "The console shell is not built." });
  let res: Response;
  try {
    res = await fetchShell(c.env.ASSETS, url.origin, CONSOLE_SHELL_PATH);
  } catch {
    return problemFor(c, "unavailable");
  }
  if (!res.ok) return problemFor(c, "unavailable", { detail: "The console shell is not built." });

  const headers = new Headers();
  headers.set("content-type", res.headers.get("content-type") ?? "text/html; charset=utf-8");
  headers.set("cache-control", CACHE.noStore);
  headers.set("content-security-policy", CONSOLE_CSP);
  return new Response(c.req.method === "HEAD" ? null : res.body, { status: 200, headers });
};

/**
 * Static files outside /assets/* (favicon, robots.txt, self-hosted fonts, images) reach the Worker
 * first (`run_worker_first = ["/*", "!/assets/*"]`), so routes that match nothing fall back to
 * ASSETS before the 404 page. HTML documents and directory paths are never served this way: the
 * only HTML from ASSETS is the /app shell, which must carry its own CSP and `no-store`.
 */
export function isStaticAssetCandidate(method: string, pathname: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  if (pathname.endsWith("/") || /\.html?$/i.test(pathname)) return false;
  // A file name with an extension, e.g. /favicon.ico, /fonts/dm-sans.woff2 or /manifest.webmanifest.
  return /\/[^/]+\.[A-Za-z0-9]{1,11}$/.test(pathname);
}

/** The ASSETS response for a static file, or null when there is none (or no binding). */
export async function fetchStaticAsset(assets: Fetcher | undefined, request: Request): Promise<Response | null> {
  if (!assets) return null;
  const url = new URL(request.url);
  if (!isStaticAssetCandidate(request.method, url.pathname)) return null;
  try {
    // Only the path is forwarded: no cookies or query reach the asset server.
    const res = await assets.fetch(new Request(`${url.origin}${url.pathname}`, { method: request.method }));
    return res.ok ? res : null;
  } catch {
    return null;
  }
}
