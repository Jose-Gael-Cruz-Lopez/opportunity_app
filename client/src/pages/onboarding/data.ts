import { useMutation, useQueryClient } from "@tanstack/react-query";
import { callRoute, isApiUnreachable, isUnauthenticated, useAccountSession } from "@/components/forms/request";
import { ONBOARDING_DRAFT_KEY, buildProfileUpdate, parseDraft, type Draft } from "./model";

/** Onboarding data: the saved profile (to prefill) and the PATCH that saves the draft. */

export type SaveOutcome = "saved" | "signed_out" | "no_api";

export function readStoredDraft(): Draft {
  try {
    return parseDraft(window.localStorage.getItem(ONBOARDING_DRAFT_KEY));
  } catch {
    return parseDraft(null);
  }
}

export function storeDraft(draft: Draft | null): void {
  try {
    if (draft === null) window.localStorage.removeItem(ONBOARDING_DRAFT_KEY);
    else window.localStorage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Storage can be blocked (private windows); the flow still works for this visit.
  }
}

/** The saved profile, for prefill. Sample sessions never prefill the form. */
export function useSavedProfile() {
  const q = useAccountSession();
  return { profile: q.data?.session?.profile ?? null };
}

export function useSaveProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (draft: Draft): Promise<SaveOutcome> => {
      const body = buildProfileUpdate(draft);
      try {
        await callRoute("updateProfile", { body });
        return "saved";
      } catch (err) {
        if (isUnauthenticated(err)) return "signed_out";
        if (isApiUnreachable(err)) return "no_api";
        throw err;
      }
    },
    onSuccess: (outcome) => {
      if (outcome === "saved") void qc.invalidateQueries({ queryKey: ["me"] });
    },
  });
}
