import { Hono, type Context } from "hono";
import { AnalyticsBatchSchema } from "@shared/contracts/api";
import { findSensitiveKeys } from "@shared/contracts/sensitive";
import type { StoredAnalyticsEvent } from "@server/db/repos/events";
import { logFor, type Logger } from "@server/lib/log";
import { problemFor } from "@server/lib/problem";
import { checkBinding, clientIp, WindowLimiter, type RateLimitBindingLike } from "@server/lib/rate-limit";
import { networkOf } from "../remind/service";
import { checkProps, programLink, routeTemplate, type AnalyticsEventName, type PropValue } from "./allowlist";
import { acceptedErrorReport, ClientErrorBatchSchema, errorKey } from "./client-errors";
import { inSample, SAMPLE_RATES } from "./sampling";
import { createD1EventsStore, type EventsStore, type EventsStoreBindings } from "./store";

/**
 * First-party analytics and client error reports (plan s10 10.9.2, s02 2.3.12).
 *
 *   POST /api/v1/events          route map id `postEvents`, body AnalyticsBatchSchema
 *   POST /api/v1/error-reports   client crash shapes (not the program "report an error" form,
 *                                which is `reportError` at /api/v1/programs/:slug/error-reports)
 *
 * Both accept `text/plain` bodies, because `navigator.sendBeacon` with a JSON content type is
 * not CORS-safelisted and some engines refuse it. The global sensitive-key guard only parses
 * JSON and form bodies, so both handlers run the same check on the parsed body themselves.
 *
 * What is stored, and what never is:
 * - one row per allowlisted event in `novus-events.analytics_events`, keyed only by the
 *   session-scoped id the browser sends in `deviceId` (random, sessionStorage, rotated after 30
 *   idle minutes; never a cookie, never the user id or an HMAC of it);
 * - events about a sensitive- or identity-audience program: only `program_daily_counts`
 *   (day, program, event, n), never a row; one found inside a multi-event batch is a client bug
 *   and logs `events.restricted_in_batch` for the on-call founder;
 * - client errors: day counters by crash site, with no identifier at all, only for reports from
 *   the deployed build (`RELEASE_ID`) or the Remind me island, under per-network and global
 *   daily caps (see LIMITS).
 * Nothing is stored under `Sec-GPC: 1`, from a bot, or for a signed-in account with analytics
 * off or in minor mode: those answer 204.
 */

/** s10 10.9.2: batches hold at most 20 events and 16 KB. */
export const MAX_BATCH_EVENTS = 20;
export const MAX_BODY_BYTES = 16 * 1024;
/** Events dated further than this from the server clock are dropped (stale queues, bad clocks). */
export const MAX_PAST_MS = 24 * 3_600_000;
export const MAX_FUTURE_MS = 5 * 60_000;

/**
 * Judgment (s10 10.9.2). The session limits are a courtesy to honest clients only: the session id
 * is chosen by the client, so a deliberate client can rotate it. The bounds that hold against
 * one are keyed by network (IPv4 /24, IPv6 /64, `networkOf()`), never by the full address,
 * because one IPv6 /64 holds unlimited addresses:
 * - per minute, in-isolate (`batchesPerMinutePerIp`, `errorBatchesPerMinutePerIp`), plus the
 *   shared `RATE_LIMIT_PUBLIC` binding under an `events:` or `errors:` network key;
 * - per day, durable in D1 (`*PerDayPerNetwork`), and for crash reports also one global daily
 *   cap, so counter rows (keyed by client-chosen class, release and file) stay bounded.
 * Campus networks share a /24 behind NAT, so the network day caps are generous.
 */
export const LIMITS = {
  batchesPerMinutePerIp: 60,
  batchesPerMinutePerSession: 60,
  eventsPerDayPerSession: 2_000,
  errorBatchesPerMinutePerIp: 20,
  eventBatchesPerDayPerNetwork: 50_000,
  errorBatchesPerDayPerNetwork: 500,
  errorBatchesPerDayGlobal: 10_000,
} as const;

const DAY_MS = 86_400_000;

