import type { HostPolicy } from "@shared/taxonomy";

/**
 * The Worker's copy of the host-policy gate (architecture 2.3.7, plan 4.3). The pipeline checks
 * the same table before fetching (`novus_pipeline/policy.py` holds the identical seed); the Worker
 * checks again on ingest, because a pipeline bug, a redirect the gate missed or a stolen fetch key
 * must not store a restricted platform's pages. When `shared/policy/hosts.yaml` lands, both sides
 * should load it instead of these literals.
 *
 * Matching: a host matches an entry when it equals it or ends with "." + entry; `label.*` matches
 * that label under any public suffix; path entries (`docs.google.com/forms/*`) also match the
 * path prefix; the longest pattern wins; no match means `allowed`.
 */

export interface PolicyEntry {
  readonly pattern: string;
  readonly policy: HostPolicy;
}

const e = (policy: HostPolicy, patterns: readonly string[]): PolicyEntry[] => patterns.map((pattern) => ({ pattern, policy }));

export const HOST_POLICY_SEED: readonly PolicyEntry[] = [
  ...e("never", ["linkedin.com", "lnkd.in", "indeed.com", "joinhandshake.com", "reddit.com", "x.com", "twitter.com", "t.co", "glassdoor.com"]),
  ...e("manual_only", [
    "smapply.*",
    "submittable.com",
    "scholarshipamerica.org",
    "mykaleidoscope.com",
    "devpost.com",
    "awardspring.com",
    "smarterselect.com",
    "etap.nsf.gov",
    "myworkdayjobs.com",
    "myworkdaysite.com",
    "saiapply.org",
    "grantinterface.com",
    "awardsplatform.com",
    "applyists.net",
  ]),
  ...e("link_only", ["docs.google.com/forms/*", "forms.gle", "forms.office.com", "qualtrics.com", "tfaforms.net"]),
  ...e("api_only", ["boards-api.greenhouse.io", "api.lever.co", "api.ashbyhq.com", "api.smartrecruiters.com", "api.nsf.gov", "data.usajobs.gov"]),
];

const MULTI_LABEL_SUFFIXES = new Set(["co.uk", "ac.uk", "org.uk", "gov.uk", "com.au", "edu.au", "org.au", "co.nz", "ac.nz", "co.jp", "ac.jp", "com.br", "co.za", "ac.za", "co.in", "ac.in", "edu.sg", "com.sg", "gc.ca", "qc.ca"]);

/** Policies from least to most restrictive; ingest takes the stricter of seed and D1. */
export const POLICY_STRICTNESS: readonly HostPolicy[] = ["allowed", "api_only", "manual_only", "link_only", "never"];
export const FETCHABLE_POLICIES: ReadonlySet<HostPolicy> = new Set(["allowed", "api_only"]);

function wildcardMatches(label: string, host: string): boolean {
  const parts = host.split(".");
  return parts.some((p, i) => {
    if (p !== label) return false;
    const suffix = parts.slice(i + 1).join(".");
    return suffix.length > 0 && (!suffix.includes(".") || MULTI_LABEL_SUFFIXES.has(suffix));
  });
}

function hostMatches(pattern: string, host: string): boolean {
  const hostPart = pattern.split("/", 1)[0] as string;
  if (hostPart.endsWith(".*")) return wildcardMatches(hostPart.slice(0, -2), host);
  return host === hostPart || host.endsWith(`.${hostPart}`);
}

function pathMatches(pattern: string, path: string): boolean {
  const slash = pattern.indexOf("/");
  if (slash < 0) return true;
  const want = pattern.slice(slash);
  return want.endsWith("*") ? path.startsWith(want.slice(0, -1)) : path === want;
}

/** Lowercase host without a trailing dot; URL parsing already applies IDNA (punycode). */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.hostname.replace(/\.$/, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

export function resolveSeedPolicy(url: string, entries: readonly PolicyEntry[] = HOST_POLICY_SEED): { policy: HostPolicy; entry: string | null } {
  const host = hostOf(url);
  if (!host) return { policy: "never", entry: null };
  const path = new URL(url).pathname || "/";
  let best: PolicyEntry | null = null;
  for (const entry of entries) {
    if (hostMatches(entry.pattern, host) && pathMatches(entry.pattern, path) && (!best || entry.pattern.length > best.pattern.length)) best = entry;
  }
  return best ? { policy: best.policy, entry: best.pattern } : { policy: "allowed", entry: null };
}

export function stricter(a: HostPolicy, b: HostPolicy): HostPolicy {
  return POLICY_STRICTNESS.indexOf(a) >= POLICY_STRICTNESS.indexOf(b) ? a : b;
}

export interface ChainDecision {
  readonly allowed: boolean;
  /** Policy of the final URL (stored on the Snapshot). */
  readonly finalPolicy: HostPolicy;
  /** The first refused URL's host, for the alert (never the full URL with its query). */
  readonly refusedHost: string | null;
  readonly refusedPolicy: HostPolicy | null;
}

/**
 * Every URL of a fetch (requested, each redirect hop, final) must resolve to a fetchable policy.
 * `stored` holds curator or seed decisions from D1's source_hosts, keyed by exact host.
 */
export function checkUrlChain(urls: readonly string[], stored: ReadonlyMap<string, HostPolicy> = new Map()): ChainDecision {
  let finalPolicy: HostPolicy = "never";
  for (const url of urls) {
    const host = hostOf(url);
    const seed = resolveSeedPolicy(url).policy;
    const policy = host && stored.has(host) ? stricter(seed, stored.get(host) as HostPolicy) : seed;
    if (!FETCHABLE_POLICIES.has(policy)) return { allowed: false, finalPolicy: policy, refusedHost: host, refusedPolicy: policy };
    finalPolicy = policy;
  }
  return { allowed: urls.length > 0, finalPolicy, refusedHost: null, refusedPolicy: null };
}
