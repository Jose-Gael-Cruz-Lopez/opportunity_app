/**
 * Security header policy (plan 02 2.3.2 and 2.3.14). Public pages carry no inline scripts, so the
 * cached HTML needs no nonce and one static policy serves every visitor.
 */

export type CspDirectives = Readonly<Record<string, readonly string[]>>;

/** The plan's base policy for every Worker response. */
export const BASE_CSP: CspDirectives = {
  "default-src": ["'self'"],
  "script-src": ["'self'"],
  "connect-src": ["'self'"],
  "font-src": ["'self'"],
  "img-src": ["'self'", "data:"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'self'"],
  "object-src": ["'none'"],
};

/** Turnstile renders in an iframe and loads its script from this origin. */
export const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

export interface CspOptions {
  /** Pages that show Turnstile (Program pages, sign-in, the SPA). */
  readonly turnstile?: boolean;
  /**
   * Allow inline <style> elements. Only the SPA shell sets this: Radix's scroll lock and a few
   * shadcn components inject <style> tags at runtime. Scripts stay 'self' only.
   */
  readonly inlineStyles?: boolean;
  /** Extra connect-src origins, e.g. the Vite dev server's websocket in local development. */
  readonly connectSrc?: readonly string[];
}

/** Builds a Content-Security-Policy header value. Directive order is stable for tests and caches. */
export function buildCsp(options: CspOptions = {}): string {
  const d: Record<string, string[]> = Object.fromEntries(Object.entries(BASE_CSP).map(([k, v]) => [k, [...v]]));
  if (options.turnstile) {
    d["script-src"]!.push(TURNSTILE_ORIGIN);
    d["frame-src"] = [TURNSTILE_ORIGIN];
  }
  if (options.inlineStyles) d["style-src"] = ["'self'", "'unsafe-inline'"];
  if (options.connectSrc?.length) d["connect-src"]!.push(...options.connectSrc);
  return Object.entries(d)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

/** Two years, the preload list's minimum. Not sent in local development (plain http). */
export const HSTS_VALUE = "max-age=63072000; includeSubDomains; preload";

/** Features Novus never uses; denying them limits what an injected frame or script could reach. */
export const PERMISSIONS_POLICY =
  "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), interest-cohort=()";

export const CACHE = {
  /** Default for every response that does not choose: API, SPA shell, internal, errors. */
  noStore: "no-store",
  /** Responses with per-user data. */
  privateNoStore: "private, no-store",
  /** Public pages and public GETs (plan: 60 s at the browser, 5 minutes in the Worker cache). */
  publicShort: "public, max-age=60",
  immutable: "public, max-age=31536000, immutable",
} as const;

/** Origins of the Vite dev server, allowed only when ENVIRONMENT is "local". */
export const LOCAL_DEV_ORIGINS: readonly string[] = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
];

/** Default JSON body limit for /api/v1 (bodies here are small structured JSON). */
export const API_BODY_LIMIT_BYTES = 128 * 1024;

/**
 * Paths under /api/v1 with their own body limit instead of API_BODY_LIMIT_BYTES. The Curator
 * candidate import takes a file of up to ROUTE_MAX_BYTES (512 KB, server/api/v1/curator/import)
 * plus 64 KB for multipart framing; the route re-checks the file size itself.
 */
export const API_BODY_LIMIT_OVERRIDES: readonly { readonly path: string; readonly maxBytes: number }[] = [
  { path: "/api/v1/curator/import", maxBytes: 512 * 1024 + 64 * 1024 },
];
