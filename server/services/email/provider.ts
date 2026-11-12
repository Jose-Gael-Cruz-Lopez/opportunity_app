import type { Logger, WorkerBindings } from "@server/jobs/types";

/**
 * `EmailProvider` (architecture 2.3.11): one interface, one active provider through Phase 2.
 * Cloudflare Email Sending is a binding (`EMAIL`), so no API key exists anywhere. Amazon SES, the
 * warm standby, will implement the same interface behind the `email.provider` flag.
 */

export type EmailStream = "transactional" | "digest";

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Extra headers, e.g. List-Unsubscribe and List-Unsubscribe-Post (RFC 8058). */
  readonly headers: Readonly<Record<string, string>>;
  readonly stream: EmailStream;
  /** `notif:{alertId}:{channel}`; providers that support idempotency keys receive it. */
  readonly idempotencyKey: string;
}

export type SendOutcome =
  | { readonly ok: true; readonly messageId: string | null; readonly dryRun: boolean }
  | { readonly ok: false; readonly retryable: boolean; readonly errorClass: string };

export interface EmailProvider {
  readonly name: string;
  send(message: OutgoingEmail): Promise<SendOutcome>;
}

/**
 * Error classes the binding raises that will not succeed on retry (bad address, policy refusal).
 * Everything else (quota, rate limits, outages) is retried until the Notification expires.
 */
const PERMANENT_ERROR = /invalid|recipient|not allowed|forbidden|unverified|policy|suppress/i;

export function classifySendError(err: unknown): { retryable: boolean; errorClass: string } {
  const name = err instanceof Error ? err.name || "Error" : "UnknownError";
  const code = err && typeof err === "object" && "code" in err ? String((err as { code: unknown }).code) : "";
  const message = err instanceof Error ? err.message : "";
  const permanent = PERMANENT_ERROR.test(code) || PERMANENT_ERROR.test(message);
  // The class is name plus code only; the message may echo the recipient address.
  return { retryable: !permanent, errorClass: `${name}${code ? `:${code}` : ""}`.slice(0, 120) };
}

/** Cloudflare Email Sending through the `send_email` binding's structured builder API. */
export function createCloudflareProvider(binding: SendEmail, from: string): EmailProvider {
  return {
    name: "cloudflare",
    async send(message) {
      try {
        const res = await binding.send({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
          headers: { ...message.headers },
        });
        return { ok: true, messageId: res?.messageId ?? null, dryRun: false };
      } catch (err) {
        return { ok: false, ...classifySendError(err) };
      }
    },
  };
}

/**
 * Local development and tests: records messages instead of sending them. The dispatcher still
 * runs every rule (quiet hours, quota, suppression), so local runs exercise the real path.
 */
export function createDryRunProvider(log?: Logger): EmailProvider & { readonly sent: OutgoingEmail[] } {
  const sent: OutgoingEmail[] = [];
  return {
    name: "dry-run",
    sent,
    async send(message) {
      sent.push(message);
      log?.("info", "email.dry_run", { stream: message.stream, idempotencyKey: message.idempotencyKey });
      return { ok: true, messageId: null, dryRun: true };
    },
  };
}

/** The sender: an explicit EMAIL_FROM, else `notify@` the app's host. */
export function senderAddress(env: Pick<WorkerBindings, "EMAIL_FROM" | "APP_ORIGIN">): string {
  if (env.EMAIL_FROM) return env.EMAIL_FROM;
  let host = "localhost";
  try {
    host = new URL(env.APP_ORIGIN ?? "http://localhost").hostname;
  } catch {
    // keep localhost
  }
  return `Novus <notify@${host}>`;
}

/** Real sends only from staging and production with a binding; local always dry-runs. */
export function providerFor(env: WorkerBindings, log?: Logger): EmailProvider {
  if (env.EMAIL && (env.ENVIRONMENT === "staging" || env.ENVIRONMENT === "production")) {
    return createCloudflareProvider(env.EMAIL, senderAddress(env));
  }
  return createDryRunProvider(log);
}
