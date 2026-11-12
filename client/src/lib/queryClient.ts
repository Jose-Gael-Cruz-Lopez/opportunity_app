import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "./api";

/**
 * One QueryClient for the app. Queries call the typed client in lib/api.ts through the hooks in
 * lib/queries.ts; there is no default queryFn, so every key has exactly one owner.
 */

/** Retry only what a retry can fix: network blips and 5xx. Never 4xx, never contract errors. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (!isApiError(error)) return false;
  if (error.kind === "network") return true;
  return error.kind === "problem" && error.status !== null && error.status >= 500;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: false,
        retry: shouldRetry,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export const queryClient = createQueryClient();
