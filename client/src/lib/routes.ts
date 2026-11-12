/**
 * App routes. The SPA is mounted under /app (the Worker serves the shell for /app/*), and the
 * wouter <Router base="/app"> makes every path below relative to it: <Link href={appPaths.tracker}>
 * goes to /app/tracker. Use `absoluteAppPath` for hrefs that leave the router (emails, share links).
 */

export const APP_BASE = "/app";

/** Page folder under client/src/pages for each route; App.tsx loads `pages/<folder>/index.tsx`. */
export const PAGE_ROUTES = [
  { id: "home", path: "/", folder: "home", label: "Home" },
  { id: "explore", path: "/explore", folder: "explore", label: "Explore" },
  { id: "program", path: "/programs/:slug", folder: "program", label: "Program" },
  // Readiness is keyed by program cycle; `?program=<slug>` lets the page load the rule set even
  // when the server withholds the report for a status-defined program.
  { id: "readiness", path: "/readiness/:programCycleId", folder: "readiness", label: "Readiness" },
  { id: "tracker", path: "/tracker", folder: "tracker", label: "Tracker" },
  { id: "roadmap", path: "/roadmap", folder: "roadmap", label: "Roadmap" },
  { id: "ask", path: "/ask", folder: "ask", label: "Ask Novus" },
  { id: "notifications", path: "/notifications", folder: "notifications", label: "Notifications" },
  { id: "settings", path: "/settings/*?", folder: "settings", label: "Settings" },
  // The old onboarding form: every /onboarding link now lands on the guided flow below.
  { id: "onboarding", path: "/onboarding/*?", folder: "onboarding", label: "Get started", bare: true, redirectTo: "/start" },
  // The guided first-five-minutes flow (quiz, resume on device, matches, first steps). New
  // accounts land here after sign-in (sign-in/model.ts destinationAfterSignIn).
  { id: "start", path: "/start/*?", folder: "start", label: "Start", bare: true },
  { id: "signIn", path: "/sign-in", folder: "sign-in", label: "Sign in", bare: true },
  { id: "advisor", path: "/advisor/*?", folder: "advisor", label: "Advisor" },
] as const;

export type PageRouteId = (typeof PAGE_ROUTES)[number]["id"];
export type PageRoute = (typeof PAGE_ROUTES)[number];

/** Converts a wouter pattern (`:param`, trailing `/*?`) to a RegExp. */
function patternToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/\/\*\?$/, "")
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  const optionalRest = pattern.endsWith("/*?") ? "(?:/.*)?" : "";
  return new RegExp(`^${body || ""}${optionalRest}/?$`);
}

const ROUTE_MATCHERS = PAGE_ROUTES.map((route) => ({ route, re: patternToRegExp(route.path) }));

/** The page route a location (relative to /app) belongs to, or null for a 404. */
export function matchPageRoute(location: string): PageRoute | null {
  const path = location.split(/[?#]/)[0] || "/";
  if (path === "/") return PAGE_ROUTES[0];
  return ROUTE_MATCHERS.find(({ route, re }) => route.path !== "/" && re.test(path))?.route ?? null;
}

/** Where a redirect-only route sends the browser (relative to /app), or null. */
export function redirectFor(location: string): string | null {
  const route = matchPageRoute(location);
  return route && "redirectTo" in route ? route.redirectTo : null;
}

export function isBareRoute(location: string): boolean {
  const route = matchPageRoute(location);
  return !!route && "bare" in route && route.bare === true;
}

export function documentTitle(location: string): string {
  const route = matchPageRoute(location);
  return route ? `${route.label} · Novus` : "Not found · Novus";
}

/**
 * Folder names a page may live in. The first folder that exists wins, so
 * `pages/programs/index.tsx` works as well as `pages/program/index.tsx`. App.tsx's glob lists
 * the same folders.
 */
export const FOLDER_ALIASES: Partial<Record<PageRouteId, readonly string[]>> = {
  program: ["program", "programs"],
};

export const appPaths = {
  home: "/",
  explore: "/explore",
  exploreSearch: (q: string) => (q.trim() ? `/explore?q=${encodeURIComponent(q.trim())}` : "/explore"),
  program: (slug: string) => `/programs/${encodeURIComponent(slug)}`,
  readiness: (programCycleId: string, programSlug?: string) =>
    `/readiness/${encodeURIComponent(programCycleId)}${programSlug ? `?program=${encodeURIComponent(programSlug)}` : ""}`,
  tracker: "/tracker",
  roadmap: "/roadmap",
  ask: "/ask",
  askQuestion: (q: string) => (q.trim() ? `/ask?q=${encodeURIComponent(q.trim())}` : "/ask"),
  notifications: "/notifications",
  settings: "/settings",
  /** Redirects to `start`; kept so old links and bookmarks keep working. */
  onboarding: "/onboarding",
  start: "/start",
  signIn: "/sign-in",
  advisor: "/advisor",
} as const;

/**
 * Sign in, then come back. `next` is an in-app path (relative to /app, e.g. "/programs/x"): the
 * sign-in page navigates inside the router, so "/app/..." here would land on /app/app/...
 */
export function signInThenReturn(next: string): string {
  return `${appPaths.signIn}?next=${encodeURIComponent(next)}`;
}

export function absoluteAppPath(path: string): string {
  return path === "/" ? APP_BASE : `${APP_BASE}${path}`;
}

/**
 * Old prototype links used hash routes (`#/dashboard`, `#/opportunity/3`). They map to the new
 * paths so bookmarks land somewhere sensible; numeric opportunity ids have no slug, so they go to
 * Explore.
 */
const LEGACY_HASH_ROUTES: Readonly<Record<string, string>> = {
  "/": "/",
  "/dashboard": "/explore",
  "/landing": "/",
  "/roadmap": "/roadmap",
  "/readiness": "/start",
  "/community": "/",
};

export function mapLegacyHash(hash: string): string | null {
  const path = hash.replace(/^#/, "");
  if (!path.startsWith("/")) return null;
  const clean = path.split("?")[0] ?? path;
  if (clean.startsWith("/opportunity/")) return "/explore";
  return LEGACY_HASH_ROUTES[clean] ?? null;
}

/**
 * Where the browser should go on boot, or null to stay. Handles old hash links and dev servers
 * that open at "/" instead of "/app".
 */
export function bootRedirect(pathname: string, hash: string): string | null {
  const legacy = hash ? mapLegacyHash(hash) : null;
  if (legacy !== null) return absoluteAppPath(legacy);
  if (pathname === APP_BASE || pathname.startsWith(`${APP_BASE}/`)) return null;
  return APP_BASE;
}
