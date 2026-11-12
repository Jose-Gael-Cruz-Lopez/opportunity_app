/**
 * How the auth module sends sign-in codes. server/services/email does not exist yet, so this is a
 * narrow port: when the email service lands, pass an adapter to `createAuthRoutes({ mailer })`
 * (or replace `mailerFromEnv`) and nothing else in server/auth changes.
 *
 * Mail-send abuse controls (Turnstile, per-IP binding, per-address HMAC counters, the global cap;
 * plan S02-039) live in the guard in front of the send endpoint (./send-guard.ts), not here.
 */
import type { AuthBindings } from "./types";

export interface SignInCodeMessage {
  to: string;
  code: string;
  expiresInMinutes: number;
  purpose: "sign-in" | "email-verification";
}

export interface AuthMailer {
  sendSignInCode(message: SignInCodeMessage): Promise<void>;
}

/** Plain text only: one short message with no links, so it survives every client and filter. */
export function renderSignInCode(message: SignInCodeMessage): { subject: string; text: string } {
  return {
    subject: `${message.code} is your Novus code`,
    text: [
      `Your Novus code is ${message.code}.`,
      "",
      `It expires in ${message.expiresInMinutes} minutes and works once.`,
      "If you did not ask for it, you can ignore this email. Novus will never ask you for this code.",
    ].join("\n"),
  };
}

/** The sender address on the app's own domain (a placeholder until the email service owns it). */
export function senderAddress(appOrigin: string): string {
  const host = new URL(appOrigin).hostname;
  return `Novus <no-reply@${host}>`;
}

export function mailerFromEnv(env: AuthBindings): AuthMailer {
  return {
    async sendSignInCode(message) {
      const { subject, text } = renderSignInCode(message);
      if (env.EMAIL) {
        await env.EMAIL.send({ from: senderAddress(env.APP_ORIGIN), to: message.to, subject, text });
        return;
      }
      // Local development has no email binding, so the code goes to the dev console. This branch
      // is reachable only when ENVIRONMENT is exactly "local"; anywhere else a missing binding is
      // an error, so a misconfigured deploy cannot write codes to production logs.
      if (env.ENVIRONMENT === "local") {
        console.info(`[auth] local sign-in code for ${message.to}: ${message.code}`);
        return;
      }
      throw new Error("EMAIL binding is not configured");
    },
  };
}
