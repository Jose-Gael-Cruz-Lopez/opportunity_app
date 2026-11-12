import { Hono, type Context } from "hono";
import { getDb } from "@server/db/client";
import { problemFor } from "@server/lib/problem";
import { checkBinding, clientIp, type RateLimitBindingLike } from "@server/lib/rate-limit";
import { verifyTurnstile } from "@server/lib/turnstile";
import { escapeHtml } from "@server/services/email/templates";
import { confirmContact, consumeNetworkLimit, previewConfirmation, requestReminder, RemindMeBodySchema, type ConfirmPreview } from "./service";
import { verifyConfirmToken } from "./token";

/**
 * POST /api/v1/remind-me (route map id `remindMe`) and the confirmation link it emails.
 *
 *   registry router:  .route("/", remindRoutes)        -> POST /api/v1/remind-me
 *   root, beside emailLinkRoutes: .route("/", remindLinkRoutes) -> GET/POST /e/rc/:token
 *
 * Turnstile runs on every request and fails closed: a missing secret, a Cloudflare outage or a
 * timeout answers 503 (codes fail open; this form makes Novus email any typed address, so it
 * must not). The answer is the same 202 whether the address is new, pending, confirmed or
 * suppressed. Logs and errors carry codes only, never the address or the token.
 */

export interface RemindBindings {
  readonly DB: D1Database;
  readonly BETTER_AUTH_SECRET?: string;
  readonly TURNSTILE_SECRET_KEY?: string;
  readonly RATE_LIMIT_SEND?: RateLimit;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RemindRouteOptions {
  readonly now?: () => number;
  /** Turnstile siteverify transport; tests pass a stub (no network). */
  readonly fetch?: FetchLike;
  readonly sendBinding?: (env: RemindBindings) => RateLimitBindingLike | undefined;
}

type RemindContext = Context<{ Bindings: RemindBindings }>;

export function createRemindRoutes(opts: RemindRouteOptions = {}) {
  const now = opts.now ?? Date.now;
  const app = new Hono<{ Bindings: RemindBindings }>();

  app.post("/remind-me", async (c: RemindContext) => {
    c.header("Cache-Control", "no-store");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return problemFor(c, "bad_request", { detail: "Expected a JSON body." });
    }
    const parsed = RemindMeBodySchema.safeParse(raw);
    if (!parsed.success) {
      return problemFor(c, "validation_failed", {
        errors: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join(".") || "(root)", message: "Invalid value" })),
      });
    }
    const ip = clientIp(c.req.raw.headers);
    const verdict = await verifyTurnstile({ secret: c.env.TURNSTILE_SECRET_KEY, token: parsed.data.turnstileToken, remoteIp: ip, fetch: opts.fetch });
    if (!verdict.ok) {
      if (verdict.reason === "not_configured") return problemFor(c, "unavailable", { detail: "Reminders are not available right now." }, { retryAfter: 300 });
      return problemFor(c, "forbidden", { detail: "The verification check failed. Reload the page and try again." });
    }
    if (verdict.failOpen) return problemFor(c, "unavailable", { detail: "The verification check is unavailable. Try again in a few minutes." }, { retryAfter: 60 });

    const secret = c.env.BETTER_AUTH_SECRET;
    if (!secret) return problemFor(c, "unavailable", { detail: "Reminders are not available right now." }, { retryAfter: 300 });
    const binding = await checkBinding(opts.sendBinding ? opts.sendBinding(c.env) : c.env.RATE_LIMIT_SEND, `remind:${ip}`);
    if (!binding.allowed) return problemFor(c, "rate_limited", {}, { retryAfter: binding.retryAfterSeconds });
    const db = getDb(c.env.DB);
    const t = now();
    const network = await consumeNetworkLimit(db, secret, ip, t);
    if (!network.allowed) return problemFor(c, "rate_limited", {}, { retryAfter: network.retryAfterSeconds });

    const outcome = await requestReminder(db, { body: parsed.data, secret, now: t });
    switch (outcome.kind) {
      case "not_found":
        return problemFor(c, "not_found", { detail: "That program cycle is not listed." });
      case "under_age":
        return problemFor(c, "bad_request", { detail: "Email reminders are for students 16 and older. Add the deadline to your calendar from the program page instead." });
      case "consent_required":
        return problemFor(c, "consent_required", { detail: "This program needs your opt-in before Novus can save a reminder. Use the official link or the calendar file instead." });
      default:
        return c.json({ status: "pending_confirmation" as const }, 202);
    }
  });

  return app;
}

