import { APP_BASE, matchPageRoute } from "@/lib/routes";

/**
 * The route template for the current path, so no slug, id, token or query string leaves the
 * browser in an event (`/app/programs/:slug`). The server maps again from its own closed list
 * and stores `other` for anything it does not know.
 */
export function routeTemplate(pathname: string): string {
  const path = (pathname.split(/[?#]/)[0] ?? "").replace(/\/+$/, "") || "/";
  if (path === APP_BASE || path.startsWith(`${APP_BASE}/`)) {
    const route = matchPageRoute(path.slice(APP_BASE.length) || "/");
    if (!route) return "other";
    const template = route.path.replace(/\/\*\?$/, "");
    return template === "/" ? APP_BASE : `${APP_BASE}${template}`;
  }
  if (path === "/curate" || path.startsWith("/curate/")) return "/curate";
  return "other";
}
