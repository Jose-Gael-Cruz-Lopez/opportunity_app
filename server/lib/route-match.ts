import { ROUTE_LIST, type AuthClass, type RouteDef, type RouteId } from "@shared/contracts/routes";

/**
 * Matches concrete paths against route-map templates (Hono syntax) outside the router, for
 * middleware that must decide before routing: CORS for public GETs, internal key scopes.
 */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `/programs/:slug`, `/data/client-core/:file{[0-9]+\.json}`, `/app/*` -> anchored RegExp. */
export function pathPatternToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === ":") {
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)(\{((?:[^{}]|\{[^{}]*\})*)\})?/.exec(pattern.slice(i));
      if (m) {
        out += m[3] !== undefined ? `(?:${m[3]})` : "[^/]+";
        i += m[0].length;
        continue;
      }
    }
    if (ch === "*") {
      out += ".*";
      i++;
      continue;
    }
    out += escapeRegExp(ch);
    i++;
  }
  return new RegExp(`^${out}$`);
}

export interface CompiledRoute {
  readonly id: RouteId;
  readonly def: RouteDef;
  readonly regex: RegExp;
}

export function compileRoutes(filter: (def: RouteDef & { id: RouteId }) => boolean): CompiledRoute[] {
  return ROUTE_LIST.filter(filter).map((def) => ({ id: def.id, def, regex: pathPatternToRegExp(def.path) }));
}

/** Finds the route for a method and path, preferring literal routes over parameterised ones. */
export function findRoute(routes: readonly CompiledRoute[], method: string, pathname: string): CompiledRoute | null {
  const m = method.toUpperCase();
  const candidates = routes.filter((r) => (r.def.method === m || r.def.method === "ALL") && r.regex.test(pathname));
  if (candidates.length === 0) return null;
  // `/jobs/lease` must win over `/jobs/:id`-style templates: fewer params first.
  return candidates.sort((a, b) => paramCount(a.def.path) - paramCount(b.def.path))[0]!;
}

function paramCount(path: string): number {
  return (path.match(/:|\*/g) ?? []).length;
}

const PUBLIC_AUTH: ReadonlySet<AuthClass> = new Set(["public"]);

let publicGets: CompiledRoute[] | null = null;

/** True for credential-free public GET routes under /api/v1 (the only ones CORS opens up). */
export function isPublicApiGet(pathname: string): boolean {
  publicGets ??= compileRoutes(
    (d) => d.method === "GET" && PUBLIC_AUTH.has(d.auth) && d.path.startsWith("/api/v1/") && !d.path.startsWith("/api/v1/me"),
  );
  return publicGets.some((r) => r.regex.test(pathname));
}

let internalRoutes: CompiledRoute[] | null = null;

/** The internal route a signed request targets, for the key-scope check. */
export function findInternalRoute(method: string, pathname: string): CompiledRoute | null {
  internalRoutes ??= compileRoutes((d) => d.mount === "internal");
  return findRoute(internalRoutes, method, pathname);
}
