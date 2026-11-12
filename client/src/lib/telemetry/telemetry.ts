import { findSensitiveKeys } from "@shared/contracts/sensitive";
import type { EventName, EventPropsMap } from "./events";
import { routeTemplate } from "./route";
import { ERROR_SAMPLE_RATE, inSample, SAMPLE_RATES } from "./sampling";
import { randomId, SessionId, type SessionStore } from "./session";

/**
 * First-party telemetry for the SPA and the console (plan s10 10.9, s02 2.3.12). No vendor, no
 * cookie, no account id: events carry an allowlisted name, a route template, a time and the
 * session-scoped id from session.ts; client errors carry the shape of a crash and no id at all.
 *
 * - Nothing is sent under Global Privacy Control, or after `setConsent(false)` (the app calls it
 *   for accounts with analytics off and in minor mode). Turning consent off drops the queue.
 * - `blockForUnderAge()` (onboarding's under-16 answer, plan 9.10.2) turns everything off for
 *   the rest of the tab: it drops the queue, forgets the session id and the error counter, and
 *   leaves a sessionStorage flag that this class reads on start, so a reload stays off and a
 *   later `setConsent(true)` cannot turn it back on. Events sent before the answer are on the
 *   server under the forgotten id; purging them needs an endpoint, which is not built yet.
 * - Events about a status- or identity-defined program (`{ restricted: true }`) are sent alone,
 *   without cookies, with a one-time id and the day only, so the server can count them but
 *   nothing can link them to the session (s10 10.9.2).
 * - Batches of up to 20 go out every 5 s, when 20 are queued, and when the page is hidden, by
 *   `navigator.sendBeacon` with a text/plain body (CORS-safelisted), or `fetch` keepalive.
 * - Sampling is per session and per event name, mirrored from the server.
 */

export const EVENTS_URL = "/api/v1/events";
export const ERRORS_URL = "/api/v1/error-reports";
export const MAX_BATCH = 20;
export const FLUSH_MS = 5_000;
/** Client error caps (judgment): per page load and per session. */
export const ERRORS_PER_PAGE = 5;
export const ERRORS_PER_SESSION = 20;
export const ERROR_COUNT_KEY = "nv.terr";
/** Session-scoped flag: an under-16 answer was given in this tab, so telemetry stays off. */
export const AGE_BLOCK_KEY = "nv.tblock";