/** Crawlers and headless agents; isbot is not a dependency yet, so a conservative pattern. */
const BOT_UA = /bot\b|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|facebookexternalhit|embedly|curl\/|wget\/|python-requests|httpclient|go-http-client|okhttp|axios\/|node-fetch|undici/i;

export function isBotUserAgent(ua: string | undefined): boolean {
  return !ua || BOT_UA.test(ua);
}

export type EventsBindings = EventsStoreBindings & { readonly RATE_LIMIT_PUBLIC?: RateLimitBindingLike };

type EventsEnv = { Bindings: EventsBindings; Variables: { user?: { id: string }; requestId?: string } };
type EventsContext = Context<EventsEnv>;

export interface EventsRouteOptions {
  readonly now?: () => number;
  readonly store?: (env: EventsBindings) => EventsStore;
  /** Test hook: fresh limiters per app instance (the default is one set per isolate). */
  readonly limiters?: EventsLimiters;
}

export interface EventsLimiters {
  readonly ip: WindowLimiter;
  readonly session: WindowLimiter;
  readonly sessionDay: WindowLimiter;
  readonly errorIp: WindowLimiter;
}

export function createLimiters(): EventsLimiters {
  return {
    ip: new WindowLimiter([{ limit: LIMITS.batchesPerMinutePerIp, windowMs: 60_000 }]),
    session: new WindowLimiter([{ limit: LIMITS.batchesPerMinutePerSession, windowMs: 60_000 }]),
    sessionDay: new WindowLimiter([{ limit: LIMITS.eventsPerDayPerSession, windowMs: 86_400_000 }]),
    errorIp: new WindowLimiter([{ limit: LIMITS.errorBatchesPerMinutePerIp, windowMs: 60_000 }]),
  };
}

const ISOLATE_LIMITERS = createLimiters();

/** Why an event was not stored as a row; counted in the log line, never per event. */
type DropReason = "invalid" | "stale" | "sampled_out" | "capped" | "unknown_program" | "mismatch";

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

async function readBody(c: EventsContext): Promise<{ ok: true; value: unknown } | { ok: false; res: Response }> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return { ok: false, res: problemFor(c, "payload_too_large") };
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) return { ok: false, res: problemFor(c, "payload_too_large") };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, res: problemFor(c, "bad_request", { detail: "Expected a JSON body." }) };
  }
}

/** Refuses a body with a status- or identity-looking key, naming paths only (never values). */
function sensitiveRefusal(c: EventsContext, log: Logger, body: unknown, route: string): Response | null {
  const found = findSensitiveKeys(body);
  if (found.length === 0) return null;
  // An alert: a client tried to send a sensitive key. Paths are fixed shapes, not content.
  log.warn("events.sensitive_key_rejected", { route, keys: found.length });
  return problemFor(c, "sensitive_field_rejected", {
    errors: found.slice(0, 20).map((path) => ({ path: path.slice(0, 200), message: "Not accepted by this endpoint" })),
  });
}

function policyDrop(c: EventsContext): Response | null {
  // Global Privacy Control (s09 N11, s10 10.9.2): answer 204 and store nothing.
  if (c.req.header("sec-gpc") === "1") return c.body(null, 204);
  if (isBotUserAgent(c.req.header("user-agent"))) return c.body(null, 204);
  return null;
}

