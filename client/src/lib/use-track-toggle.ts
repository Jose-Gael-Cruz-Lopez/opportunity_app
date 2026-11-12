import { useCallback } from "react";
import { useLocation } from "wouter";
import type { ProgramCard } from "@shared/contracts/registry";
import { useToast } from "@/hooks/use-toast";
import { describeApiError, isApiError } from "@/lib/api";
import { useSession, useTrackProgram, useTracker, useUntrackProgram } from "@/lib/queries";
import { appPaths, signInThenReturn } from "@/lib/routes";

/**
 * Track / stop tracking from a card. Signed-out students go to onboarding. Programs defined by
 * status or identity answer 409 consent_required; the program page asks for that consent, so
 * the card sends the student there instead of tracking silently.
 */
export function useTrackToggle() {
  const session = useSession();
  const tracker = useTracker();
  const track = useTrackProgram();
  const untrack = useUntrackProgram();
  const { toast } = useToast();
  const [location, navigate] = useLocation();
  const signedIn = !!session.data?.data.user;
  const items = tracker.data?.data ?? [];

  const trackedItem = useCallback((card: ProgramCard) => items.find((t) => t.programCycleId === card.programCycleId), [items]);

  const toggle = useCallback(
    (card: ProgramCard) => {
      if (!signedIn) {
        // Tracking needs an account: sign in (an emailed code also creates one), then come back.
        navigate(signInThenReturn(location));
        return;
      }
      const existing = trackedItem(card);
      if (existing) {
        untrack.mutate(existing, { onError: (err) => toast({ title: "Could not update your tracker", description: describeApiError(err) }) });
        return;
      }
      track.mutate(
        { card },
        {
          onSuccess: () => toast({ title: "Tracking", description: `${card.name} is in your tracker.` }),
          onError: (err) => {
            if (isApiError(err) && err.code === "consent_required") {
              toast({ title: "One more step", description: "This program asks about status or identity. Open it to track it with your OK." });
              navigate(appPaths.program(card.slug));
              return;
            }
            toast({ title: "Could not track this program", description: describeApiError(err) });
          },
        },
      );
    },
    [location, navigate, signedIn, toast, track, trackedItem, untrack],
  );

  return {
    isTracked: (card: ProgramCard) => !!trackedItem(card),
    toggle,
    busy: track.isPending || untrack.isPending,
    signedIn,
  };
}
