import { useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CLEAR_PRIVATE_ANSWERS_EVENT } from "@/components/readiness/private-answers-store";
import { absoluteAppPath, appPaths } from "./routes";

/**
 * Signing out, built for the shared or library computer: end the server session (Better Auth,
 * allowlisted in server/auth/routes.ts), drop every cached response, clear private eligibility
 * answers held in memory, then reload the app so nothing from the last student stays in the tab.
 * The local clean-up runs even when the server cannot be reached.
 */

export const SIGN_OUT_PATH = "/api/auth/sign-out";

export type SignOutResult = { readonly ok: true } | { readonly ok: false; readonly reason: "unavailable" };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SignOutDeps {
  readonly fetcher?: FetchLike;
  /** Drops the TanStack Query cache. */
  readonly clearCache: () => void;
  /** Tells in-memory stores to forget private answers. */
  readonly clearPrivateAnswers: () => void;
  /** Leaves the page with a full load; only called after a successful sign-out. */
  readonly leave: (href: string) => void;
}

/** Where a signed-out student lands: the app's Home, freshly loaded. */
export const AFTER_SIGN_OUT_HREF = absoluteAppPath(appPaths.home);

/** 2xx ends the session; 401 means it had already ended. Anything else may still be live. */
function sessionEnded(status: number): boolean {
  return (status >= 200 && status < 300) || status === 401;
}

export async function signOut({ fetcher = (i, r) => fetch(i, r), clearCache, clearPrivateAnswers, leave }: SignOutDeps): Promise<SignOutResult> {
  let ended = false;
  try {
    const res = await fetcher(SIGN_OUT_PATH, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: "{}",
    });
    ended = sessionEnded(res.status);
  } catch {
    ended = false;
  }
  // Private answers and cached account data go either way: they are on this device, not the server.
  clearPrivateAnswers();
  clearCache();
  if (!ended) return { ok: false, reason: "unavailable" };
  leave(AFTER_SIGN_OUT_HREF);
  return { ok: true };
}

export const SIGN_OUT_FAILED_COPY = "Novus could not reach the server to end your session. This device's answers were cleared. Check your connection and try again.";

/** React wiring for the sign-out buttons (rail, phone account menu, Settings). */
export function useSignOut() {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = useCallback(async () => {
    setPending(true);
    setFailed(false);
    const result = await signOut({
      clearCache: () => qc.clear(),
      clearPrivateAnswers: () => window.dispatchEvent(new CustomEvent(CLEAR_PRIVATE_ANSWERS_EVENT)),
      leave: (href) => window.location.assign(href),
    });
    if (!result.ok) {
      setFailed(true);
      setPending(false);
    }
  }, [qc]);
  return { signOut: run, pending, failed };
}