export const remindRoutes = createRemindRoutes();

// =============================================================================================
// Confirmation link: GET renders a page and changes nothing; POST (same-origin form) confirms.
// =============================================================================================

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;line-height:1.5">${body}</body></html>`;
}

const EXPIRED = page("Link expired", "<h1>This link has expired</h1><p>Ask for reminders again from the program page.</p>");
const UNAVAILABLE = page(
  "Reminders unavailable",
  "<h1>Reminders are not available for this program</h1><p>Use the official link or the calendar file on the program page instead. Nothing was turned on.</p>",
);

/** Exactly what confirming turns on (s01 F-08: the page lists which reminders will arrive). */
function previewHtml(p: ConfirmPreview): string {
  const consent = p.recordsConsent
    ? "<p>This program is defined by a status or identity, so emails and this page leave its name out. Confirming also records your consent for Novus to keep this one reminder linked to your address. You can stop it from any email.</p>"
    : "";
  const campus = p.nominationGated && !p.neutral
    ? "<p>Campus deadlines for this program come weeks before the national one and may already have passed: contact your fellowship office today.</p>"
    : "";
  return `<p>Confirming turns on reminders for one program: <strong>${escapeHtml(p.label)}</strong>.</p><ul><li>an email 2 days before each deadline;</li><li>a weekly list of its dates in the next two weeks;</li><li>an email if one of its dates changes.</li></ul><p>Nothing else is turned on. Every email has a one-click unsubscribe link.</p>${consent}${campus}`;
}

export function createRemindLinkRoutes(opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const app = new Hono<{ Bindings: RemindBindings }>();

  app.get("/e/rc/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const secret = c.env.BETTER_AUTH_SECRET;
    const claims = secret ? await verifyConfirmToken(secret, c.req.param("token"), now()) : null;
    if (!claims) return c.html(EXPIRED, 404);
    const preview = await previewConfirmation(getDb(c.env.DB), claims);
    if (!preview) return c.html(EXPIRED, 404);
    return c.html(
      page(
        "Confirm reminders",
        `<h1>Confirm your Novus reminders</h1>${previewHtml(preview)}<form method="post" action="${escapeHtml(c.req.path)}"><button type="submit">Confirm reminders</button></form><p>If you did not ask for this, close this page: nothing is turned on.</p>`,
      ),
    );
  });

  app.post("/e/rc/:token", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    const secret = c.env.BETTER_AUTH_SECRET;
    const t = now();
    const claims = secret ? await verifyConfirmToken(secret, c.req.param("token"), t) : null;
    if (!claims) return c.html(EXPIRED, 404);
    const outcome = await confirmContact(getDb(c.env.DB), claims, t);
    if (outcome.kind === "gone") return c.html(EXPIRED, 404);
    if (outcome.kind === "consent_unavailable") return c.html(UNAVAILABLE, 409);
    return c.html(
      page(
        "Reminders confirmed",
        `<h1>You're set</h1><p>Reminders are on for ${escapeHtml(outcome.preview.label)}. Always confirm dates on the program's official page. To keep everything in one place, you can create a free account with this address later.</p>`,
      ),
    );
  });

  return app;
}

export const remindLinkRoutes = createRemindLinkRoutes();
