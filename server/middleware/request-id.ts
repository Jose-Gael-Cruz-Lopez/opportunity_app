import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { setResponseHeaders } from "../lib/headers";

export const REQUEST_ID_HEADER = "x-request-id";

/** Accepted from callers (the pipeline sends one per job) only when it is a plain identifier. */
const INCOMING_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Gives every request an id, echoed in `x-request-id` and in problem bodies, so a student can
 * quote it and an operator can find the log line without any request content.
 */
export function requestId(generate: () => string = () => crypto.randomUUID()): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    const id = incoming && INCOMING_PATTERN.test(incoming) ? incoming : generate();
    c.set("requestId", id);
    await next();
    // Responses from ASSETS or fetch() have immutable headers; this copes with both.
    setResponseHeaders(c, { [REQUEST_ID_HEADER]: id });
  };
}
