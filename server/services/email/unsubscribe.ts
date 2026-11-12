import { Hono } from "hono";
import type { Db } from "@server/db/client";
import { getDb } from "@server/db/client";
import { notifications } from "@server/db/repos";
import type { WorkerBindings } from "@server/jobs/types";
import { escapeHtml } from "./templates";
import { deleteSubscriptions } from "./store";
import { verifyUnsubscribeToken, type UnsubscribeClaims } from "./tokens";

/**
 * RFC 8058 one-click unsubscribe at `/e/u/:token` (architecture 2.3.11, plan 6.7.4).
 *
 * - GET renders a confirmation page with a button and changes nothing (the GET-replay test).
 * - POST unsubscribes. Mailbox providers send it from their servers with no cookie, Origin or
 *   Sec-Fetch-Site, so this router must be mounted OUTSIDE csrf()/origin middleware. It
 *   authenticates by the token alone, is idempotent, and answers 200 with no redirect.
 *
 * Mount: `app.route("/", emailLinkRoutes)` before the pages router's CSRF middleware.
 */

/**
 * What one list removes. notification_prefs has no per-list columns for change alerts or
 * reminders yet, so for accounts both map to the email channel switch (codes are unaffected:
 * they never go through notify.dispatch). Per-cycle reminders remove that cycle's Remind-me
 * subscription. Contacts are Remind-me-only, so any list removes their subscriptions.
 */
export async function applyUnsubscribe(db: Db, claims: UnsubscribeClaims, now: number): Promise<void> {
  const [kind, id] = [claims.r.slice(0, 1), claims.r.slice(2)];
  if (kind === "c") {
    await deleteSubscriptions(db, { contactId: id }, claims.l === "cycle_reminders" ? (claims.c ?? null) : null);
    return;
  }
  if (claims.l === "cycle_reminders") {
    await deleteSubscriptions(db, { userId: id }, claims.c ?? null);
    return;
  }
  const prefs = await notifications.getNotificationPrefs(db, id);
  const next =
    claims.l === "weekly" ? { ...prefs, weeklyEmail: false } : { ...prefs, channels: { ...prefs.channels, email: false } };
  await notifications.saveNotificationPrefs(db, id, next, now);
}

const LIST_LABEL: Record<UnsubscribeClaims["l"], string> = {
  weekly: "the weekly email",
  alerts: "change alerts by email",
  reminders: "reminder emails",
  cycle_reminders: "reminders for this program",
};

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;line-height:1.5">${body}</body></html>`;
}

/** Reads `List-Unsubscribe=One-Click` from a form-encoded or multipart body. */
export async function isOneClickBody(req: Request): Promise<boolean> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/x-www-form-urlencoded") && !type.includes("multipart/form-data")) return false;
  try {
    const form = await req.formData();
    return form.get("List-Unsubscribe") === "One-Click";
  } catch {
    return false;
  }
}

export const emailLinkRoutes = new Hono<{ Bindings: WorkerBindings }>();

emailLinkRoutes.get("/e/u/:token", async (c) => {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  const secret = c.env.BETTER_AUTH_SECRET;
  const claims = secret ? await verifyUnsubscribeToken(secret, c.req.param("token"), Date.now()) : null;
  if (!claims) return c.html(page("Link expired", "<h1>This link has expired</h1><p>Manage your email settings from your Novus account.</p>"), 404);
  const action = escapeHtml(c.req.path);
  return c.html(
    page(
      "Unsubscribe",
      `<h1>Stop ${escapeHtml(LIST_LABEL[claims.l])}?</h1><form method="post" action="${action}"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button type="submit">Unsubscribe</button></form><p>Sign-in codes are never affected.</p>`,
    ),
  );
});

emailLinkRoutes.post("/e/u/:token", async (c) => {
  c.header("Cache-Control", "no-store");
  const secret = c.env.BETTER_AUTH_SECRET;
  const claims = secret ? await verifyUnsubscribeToken(secret, c.req.param("token"), Date.now()) : null;
  if (!claims) return c.text("This link has expired.", 404);
  if (!(await isOneClickBody(c.req.raw))) return c.text("Expected List-Unsubscribe=One-Click.", 400);
  await applyUnsubscribe(getDb(c.env.DB), claims, Date.now());
  // 200 every time, including repeats: the RFC forbids redirects and providers retry blindly.
  return c.html(page("Unsubscribed", `<h1>You are unsubscribed</h1><p>You will no longer get ${escapeHtml(LIST_LABEL[claims.l])}.</p>`), 200);
});