export interface TelemetryEnv {
  now(): number;
  /** sessionStorage, or null where it is unavailable. */
  storage: SessionStore | null;
  random(bytes: Uint8Array): Uint8Array;
  sendBeacon?: (url: string, data: Blob) => boolean;
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
  /** navigator.globalPrivacyControl */
  gpc(): boolean;
  pathname(): string;
  /** The page origin, to tell first-party script files from extensions and third parties. */
  origin(): string;
  userAgent(): string;
  release: string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface TrackOptions {
  /** The event names a sensitive- or identity-audience program: counter path only. */
  readonly restricted?: boolean;
}

export type ErrorKind = "error" | "unhandledrejection" | "boundary" | "island";
export type ErrorSurface = "spa" | "island" | "console";

export interface ClientErrorReport {
  kind: ErrorKind;
  surface: ErrorSurface;
  errorClass: string;
  route: string;
  release: string;
  browser: "chrome" | "safari" | "firefox" | "edge" | "samsung" | "in_app" | "other";
  file: string | null;
  line: number | null;
  column: number | null;
}

interface QueuedEvent {
  name: EventName;
  deviceId: string;
  at: string;
  path: string;
  props: Record<string, string | number | boolean>;
}

const ERROR_CLASS = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/;
const RELEASE = /^[0-9A-Za-z._-]{1,40}$/;

export function browserFamily(ua: string): ClientErrorReport["browser"] {
  if (/FBAN|FBAV|Instagram|Line\/|Snapchat|TikTok|musical_ly|GSA\//.test(ua)) return "in_app";
  if (/SamsungBrowser/.test(ua)) return "samsung";
  if (/Edg\//.test(ua)) return "edge";
  if (/Firefox\/|FxiOS/.test(ua)) return "firefox";
  if (/Chrome\/|CriOS/.test(ua)) return "chrome";
  if (/Safari\//.test(ua)) return "safari";
  return "other";
}

/** The constructor name only (`TypeError`), never the message. */
export function errorClassOf(error: unknown): string {
  const name = error instanceof Error ? error.name : error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string" ? (error as { name: string }).name : "";
  if (ERROR_CLASS.test(name)) return name;
  return error instanceof Error ? "Error" : "NonError";
}

/**
 * The first stack frame in a first-party bundle (`/assets/<file>.js` on this origin), as a bare
 * file name with line and column. Frames from extensions, third parties or other paths are
 * skipped; the stack text itself never leaves this function.
 */
export function firstPartyFrame(error: unknown, origin: string): { file: string; line: number; column: number } | null {
  const stack = error instanceof Error && typeof error.stack === "string" ? error.stack : "";
  if (!stack) return null;
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escaped}/assets/([A-Za-z0-9._-]{1,80}\\.m?js):(\\d{1,8}):(\\d{1,8})`, "g");
  const match = re.exec(stack);
  if (!match) return null;
  return { file: match[1]!, line: Number(match[2]), column: Number(match[3]) };
}

export class Telemetry {
  private readonly session: SessionId;
  private queue: QueuedEvent[] = [];
  private timer: unknown = null;
  private consent = true;
  private ageBlocked = false;
  private readonly errorsThisPage = new Set<string>();

  constructor(private readonly env: TelemetryEnv) {
    this.session = new SessionId(env.storage, env.random);
    try {
      this.ageBlocked = env.storage?.getItem(AGE_BLOCK_KEY) === "1";
    } catch {
      // Blocked storage: no flag could have been written either.
    }
  }

  /** False under GPC, after setConsent(false), or after an under-16 answer in this tab. */
  enabled(): boolean {
    return this.consent && !this.ageBlocked && !this.env.gpc();
  }

  /**
   * An under-16 answer: nothing more leaves this tab (events or crash reports), the queue is
   * dropped, and the session id and error counter are forgotten so nothing after this point
   * could share an id with what came before. Lasts for the tab, whatever consent says later.
   */
  blockForUnderAge(): void {
    this.ageBlocked = true;
    this.setConsent(false);
    this.session.clear();
    const store = this.env.storage;
    if (!store) return;
    try {
      if (store.removeItem) store.removeItem(ERROR_COUNT_KEY);
      else store.setItem(ERROR_COUNT_KEY, "0");
      store.setItem(AGE_BLOCK_KEY, "1");
    } catch {
      // Blocked storage: the in-memory block still holds for this page.
    }
  }

  /** The app's analytics choice: false for accounts with analytics off or in minor mode. */
  setConsent(allowed: boolean): void {
    this.consent = allowed;
    if (!allowed) {
      this.queue = [];
      this.cancelTimer();
    }
  }

  track<N extends EventName>(name: N, props: EventPropsMap[N], options: TrackOptions = {}): void {
    if (!this.enabled()) return;
    const clean = cleanProps(props as Record<string, unknown>);
    if (!clean) return;
    const now = this.env.now();
    const path = routeTemplate(this.env.pathname());

    if (options.restricted) {
      // Alone, cookie-less, one-time id, day only: countable, never linkable.
      const day = new Date(now);
      day.setUTCHours(0, 0, 0, 0);
      const event: QueuedEvent = { name, deviceId: randomId(this.env.random), at: day.toISOString(), path, props: clean };
      this.send(EVENTS_URL, { events: [event] }, { alone: true });
      return;
    }

    const sessionId = this.session.current(now);
    if (!inSample(sessionId, SAMPLE_RATES[name])) return;
    this.queue.push({ name, deviceId: sessionId, at: new Date(now).toISOString(), path, props: clean });
    if (this.queue.length >= MAX_BATCH) this.flush();
    else if (this.timer === null) this.timer = this.env.setTimer(() => this.flush(), FLUSH_MS);
  }

  /** Sends what is queued; call on `visibilitychange` (hidden) and `pagehide`. */
  flush(): void {
    this.cancelTimer();
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, MAX_BATCH);
      if (!this.enabled()) continue;
      this.send(EVENTS_URL, { events: batch }, { alone: false });
    }
  }

  /**
   * Reports a crash's shape: class, route template, release, browser family and the first-party
   * file and line. Deduplicated per page, capped per page and per session, sampled per session.
   */
  reportError(error: unknown, kind: ErrorKind, surface: ErrorSurface = "spa"): ClientErrorReport | null {
    if (!this.enabled()) return null;
    const now = this.env.now();
    if (!inSample(this.session.current(now), ERROR_SAMPLE_RATE)) return null;
    const frame = firstPartyFrame(error, this.env.origin());
    const report: ClientErrorReport = {
      kind,
      surface,
      errorClass: errorClassOf(error),
      route: routeTemplate(this.env.pathname()),
      release: RELEASE.test(this.env.release) ? this.env.release : "unknown",
      browser: browserFamily(this.env.userAgent()),
      file: frame?.file ?? null,
      line: frame?.line ?? null,
      column: frame?.column ?? null,
    };
    const signature = [report.kind, report.errorClass, report.route, report.file, report.line].join("|");
    if (this.errorsThisPage.has(signature) || this.errorsThisPage.size >= ERRORS_PER_PAGE) return null;
    if (!this.bumpSessionErrors()) return null;
    this.errorsThisPage.add(signature);
    this.send(ERRORS_URL, { reports: [report] }, { alone: false });
    return report;
  }

  private bumpSessionErrors(): boolean {
    const store = this.env.storage;
    if (!store) return true;
    try {
      const n = Number(store.getItem(ERROR_COUNT_KEY) ?? "0") || 0;
      if (n >= ERRORS_PER_SESSION) return false;
      store.setItem(ERROR_COUNT_KEY, String(n + 1));
    } catch {
      // Blocked storage: the per-page cap still applies.
    }
    return true;
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.env.clearTimer(this.timer);
    this.timer = null;
  }

  private send(url: string, payload: unknown, opts: { alone: boolean }): void {
    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch {
      return;
    }
    try {
      // Restricted events never use sendBeacon: it always sends cookies.
      if (!opts.alone && this.env.sendBeacon?.(url, new Blob([body], { type: "text/plain;charset=UTF-8" }))) return;
      void this.env
        .fetch?.(url, {
          method: "POST",
          body,
          headers: { "content-type": "text/plain;charset=UTF-8" },
          credentials: opts.alone ? "omit" : "same-origin",
          keepalive: true,
        })
        ?.catch(() => undefined);
    } catch {
      // Telemetry never breaks the page.
    }
  }
}

/** Scalars only, strings up to 64 characters, no sensitive-looking key; null drops the event. */
export function cleanProps(props: Record<string, unknown>): Record<string, string | number | boolean> | null {
  if (findSensitiveKeys(props).length > 0) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      if (value.length > 64) return null;
      out[key] = value;
    } else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
      out[key] = value;
    } else {
      return null;
    }
  }
  return out;
}
