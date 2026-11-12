import { useEffect, useRef, type ErrorInfo } from "react";
import { onboardingEvent, type OnboardingEventData } from "@shared/onboarding/analytics";
import type { EventName, EventPropsMap } from "./events";
import { telemetry } from "./browser";
import type { ErrorSurface, TrackOptions } from "./telemetry";

/**
 * React glue for telemetry. Nothing here reads component props, state or the error message:
 * reports carry the error class and a first-party file and line only.
 */

/** Sends one event; a no-op outside the browser, under GPC or without consent. */
export function track<N extends EventName>(name: N, props: EventPropsMap[N], options?: TrackOptions): void {
  telemetry()?.track(name, props, options);
}

/**
 * One onboarding funnel event, built by shared/onboarding's `onboardingEvent()` so the props are
 * exactly what the server's allowlist and the founders' funnel query expect. A value the
 * builder refuses (an unknown tier or step kind) sends nothing.
 */
export function trackOnboarding(data: OnboardingEventData): void {
  let props: EventPropsMap["onboarding_step"];
  try {
    props = onboardingEvent(data).props as EventPropsMap["onboarding_step"];
  } catch {
    return;
  }
  track("onboarding_step", props);
}

/** The app's analytics choice (false for analytics off or minor mode); drops anything queued. */
export function setTelemetryConsent(allowed: boolean): void {
  telemetry()?.setConsent(allowed);
}

/**
 * Onboarding's under-16 answer (plan 9.10.2): telemetry off for the rest of this tab, the queue
 * dropped and the session id and error counter forgotten. A later consent change cannot undo it.
 */
export function blockTelemetryForUnderAge(): void {
  telemetry()?.blockForUnderAge();
}

/**
 * For an error boundary's componentDidCatch. The component stack is accepted for the call
 * shape but never sent (it names components, and props can hold private answers).
 */
export function reportBoundaryError(error: unknown, _info?: ErrorInfo | { componentStack?: string | null }, surface: ErrorSurface = "spa"): void {
  telemetry()?.reportError(error, "boundary", surface);
}

/** Reports any error outside React's tree (`error`, `unhandledrejection`) while mounted. */
export function useGlobalErrorCapture(surface: ErrorSurface = "spa"): void {
  useEffect(() => {
    const onError = (ev: ErrorEvent) => telemetry()?.reportError(ev.error ?? { name: "ErrorEvent" }, "error", surface);
    const onRejection = (ev: PromiseRejectionEvent) => telemetry()?.reportError(ev.reason, "unhandledrejection", surface);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [surface]);
}

/** One `page_view` per route change, keyed on the router location (a route template is sent). */
export function usePageViews(location: string, surface: "app" | "console" = "app"): void {
  const last = useRef<string | null>(null);
  useEffect(() => {
    const path = location.split(/[?#]/)[0] ?? location;
    if (last.current === path) return;
    last.current = path;
    track("page_view", { surface });
  }, [location, surface]);
}