export function createEventsRoutes(opts: EventsRouteOptions = {}) {
  const now = opts.now ?? Date.now;
  const storeFor = opts.store ?? createD1EventsStore;
  const limiters = opts.limiters ?? ISOLATE_LIMITERS;
  const app = new Hono<EventsEnv>();

  app.post("/events", async (c) => {
    c.header("Cache-Control", "no-store");
    const dropped = policyDrop(c);
    if (dropped) return dropped;
    const log = logFor(c as unknown as Context);

    const body = await readBody(c);
    if (!body.ok) return body.res;
    const refused = sensitiveRefusal(c, log, body.value, "/api/v1/events");
    if (refused) return refused;
    const parsed = AnalyticsBatchSchema.safeParse(body.value);
    if (!parsed.success || parsed.data.events.length > MAX_BATCH_EVENTS) {
      return problemFor(c, "validation_failed", {
        errors: parsed.success
          ? [{ path: "events", message: `At most ${MAX_BATCH_EVENTS} events per batch` }]
          : parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join(".") || "(root)", message: "Invalid value" })),
      });
    }

    const t = now();
    const network = networkOf(clientIp(c.req.raw.headers));
    const ipVerdict = limiters.ip.check(`net:${network}`, t);
    if (!ipVerdict.allowed) return problemFor(c, "rate_limited", {}, { retryAfter: ipVerdict.retryAfterSeconds });
    const bound = await checkBinding(c.env.RATE_LIMIT_PUBLIC, `events:${network}`);
    if (!bound.allowed) return problemFor(c, "rate_limited", {}, { retryAfter: bound.retryAfterSeconds });

    const store = storeFor(c.env);
    const daily = await store.consumeDailyCap("events", network, { limit: LIMITS.eventBatchesPerDayPerNetwork, windowMs: DAY_MS }, t);
    if (!daily.allowed) {
      log.warn("events.network_day_cap", { scope: "events" });
      return problemFor(c, "rate_limited", {}, { retryAfter: daily.retryAfterSeconds });
    }
    const user = c.get("user");
    if (user && !(await store.viewerAllowsAnalytics(user.id, t))) return c.body(null, 204);

    const counts: Record<DropReason, number> = { invalid: 0, stale: 0, sampled_out: 0, capped: 0, unknown_program: 0, mismatch: 0 };
    const sessionsSeen = new Set<string>();
    const candidates: { name: AnalyticsEventName; sessionId: string; at: number; path: string; props: Record<string, PropValue> }[] = [];

    for (const ev of parsed.data.events) {
      const name = ev.name as AnalyticsEventName;
      const verdict = checkProps(name, ev.props);
      if (!verdict.ok) {
        counts.invalid++;
        continue;
      }
      const at = Date.parse(ev.at);
      if (!Number.isFinite(at) || at < t - MAX_PAST_MS || at > t + MAX_FUTURE_MS) {
        counts.stale++;
        continue;
      }
      if (!sessionsSeen.has(ev.deviceId)) {
        sessionsSeen.add(ev.deviceId);
        const s = limiters.session.check(`s:${ev.deviceId}`, t);
        if (!s.allowed) return problemFor(c, "rate_limited", {}, { retryAfter: s.retryAfterSeconds });
      }
      const rate = SAMPLE_RATES[name];
      if (!inSample(ev.deviceId, rate)) {
        counts.sampled_out++;
        continue;
      }
      if (!limiters.sessionDay.check(`d:${ev.deviceId}`, t).allowed) {
        counts.capped++;
        continue;
      }
      const props = rate < 1 ? { ...verdict.props, sampleRate: rate } : verdict.props;
      // Seconds are enough for funnels; finer client times only add linkability.
      candidates.push({ name, sessionId: ev.deviceId, at: Math.floor(at / 1000) * 1000, path: routeTemplate(ev.path), props });
    }

    // Resolve program-linked events to their audience before anything is written.
    const programIds = new Set<string>();
    const cycleIds = new Set<string>();
    for (const cand of candidates) {
      const link = programLink(cand.props);
      if (link?.programId) programIds.add(link.programId);
      if (link?.cycleId) cycleIds.add(link.cycleId);
    }
    const audiences = programIds.size + cycleIds.size > 0 ? await store.audiences({ programIds: [...programIds], cycleIds: [...cycleIds] }) : null;

    const rows: StoredAnalyticsEvent[] = [];
    const counters: { programId: string; name: string }[] = [];
    for (const cand of candidates) {
      const link = programLink(cand.props);
      if (link && audiences) {
        const byProgram = link.programId ? audiences.programs.get(link.programId) : undefined;
        const byCycle = link.cycleId ? audiences.cycles.get(link.cycleId) : undefined;
        if ((link.programId && !byProgram) || (link.cycleId && !byCycle)) {
          counts.unknown_program++;
          continue;
        }
        if (byProgram && byCycle && byProgram.programId !== byCycle.programId) {
          counts.mismatch++;
          continue;
        }
        const audience = (byCycle ?? byProgram)!;
        if (audience.restricted) {
          counters.push({ programId: audience.programId, name: cand.name });
          continue;
        }
      }
      rows.push({ name: cand.name, deviceId: cand.sessionId, at: cand.at, path: cand.path, props: cand.props, userHmac: null, hmacKeyId: null });
    }

    if (counters.length > 0 && parsed.data.events.length > 1) {
      // s10 10.9.2: restricted events travel alone; inside a batch they could be re-linked by
      // arrival. The counter still increments, no row is stored, and this line alerts.
      log.warn("events.restricted_in_batch", { batchSize: parsed.data.events.length, restricted: counters.length });
    }

    const day = utcDay(t);
    for (const counter of counters) await store.incrementCounter(counter.programId, day, counter.name);
    const stored = rows.length > 0 ? await store.insertEvents(rows, t) : 0;

    const droppedTotal = Object.values(counts).reduce((a, b) => a + b, 0);
    if (droppedTotal > 0) log.info("events.dropped", { ...counts });
    return c.json({ accepted: stored + counters.length }, 200);
  });

  app.post("/error-reports", async (c) => {
    c.header("Cache-Control", "no-store");
    if (isBotUserAgent(c.req.header("user-agent"))) return c.body(null, 204);
    const log = logFor(c as unknown as Context);

    const body = await readBody(c);
    if (!body.ok) return body.res;
    const refused = sensitiveRefusal(c, log, body.value, "/api/v1/error-reports");
    if (refused) return refused;
    const parsed = ClientErrorBatchSchema.safeParse(body.value);
    if (!parsed.success) {
      return problemFor(c, "validation_failed", {
        errors: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join(".") || "(root)", message: "Invalid value" })),
      });
    }

    const t = now();
    const network = networkOf(clientIp(c.req.raw.headers));
    const ipVerdict = limiters.errorIp.check(`e:${network}`, t);
    if (!ipVerdict.allowed) return problemFor(c, "rate_limited", {}, { retryAfter: ipVerdict.retryAfterSeconds });
    const bound = await checkBinding(c.env.RATE_LIMIT_PUBLIC, `errors:${network}`);
    if (!bound.allowed) return problemFor(c, "rate_limited", {}, { retryAfter: bound.retryAfterSeconds });

    // Only reports from a build this deployment served become counter rows.
    const accepted = parsed.data.reports.filter((r) => acceptedErrorReport(r, c.env.RELEASE_ID));
    if (accepted.length < parsed.data.reports.length) log.info("client_errors.dropped", { foreignBuild: parsed.data.reports.length - accepted.length });
    if (accepted.length === 0) return c.json({ received: 0 }, 202);

    const store = storeFor(c.env);
    const day = { windowMs: DAY_MS };
    for (const [scope, limit] of [["errors", LIMITS.errorBatchesPerDayPerNetwork], ["errors_all", LIMITS.errorBatchesPerDayGlobal]] as const) {
      const verdict = await store.consumeDailyCap(scope, network, { ...day, limit }, t);
      if (!verdict.allowed) {
        log.warn("events.network_day_cap", { scope });
        return problemFor(c, "rate_limited", {}, { retryAfter: verdict.retryAfterSeconds });
      }
    }

    const keys = accepted.map(errorKey);
    const outcome = await store.recordClientErrors(keys, utcDay(t));
    if (outcome === "no_table") {
      // Until the client_error_daily migration is applied, Workers Logs (7 days) is the record.
      for (const k of keys) {
        log.warn("client_error", { kind: k.kind, surface: k.surface, errorClass: k.errorClass, route: k.route, release: k.release, browser: k.browser, file: k.file || null, line: k.line });
      }
    }
    return c.json({ received: keys.length }, 202);
  });

  return app;
}

export const eventsRoutes = createEventsRoutes();
export { ROUTE_TEMPLATES, EVENT_PROPS, routeTemplate } from "./allowlist";
export { ClientErrorBatchSchema, ClientErrorReportSchema, type ClientErrorReport } from "./client-errors";
export { SAMPLE_RATES, ERROR_SAMPLE_RATE, sampleBucket, inSample } from "./sampling";
