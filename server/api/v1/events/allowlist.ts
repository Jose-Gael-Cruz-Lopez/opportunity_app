import { ANALYTICS_EVENT_NAMES } from "@shared/contracts/api";
import { isSensitiveKey } from "@shared/contracts/sensitive";
import { ONBOARDING_FUNNEL, type OnboardingFunnelStep } from "@shared/onboarding/analytics";
import { PLAN_STEP_KINDS, TIERS } from "@shared/onboarding/types";

/**
 * What `POST /api/v1/events` may store, and nothing else (plan s10 10.9.1-10.9.3, s02 2.3.12).
 *
 * - Event names come from the shared contract (`ANALYTICS_EVENT_NAMES`, also the D1 CHECK).
 * - Each event declares its property keys and a type for each: an id (UUID), a closed enum, a
 *   bounded integer or a boolean. There is no free-text type, so no URL, query string, search
 *   text, filter key, message or answer can be declared. An event with an undeclared key, or a
 *   value of the wrong type, is dropped whole (never trimmed and stored).
 * - Paths are reduced to a route template from a closed list (`/programs/:slug`), so a token in
 *   a path (`/cal/u/:token`, `/e/rc/:token`) or a query string never reaches a row.
 * - Every key is also run through the shared sensitive-term check; the route refuses a batch
 *   carrying one before any of this runs, and this module refuses to declare one (tested).
 */

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

export type PropSpec =
  | { readonly type: "id" }
  | { readonly type: "enum"; readonly values: readonly string[] }
  | { readonly type: "int"; readonly min: number; readonly max: number }
  | { readonly type: "bool" };

export type PropValue = string | number | boolean;

const id = { type: "id" } as const;
const oneOf = (...values: string[]) => ({ type: "enum", values }) as const;
const int = (min: number, max: number) => ({ type: "int", min, max }) as const;

/** Where a program view or apply click started (s10 10.9.3 "entry surface"). */
export const ENTRY_SURFACES = ["explore", "deadlines", "landing", "search", "list", "tracker", "roadmap", "onboarding", "email", "direct", "other"] as const;

/**
 * `onboarding_step` uses the funnel vocabulary of shared/onboarding/analytics.ts
 * (`onboardingEvent()`), the same one the founders' funnel query reads
 * (admin/metrics/queries.ts `funnelCounts`). Each step admits only the keys
 * `onboardingEvent()` builds for it, every one bounded: counts, closed codes and booleans.
 */
export const ONBOARDING_STEPS = ONBOARDING_FUNNEL;
const COUNT = int(0, 999);
const ONBOARDING_PROPS = {
  step: oneOf(...ONBOARDING_FUNNEL),
  asked: COUNT,
  skipped: COUNT,
  seconds: COUNT,
  source: oneOf("pdf", "docx", "paste", "builder", "none"),
  ok: { type: "bool" },
  strong: COUNT,
  good: COUNT,
  stretch: COUNT,
  explore: COUNT,
  relaxed: { type: "bool" },
  tier: oneOf(...TIERS),
  kind: oneOf(...PLAN_STEP_KINDS),
  deviceOnly: { type: "bool" },
} as const satisfies Record<string, PropSpec>;
type OnboardingPropKey = keyof typeof ONBOARDING_PROPS;
/** The keys each funnel step may carry besides `step` (mirrors `onboardingEvent()`). */
export const ONBOARDING_STEP_KEYS: Readonly<Record<OnboardingFunnelStep, readonly OnboardingPropKey[]>> = {
  started: [],
  quiz_completed: ["asked", "skipped", "seconds"],
  resume_parsed: ["source", "ok"],
  matches_shown: ["strong", "good", "stretch", "explore", "relaxed"],
  first_door_chosen: ["tier"],
  first_step_done: ["kind"],
  tracker_created: ["deviceOnly"],
};

/**
 * Outcomes of the Remind me form, as the island sees them; never the address or the age.
 * `under_age` is deliberately absent: an under-16 visitor produces no analytics at all (plan
 * 9.10.2), so an event carrying it, even from an older cached island script, is dropped.
 */
export const REMIND_OUTCOMES = ["accepted", "consent_required", "rate_limited", "unavailable", "verification_failed", "failed"] as const;

/**
 * Per-event property allowlist. Program-linked events carry `programId` and/or `cycleId`, which
 * the route resolves to the program's audience: events about a sensitive- or identity-audience
 * program only increment `program_daily_counts` and never become rows.
 */
export const EVENT_PROPS: Readonly<Record<AnalyticsEventName, Readonly<Record<string, PropSpec>>>> = {
  page_view: { surface: oneOf("public", "app", "console") },
  program_view: { programId: id, cycleId: id, entry: oneOf(...ENTRY_SURFACES) },
  apply_click: { programId: id, cycleId: id, entry: oneOf(...ENTRY_SURFACES) },
  remind_me_submit: { cycleId: id, outcome: oneOf(...REMIND_OUTCOMES) },
  tracker_add: { programId: id, cycleId: id, source: oneOf("self", "list", "email_action", "onboarding") },
  onboarding_step: ONBOARDING_PROPS,
  // s10 10.9.3: a bucket of the text query's result count, computed before any filter; nothing
  // about the filters, private or not, so toggling a private filter never changes the event.
  search: { resultBucket: oneOf("0", "1-9", "10+") },
  // No properties at all: which filter changed is never recorded (filter keys are not logged).
  filter_change: {},
  readiness_open: { cycleId: id },
  ai_explain_open: { cycleId: id },
};

/** Keys the server adds to stored props; clients may not send them. */
export const SERVER_PROPS = ["sampleRate"] as const;

