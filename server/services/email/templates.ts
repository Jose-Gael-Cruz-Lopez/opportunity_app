/**
 * Alert email rendering: plain text first (it must stand alone when Novus is down), plus a
 * minimal HTML part. No tracking pixel, no remote images, no promotions in transactional mail.
 */

export interface AlertEmailInput {
  readonly title: string;
  readonly body: string;
  /** Relative in-app link from the Alert. */
  readonly href: string | null;
  readonly appOrigin: string;
  readonly unsubscribeUrl: string | null;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Joins a relative href to the origin; anything that is not a same-site path falls back to `/`. */
export function absoluteLink(appOrigin: string, href: string | null): string {
  const origin = appOrigin.replace(/\/$/, "");
  const path = href && href.startsWith("/") && !href.startsWith("//") ? href : "/";
  return `${origin}${path}`;
}

/** Subjects are one line: no CR/LF (header injection) and at most 150 characters. */
export function safeSubject(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim().slice(0, 150);
}

export function renderAlertEmail(input: AlertEmailInput): RenderedEmail {
  const link = absoluteLink(input.appOrigin, input.href);
  const footer = [
    "You get this email because you follow this program on Novus.",
    "Always confirm dates on the program's official page before you rely on them.",
    input.unsubscribeUrl ? `Stop these emails: ${input.unsubscribeUrl}` : null,
  ].filter((line): line is string => line !== null);

  const text = [input.title, "", input.body, "", `Details: ${link}`, "", "--", ...footer].join("\n");

  const html = [
    "<!doctype html><html><body style=\"font-family:system-ui,sans-serif;line-height:1.5;color:#1a1a1a;max-width:560px\">",
    `<h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(input.title)}</h1>`,
    `<p style="margin:0 0 16px">${escapeHtml(input.body)}</p>`,
    `<p style="margin:0 0 24px"><a href="${escapeHtml(link)}">Open in Novus</a></p>`,
    `<hr style="border:none;border-top:1px solid #ddd">`,
    ...footer.map((line) =>
      input.unsubscribeUrl && line.startsWith("Stop these emails")
        ? `<p style="font-size:12px;color:#555"><a href="${escapeHtml(input.unsubscribeUrl)}">Stop these emails</a></p>`
        : `<p style="font-size:12px;color:#555">${escapeHtml(line)}</p>`,
    ),
    "</body></html>",
  ].join("");

  return { subject: safeSubject(input.title), text, html };
}
