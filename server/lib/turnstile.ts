/**
 * Turnstile siteverify with the plan's fail-open rules (plan 02 2.3.10). It fails open only on a
 * network error, a call slower than 3 s, an HTTP 5xx or the `internal-error` code, never on a
 * bad, missing, expired or reused token. Callers apply a tighter limit while failing open.
 */

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_TIMEOUT_MS = 3_000;

export type TurnstileResult =
  | { readonly ok: true; readonly failOpen: false }
  | { readonly ok: true; readonly failOpen: true; readonly reason: "network" | "timeout" | "server_error" | "internal_error" }
  | { readonly ok: false; readonly reason: "missing_token" | "rejected" | "not_configured" };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export async function verifyTurnstile(input: {
  secret: string | undefined;
  token: string | null | undefined;
  remoteIp?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<TurnstileResult> {
  if (!input.secret) return { ok: false, reason: "not_configured" };
  if (!input.token || input.token.length > 2048) return { ok: false, reason: "missing_token" };

  const form = new FormData();
  form.set("secret", input.secret);
  form.set("response", input.token);
  if (input.remoteIp && input.remoteIp !== "unknown") form.set("remoteip", input.remoteIp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? TURNSTILE_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (input.fetch ?? fetch)(SITEVERIFY_URL, { method: "POST", body: form, signal: controller.signal });
  } catch {
    return { ok: true, failOpen: true, reason: controller.signal.aborted ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
  if (res.status >= 500) return { ok: true, failOpen: true, reason: "server_error" };

  let body: { success?: unknown; "error-codes"?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: true, failOpen: true, reason: "server_error" };
  }
  if (body.success === true) return { ok: true, failOpen: false };
  const codes = Array.isArray(body["error-codes"]) ? (body["error-codes"] as unknown[]) : [];
  if (codes.length > 0 && codes.every((code) => code === "internal-error")) {
    return { ok: true, failOpen: true, reason: "internal_error" };
  }
  return { ok: false, reason: "rejected" };
}
