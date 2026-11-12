import type { z } from "zod";
import { ProblemDetailsSchema, type ProblemDetails } from "@shared/contracts/common";
import { buildPath, ROUTES, type RouteId, type RouteMount } from "@shared/contracts/routes";
import { findSensitiveKeys } from "@shared/contracts/sensitive";

/**
 * Typed client for the JSON API in shared/contracts/routes.ts. Every call goes through the route
 * map, so paths, methods and schemas come from one place:
 *
 *   const cards = await api.call("listPrograms", { query: { type: ["research_program"] } });
 *   await api.call("updateTracker", { params: { id }, body: { status: "applying" } });
 *
 * Bodies are validated with the route's zod schema before they leave the browser, and a body
 * carrying a status or identity key is refused here and never sent (privacy rule 3). Responses
 * are validated too, so a contract drift fails loudly instead of rendering wrong data.
 */

type Routes = typeof ROUTES;

/** Mounts the browser may call; pages, calendar and internal routes are not JSON APIs for the SPA. */
const API_MOUNTS: ReadonlySet<RouteMount> = new Set<RouteMount>(["registry", "student", "advisor"]);

type CleanParam<N extends string> = N extends `${infer Name}{${string}` ? Name : N;
/** `"/a/:id/b/:slug"` -> `"id" | "slug"`. */
export type ParamNames<P extends string> = P extends `${string}:${infer Rest}`
  ? Rest extends `${infer Name}/${infer Tail}`
    ? CleanParam<Name> | ParamNames<`/${Tail}`>
    : CleanParam<Rest>
  : never;

export type ParamsOf<Id extends RouteId> = [ParamNames<Routes[Id]["path"]>] extends [never]
  ? undefined
  : Record<ParamNames<Routes[Id]["path"]>, string | number>;

export type ResponseOf<Id extends RouteId> = Routes[Id] extends { readonly response: infer S extends z.ZodTypeAny }
  ? z.output<S>
  : unknown;

export type BodyOf<Id extends RouteId> = Routes[Id] extends { readonly body: infer S extends z.ZodTypeAny } ? z.input<S> : undefined;

type QueryValue = string | number | boolean | readonly (string | number)[] | undefined;
export type QueryOf<Id extends RouteId> = Routes[Id] extends { readonly query: infer S extends z.ZodTypeAny }
  ? { [K in keyof z.output<S>]?: z.output<S>[K] & QueryValue }
  : undefined;

export interface CallOptions<Id extends RouteId> {
  params?: ParamsOf<Id>;
  query?: QueryOf<Id>;
  body?: BodyOf<Id>;
  signal?: AbortSignal;
}

