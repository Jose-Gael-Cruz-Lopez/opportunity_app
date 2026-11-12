/**
 * Client telemetry: allowlisted first-party events and content-free crash reports.
 * See docs/telemetry.md.
 */
export { track, trackOnboarding, setTelemetryConsent, blockTelemetryForUnderAge, reportBoundaryError, useGlobalErrorCapture, usePageViews } from "./react";
export { telemetry, browserEnv } from "./browser";
export { Telemetry, AGE_BLOCK_KEY, cleanProps, errorClassOf, firstPartyFrame, browserFamily, EVENTS_URL, ERRORS_URL, type ClientErrorReport, type TelemetryEnv, type TrackOptions } from "./telemetry";
export { resultBucket, EVENT_NAMES, type EventName, type EventPropsMap } from "./events";
export { routeTemplate } from "./route";
export { SESSION_KEY, SESSION_IDLE_MS } from "./session";
export { analyticsAllowedFor } from "./consent";
