import { useQuery } from "@tanstack/react-query";
import { ApiError, api, createApiClient, isApiError, type BodyOf, type CallOptions as ShellCallOptions, type ResponseOf } from "@/lib/api";
import type { Sourced } from "@/lib/data-source";
import { fetchSession, queryKeys } from "@/lib/queries";
import type { MeSessionResponse, RouteId } from "@shared/contracts";

/**
 * Thin adapter over the shell's API client (client/src/lib/api.ts) for the Roadmap, Ask, Settings
 * and Onboarding pages. The shell client validates bodies and responses against the route map and
 * refuses any body that carries a status or identity key; this file adds the two questions these
 * pages ask of an error: "is there an API at all?" and "is the student signed out?".
 */

export { ApiError };

export interface CallOptions<Id extends RouteId> {
  readonly params?: ShellCallOptions<Id>["params"];
  readonly query?: ShellCallOptions<Id>["query"];
  readonly body?: BodyOf<Id>;
  readonly signal?: AbortSignal;
  /** Injected in tests. */
  readonly fetchImpl?: typeof fetch;
}

export function callRoute<Id extends RouteId>(id: Id, options: CallOptions<Id> = {}): Promise<ResponseOf<Id>> {
  const client = options.fetchImpl ? createApiClient({ fetch: options.fetchImpl }) : api;
  const { fetchImpl: _ignored, ...rest } = options;
  return client.call(id, rest as ShellCallOptions<Id>);
}

/**
 * True when nothing that speaks the JSON API answered (offline, a dev server without the Worker,
 * a route not mounted yet), so a page may show its labelled sample data. A real API answer such
 * as 401 or 404 problem+json is never treated as missing.
 */
export function isApiUnreachable(err: unknown): boolean {
  return isApiError(err) && (err.kind === "network" || err.kind === "not_api");
}

export function isUnauthenticated(err: unknown): boolean {
  return isApiError(err) && err.status === 401;
}

/**
 * The signed-in account, read from the shell's shared session cache (lib/queries). Sample
 * sessions are never treated as an account: `session` is null and `sample` is true, so pages
 * can say "not connected" instead of offering account actions that would fail.
 */
export interface AccountSession {
  readonly session: MeSessionResponse | null;
  readonly sample: boolean;
}

export function toAccountSession(sourced: Sourced<MeSessionResponse>): AccountSession {
  return { session: sourced.source === "live" ? sourced.data : null, sample: sourced.source === "sample" };
}

export function useAccountSession() {
  return useQuery({ queryKey: queryKeys.session, queryFn: fetchSession, staleTime: 5 * 60_000, select: toAccountSession });
}
