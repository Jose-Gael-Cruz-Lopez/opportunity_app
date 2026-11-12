/**
 * App links. Pages live under /app; the shell may mount them inside a nested wouter router with
 * base "/app" or at the top level. wouter treats a leading "~" as "absolute, ignore the base",
 * so these hrefs work in both setups.
 */
export function appHref(path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return `~/app${clean === "/" ? "" : clean}`;
}

/** Anchor id for a roadmap item, so Readiness next actions can deep-link to it. */
export function roadmapItemAnchor(itemKey: string): string {
  return `item-${itemKey.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

export function roadmapItemHref(itemKey: string): string {
  return `${appHref("/roadmap")}#${roadmapItemAnchor(itemKey)}`;
}

/** The in-app program page (the public /programs/:slug page serves visitors without the app). */
export function programHref(slug: string): string {
  return appHref(`/programs/${encodeURIComponent(slug)}`);
}