export type ApiErrorKind =
  /** The server answered with problem+json. */
  | "problem"
  /** The request never reached a server (offline, DNS, CORS). */
  | "network"
  /** Something answered, but not the JSON API (dev server HTML, a plain 404 from a missing route). */
  | "not_api"
  /** The response did not match the contract. */
  | "invalid_response"
  /** The body failed the route's schema in the browser; nothing was sent. */
  | "invalid_request"
  /** The body carried a status or identity key; nothing was sent. */
  | "sensitive_blocked";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly problem: ProblemDetails | null;
  /** Field paths only, never values. */
  readonly paths: readonly string[];

  constructor(kind: ApiErrorKind, message: string, opts: { status?: number | null; problem?: ProblemDetails | null; paths?: readonly string[] } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.problem = opts.problem ?? null;
    this.paths = opts.paths ?? [];
  }

  get code(): ProblemDetails["code"] | null {
    return this.problem?.code ?? null;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export interface ApiClientOptions {
  fetch?: typeof fetch;
  /** Origin prefix; empty means same origin, which is how the Worker serves /app. */
  baseUrl?: string;
}

export interface ApiClient {
  call<Id extends RouteId>(id: Id, options?: CallOptions<Id>): Promise<ResponseOf<Id>>;
  /** The URL a call would hit; handy for links and for tests. */
  url<Id extends RouteId>(id: Id, options?: Pick<CallOptions<Id>, "params" | "query">): string;
}

function isJsonContentType(contentType: string | null): boolean {
  return !!contentType && /\bjson\b/i.test(contentType);
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? "";
  const doFetch = (...args: Parameters<typeof fetch>) => (options.fetch ?? globalThis.fetch)(...args);

  function url<Id extends RouteId>(id: Id, opts: Pick<CallOptions<Id>, "params" | "query"> = {}): string {
    const route = ROUTES[id];
    const params = (opts.params ?? {}) as Record<string, string | number>;
    const query = (opts.query ?? {}) as Record<string, QueryValue>;
    return `${baseUrl}${buildPath(route, params, query)}`;
  }

  async function call<Id extends RouteId>(id: Id, opts: CallOptions<Id> = {}): Promise<ResponseOf<Id>> {
    const route: Routes[RouteId] = ROUTES[id];
    if (!API_MOUNTS.has(route.mount)) throw new Error(`${id} is not a JSON API route`);

    let payload: unknown = undefined;
    if (opts.body !== undefined) {
      const sensitive = findSensitiveKeys(opts.body);
      if (sensitive.length > 0) {
        throw new ApiError("sensitive_blocked", "Status and identity answers stay on this device.", { paths: sensitive });
      }
      const schema = "body" in route ? (route.body as z.ZodTypeAny) : null;
      if (schema) {
        const parsed = schema.safeParse(opts.body);
        if (!parsed.success) {
          throw new ApiError("invalid_request", `Request for ${id} did not match its schema`, {
            paths: parsed.error.issues.map((i) => i.path.join(".") || "(root)"),
          });
        }
        payload = parsed.data;
      } else {
        payload = opts.body;
      }
    }

    let res: Response;
    try {
      res = await doFetch(url(id, opts), {
        method: route.method === "ALL" ? "GET" : route.method,
        headers: payload === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        credentials: "same-origin",
        signal: opts.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new ApiError("network", "Could not reach Novus. Check your connection and try again.");
    }

    if (res.status === 204) return undefined as ResponseOf<Id>;
    const contentType = res.headers.get("content-type");
    if (!isJsonContentType(contentType)) {
      if (res.ok && !("response" in route)) return undefined as ResponseOf<Id>;
      throw new ApiError("not_api", `Expected JSON from ${id}, got ${contentType ?? "no content type"}`, { status: res.status });
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiError("invalid_response", `Malformed JSON from ${id}`, { status: res.status });
    }

    if (!res.ok) {
      const problem = ProblemDetailsSchema.safeParse(json);
      if (problem.success) throw new ApiError("problem", problem.data.title, { status: res.status, problem: problem.data });
      throw new ApiError("invalid_response", `Request failed with ${res.status}`, { status: res.status });
    }

    if ("response" in route && route.response) {
      const parsed = (route.response as z.ZodTypeAny).safeParse(json);
      if (!parsed.success) {
        throw new ApiError("invalid_response", `Response from ${id} did not match the contract`, {
          status: res.status,
          paths: parsed.error.issues.map((i) => i.path.join(".") || "(root)"),
        });
      }
      return parsed.data as ResponseOf<Id>;
    }
    return json as ResponseOf<Id>;
  }

  return { call, url };
}

/** The shared client for the app. */
export const api = createApiClient();

/** A short, student-facing sentence for an error (never echoes request values). */
export function describeApiError(err: unknown): string {
  if (!isApiError(err)) return "Something went wrong. Try again.";
  switch (err.kind) {
    case "network":
      return "You seem to be offline. Check your connection and try again.";
    case "sensitive_blocked":
      return "That answer stays on this device, so Novus did not send it.";
    case "invalid_request":
      return "Some fields need another look before this can be saved.";
    case "problem":
      if (err.code === "unauthenticated") return "Sign in to see this.";
      if (err.code === "rate_limited") return "Too many requests just now. Wait a minute and try again.";
      if (err.code === "version_conflict") return "This changed somewhere else. Reload and try again.";
      return err.problem?.detail ?? err.problem?.title ?? "Something went wrong. Try again.";
    default:
      return "Novus could not load this right now. Try again soon.";
  }
}
