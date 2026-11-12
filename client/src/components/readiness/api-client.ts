/**
 * The Program, Readiness and Tracker screens' view of the shell's API client.
 *
 * JSON API calls go through client/src/lib/api.ts (route map, schema checks on both sides, the
 * sensitive-key guard). The sample-data rule is the shell's (lib/data-source.ts), so every page
 * in the app falls back to labelled fixtures under the same conditions and the shell's
 * "Sample data" label lights up whenever one does.
 *
 * Privacy: no function here accepts SensitiveAnswers. Bodies are typed by the route's schema, and
 * those schemas are `.strict()` and carry no status or identity field.
 */
import type { z } from "zod";
import { ProblemDetailsSchema } from "@shared/contracts/common";
import { buildPath, type RouteDef } from "@shared/contracts/routes";
import { ApiError, isApiError } from "@/lib/api";
import { DATA_MODE, isApiMissing, liveOrSample, type DataMode, type Sourced } from "@/lib/data-source";

export { ApiError };

/** True for failures that mean "no API here", as opposed to an API that answered with a problem. */
export function isApiUnavailable(err: unknown): boolean {
  return isApiMissing(err);
}

/** True when the API answered with a problem document of this HTTP status. */
export function isProblemStatus(err: unknown, status: number): boolean {
  return isApiError(err) && err.kind === "problem" && err.status === status;
}

export interface Loaded<T> {
  readonly data: T;
  /** True when the data is the labelled sample fixture, not the API's answer. */
  readonly sample: boolean;
}

export function toLoaded<T>(sourced: Sourced<T>): Loaded<T> {
  return { data: sourced.data, sample: sourced.source === "sample" };
}

/** Runs a loader under the shell's data mode and returns it in the `{ data, sample }` shape. */
export async function loadWithSample<T>(load: () => Promise<T>, sample: () => T, mode: DataMode = DATA_MODE): Promise<Loaded<T>> {
  return toLoaded(await liveOrSample(load, sample, mode));
}

/** True when this page load shows fixtures no matter what (`?sample=1` or VITE_NOVUS_DATA=fixtures). */
export function samplesForced(mode: DataMode = DATA_MODE): boolean {
  return mode === "fixtures";
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * GET for the static release files (mount "pages": /data/release.json and the immutable
 * client-core artifact). The shell's JSON client refuses non-API mounts on purpose, so these two
 * reads use this helper, which reports failures with the same ApiError kinds.
 */
export async function fetchReleaseFile<S extends z.ZodTypeAny | undefined = undefined>(
  route: RouteDef,
  opts: { params?: Record<string, string | number>; schema?: S; signal?: AbortSignal; fetcher?: FetchLike } = {},
): Promise<S extends z.ZodTypeAny ? z.output<S> : unknown> {
  type Out = S extends z.ZodTypeAny ? z.output<S> : unknown;
  const doFetch: FetchLike = opts.fetcher ?? ((i, r) => fetch(i, r));
  let res: Response;
  try {
    res = await doFetch(buildPath(route, opts.params ?? {}, {}), { method: "GET", credentials: "same-origin", headers: { accept: "application/json" }, signal: opts.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError("network", "Could not reach Novus.");
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!/\bjson\b/i.test(contentType)) throw new ApiError("not_api", `Expected JSON from ${route.path}`, { status: res.status });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError("invalid_response", `Malformed JSON from ${route.path}`, { status: res.status });
  }
  if (!res.ok) {
    const problem = ProblemDetailsSchema.safeParse(json);
    if (problem.success) throw new ApiError("problem", problem.data.title, { status: res.status, problem: problem.data });
    throw new ApiError("invalid_response", `Request failed with ${res.status}`, { status: res.status });
  }
  if (!opts.schema) return json as Out;
  const parsed = opts.schema.safeParse(json);
  if (!parsed.success) throw new ApiError("invalid_response", `Response from ${route.path} did not match its contract`, { status: res.status });
  return parsed.data as Out;
}
