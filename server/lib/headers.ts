import type { Context } from "hono";

/**
 * Sets response headers even when the response came from fetch() or an ASSETS binding, whose
 * headers are immutable: on a TypeError the response is copied once and the write retried.
 */
export function setResponseHeaders(c: Context, headers: Readonly<Record<string, string>>, onlyIfMissing = false): void {
  const apply = (target: Headers): void => {
    for (const [k, v] of Object.entries(headers)) {
      if (onlyIfMissing && target.has(k)) continue;
      target.set(k, v);
    }
  };
  try {
    apply(c.res.headers);
  } catch {
    const copy = new Response(c.res.body, c.res);
    apply(copy.headers);
    // Assign through a fresh Context response so Hono does not merge stale headers back in.
    c.res = undefined as unknown as Response;
    c.res = copy;
  }
}
