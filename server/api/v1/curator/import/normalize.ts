/**
 * Keys and text normalization for the candidate import (plan 04 4.4 and 4.9).
 *
 * De-duplication compares three parts of a candidate with the registry: the normalized program
 * name, the normalized Organization name and the official URL's host. A row that matches an
 * existing Program on all three is a duplicate and is skipped. A row that matches on two of them,
 * or on the canonical official URL, is imported as a draft with a `possible_duplicate` task, because
 * sibling programs of one Organization and sibling REU sites at one host are common (plan 4.9's
 * hard negatives) and only a Curator can tell them apart.
 *
 * Every function here is pure and uses only Web APIs, so the Worker route and the local CLI
 * (`infra/scripts/import-candidates.ts`, run with tsx) share it. Imports stay relative for tsx.
 */

const COMBINING_MARKS = /[\u0300-\u036f]/g;
// Control characters except tab and newline; the console shows payload text as plain text.
const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069\\ufeff]", "g");

/** Removes control, zero-width and bidi-override characters, then trims. */
export function cleanText(value: string): string {
  return value.replace(CONTROL, "").replace(/\r\n?/g, "\n").trim();
}

/** One-line text: control characters removed and whitespace collapsed. */
export function cleanLine(value: string): string {
  return cleanText(value).replace(/\s+/g, " ");
}

/**
 * Comparison form of a name: NFKD without accents, lowercase, `&` as "and", punctuation as
 * spaces, a leading "the" dropped, whitespace collapsed. "The Example Foundation, Inc." and
 * "example foundation inc" compare equal; "REU Site Chemistry" and "REU Site Chemistry and
 * Biochemistry" do not.
 */
export function normalizeName(value: string): string {
  return cleanLine(value)
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['\u2018\u2019`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/^the /, "")
    .replace(/\s+/g, " ");
}

/** Query parameters that only track clicks; dropped from stored URLs. */
const TRACKING_PARAM = /^(utm_[a-z_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|ref_src)$/i;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export type UrlProblem = "invalid_url" | "scheme" | "credentials" | "private_host";

/**
 * Canonical form of an official URL: http(s) only, no credentials, lowercase host without a
 * trailing dot, no default port, no fragment, no tracking parameters. IP literals, `localhost`
 * and single-label hosts are refused: an official program page has a public domain name.
 * This is the import's own canonicalization; the plan's shared `canonicalizeUrl` (s06) has not
 * been built, and when it lands this function should call it.
 */
export function canonicalUrl(raw: string): { ok: true; url: string; host: string } | { ok: false; problem: UrlProblem } {
  let u: URL;
  try {
    u = new URL(cleanLine(raw));
  } catch {
    return { ok: false, problem: "invalid_url" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, problem: "scheme" };
  if (u.username || u.password) return { ok: false, problem: "credentials" };
  const host = u.hostname.replace(/\.$/, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || IPV4.test(host) || host.startsWith("[") || !host.includes(".")) {
    return { ok: false, problem: "private_host" };
  }
  u.hostname = host;
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
  // URLSearchParams re-serializes an emptied query as "?"; drop it.
  if ([...u.searchParams.keys()].length === 0) u.search = "";
  return { ok: true, url: u.toString(), host };
}

/** Host used for matching: lowercase, without a leading `www.`. */
export function hostKey(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/** URL used for matching: canonical, `www.` dropped, trailing slash dropped, scheme ignored. */
export function urlKey(url: string): string | null {
  const c = canonicalUrl(url);
  if (!c.ok) return null;
  const u = new URL(c.url);
  const path = u.pathname.replace(/\/+$/, "");
  return `${hostKey(u.hostname)}${path}${u.search}`;
}

/** Lowercase slug with hyphens (SlugSchema), at most `max` characters, never empty. */
export function slugify(value: string, max = 80): string {
  const base = cleanLine(value)
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['\u2018\u2019`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = base.slice(0, max).replace(/-+$/g, "");
  return cut || "program";
}

/**
 * A slug not in `taken`: the base, then `{base}-{qualifier}`, then numbered. Returns whether
 * the plain base was taken (reason code `slug_collision` on the task).
 */
export function uniqueSlug(base: string, taken: ReadonlySet<string>, qualifier?: string): { slug: string; collided: boolean } {
  if (!taken.has(base)) return { slug: base, collided: false };
  if (qualifier) {
    const q = `${base}-${qualifier}`.slice(0, 118).replace(/-+$/g, "");
    if (!taken.has(q)) return { slug: q, collided: true };
  }
  for (let n = 2; n < 10_000; n++) {
    const s = `${base.slice(0, 112).replace(/-+$/g, "")}-${n}`;
    if (!taken.has(s)) return { slug: s, collided: true };
  }
  throw new Error("no free slug");
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * Stable key of a candidate, `sha256(org|name|host)[:16]` (the list importer's hash key, backlog
 * S04-007). Stored as the ExternalRef id when the file gives none, so a re-import finds it.
 */
export async function candidateKey(organization: string, name: string, host: string): Promise<string> {
  return (await sha256Hex(`${normalizeName(organization)}|${normalizeName(name)}|${hostKey(host)}`)).slice(0, 16);
}
