/**
 * Content-free error reports to Sentry over its envelope endpoint (plan 02 2.3.12). No SDK is
 * installed, and this keeps it that way: an event carries the error class, the route template,
 * the request id and the environment, and nothing else. No message, stack arguments, URL, query,
 * headers, body or user is ever sent, so bearer tokens in paths (/cal/u/:token) cannot leak.
 */

export interface SentryDsn {
  readonly publicKey: string;
  readonly host: string;
  readonly projectId: string;
  readonly protocol: string;
}

/** Parses `https://<key>@<host>/<project>`; null for anything else. */
export function parseDsn(dsn: string | null | undefined): SentryDsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!u.username || !/^[0-9]+$/.test(projectId) || (u.protocol !== "https:" && u.protocol !== "http:")) return null;
    return { publicKey: u.username, host: u.host, projectId, protocol: u.protocol.slice(0, -1) };
  } catch {
    return null;
  }
}

export interface ErrorReport {
  /** Error class name only, e.g. "TypeError" or "D1_ERROR". */
  readonly errorClass: string;
  /** Route template such as `/cal/u/:file{...}`, never the concrete path. */
  readonly route: string;
  readonly method: string;
  readonly requestId: string;
  readonly environment: string;
  readonly release?: string;
}

const SAFE_TOKEN = /^[A-Za-z0-9_.:{}\[\]\\\/*+-]{0,200}$/;

function safe(value: string, fallback: string): string {
  return SAFE_TOKEN.test(value) ? value : fallback;
}

/** Builds the envelope body: three newline-separated JSON lines. */
export function buildEnvelope(dsn: SentryDsn, report: ErrorReport, eventId: string, nowMs: number): string {
  const sentAt = new Date(nowMs).toISOString();
  const dsnString = `${dsn.protocol}://${dsn.publicKey}@${dsn.host}/${dsn.projectId}`;
  const event = {
    event_id: eventId,
    timestamp: nowMs / 1000,
    platform: "javascript",
    level: "error",
    environment: safe(report.environment, "unknown"),
    ...(report.release ? { release: safe(report.release, "unknown") } : {}),
    transaction: safe(report.route, "unknown"),
    exception: { values: [{ type: safe(report.errorClass, "Error"), value: "redacted" }] },
    tags: { route: safe(report.route, "unknown"), method: safe(report.method, "GET"), request_id: safe(report.requestId, "none") },
  };
  return [JSON.stringify({ event_id: eventId, dsn: dsnString, sent_at: sentAt }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join(
    "\n",
  );
}

export function envelopeUrl(dsn: SentryDsn): string {
  return `${dsn.protocol}://${dsn.host}/api/${dsn.projectId}/envelope/`;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Sends one report; never throws (reporting must not turn one failure into two). */
export async function sendErrorReport(
  dsnValue: string | null | undefined,
  report: ErrorReport,
  options: { fetch?: FetchLike; now?: number; eventId?: string } = {},
): Promise<boolean> {
  const dsn = parseDsn(dsnValue);
  if (!dsn) return false;
  const eventId = options.eventId ?? crypto.randomUUID().replace(/-/g, "");
  const body = buildEnvelope(dsn, report, eventId, options.now ?? Date.now());
  try {
    const res = await (options.fetch ?? fetch)(envelopeUrl(dsn), {
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=novus-worker/1.0`,
      },
      body,
    });
    return res.ok;
  } catch {
    return false;
  }
}