/** Events that name a program, resolved against its audience before anything is stored. */
export function programLink(props: Readonly<Record<string, PropValue>>): { programId?: string; cycleId?: string } | null {
  const programId = typeof props.programId === "string" ? props.programId : undefined;
  const cycleId = typeof props.cycleId === "string" ? props.cycleId : undefined;
  return programId || cycleId ? { programId, cycleId } : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Strings longer than this fail whatever their type (s10 10.9.2: "strings over 64 characters fail"). */
export const MAX_PROP_STRING = 64;

function valueOk(spec: PropSpec, value: unknown): boolean {
  switch (spec.type) {
    case "id":
      return typeof value === "string" && value.length <= MAX_PROP_STRING && UUID.test(value);
    case "enum":
      return typeof value === "string" && value.length <= MAX_PROP_STRING && spec.values.includes(value);
    case "int":
      return typeof value === "number" && Number.isInteger(value) && value >= spec.min && value <= spec.max;
    case "bool":
      return typeof value === "boolean";
  }
}

export type PropsVerdict = { ok: true; props: Record<string, PropValue> } | { ok: false; reason: "unknown_key" | "bad_value" | "sensitive_key" };

/** Checks an event's props against its allowlist; ids are lower-cased so joins stay exact. */
export function checkProps(name: AnalyticsEventName, props: Readonly<Record<string, unknown>>): PropsVerdict {
  const spec = EVENT_PROPS[name];
  const out: Record<string, PropValue> = {};
  for (const [key, value] of Object.entries(props)) {
    if (isSensitiveKey(key)) return { ok: false, reason: "sensitive_key" };
    const s = spec[key];
    if (!s) return { ok: false, reason: "unknown_key" };
    if (!valueOk(s, value)) return { ok: false, reason: "bad_value" };
    out[key] = s.type === "id" ? (value as string).toLowerCase() : (value as PropValue);
  }
  if (name === "onboarding_step") {
    // The funnel needs a step, and each step carries only its own keys.
    const step = out.step as OnboardingFunnelStep | undefined;
    if (step === undefined) return { ok: false, reason: "bad_value" };
    const allowed: readonly string[] = ONBOARDING_STEP_KEYS[step];
    for (const key of Object.keys(out)) if (key !== "step" && !allowed.includes(key)) return { ok: false, reason: "unknown_key" };
  }
  return { ok: true, props: out };
}

// =============================================================================================
// Route templates
// =============================================================================================

/**
 * Every path an event may be stored under. Public pages (server/pages) and the SPA routes
 * (client/src/lib/routes.ts, under /app). Anything else is stored as `other`, so a token, an
 * id outside this list or a mistyped path never lands in a row.
 */
const TEMPLATES: readonly { readonly re: RegExp; readonly template: string }[] = [
  // Public pages.
  { re: /^\/$/, template: "/" },
  { re: /^\/explore$/, template: "/explore" },
  { re: /^\/programs\/[^/]+$/, template: "/programs/:slug" },
  { re: /^\/deadlines$/, template: "/deadlines" },
  { re: /^\/methods$/, template: "/methods" },
  { re: /^\/bot$/, template: "/bot" },
  { re: /^\/pledge$/, template: "/pledge" },
  { re: /^\/orgs\/[^/]+$/, template: "/orgs/:slug" },
  { re: /^\/types\/[^/]+$/, template: "/types/:type" },
  { re: /^\/lists\/u\/[^/]+$/, template: "/lists/u/:token" },
  { re: /^\/lists\/[^/]+$/, template: "/lists/:slug" },
  { re: /^\/research\/ai-deadline-audit(?:\/[^/]+)?$/, template: "/research/ai-deadline-audit" },
  // The student app.
  { re: /^\/app$/, template: "/app" },
  { re: /^\/app\/explore$/, template: "/app/explore" },
  { re: /^\/app\/programs\/[^/]+$/, template: "/app/programs/:slug" },
  { re: /^\/app\/readiness\/[^/]+$/, template: "/app/readiness/:programCycleId" },
  { re: /^\/app\/tracker$/, template: "/app/tracker" },
  { re: /^\/app\/roadmap$/, template: "/app/roadmap" },
  { re: /^\/app\/ask$/, template: "/app/ask" },
  { re: /^\/app\/notifications$/, template: "/app/notifications" },
  { re: /^\/app\/settings(?:\/.*)?$/, template: "/app/settings" },
  { re: /^\/app\/start(?:\/.*)?$/, template: "/app/start" },
  { re: /^\/app\/onboarding(?:\/.*)?$/, template: "/app/start" },
  { re: /^\/app\/sign-in$/, template: "/app/sign-in" },
  { re: /^\/app\/advisor(?:\/.*)?$/, template: "/app/advisor" },
  // The Curator console.
  { re: /^\/curate(?:\/.*)?$/, template: "/curate" },
];

/** The stored templates, for docs and tests. */
export const ROUTE_TEMPLATES: readonly string[] = [...new Set(TEMPLATES.map((t) => t.template)), "other"];

/**
 * The route template for a path. Accepts a template the client already computed (it maps back
 * to itself) or a raw path; strips any query string or fragment first; unknown paths become
 * `other`.
 */
export function routeTemplate(path: string): string {
  if (ROUTE_TEMPLATES.includes(path)) return path;
  const bare = (path.split(/[?#]/)[0] ?? "").replace(/\/+$/, "") || "/";
  if (bare.length > 300 || !bare.startsWith("/")) return "other";
  return TEMPLATES.find((t) => t.re.test(bare))?.template ?? "other";
}
