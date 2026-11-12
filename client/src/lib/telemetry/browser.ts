import { Telemetry, type TelemetryEnv } from "./telemetry";

/**
 * The page's Telemetry instance, bound to the real browser. Created lazily so importing this
 * module has no side effect (tests, server rendering), and every browser API is guarded: a
 * blocked sessionStorage, a missing sendBeacon or an old engine only turn telemetry off.
 */

function sessionStore(): TelemetryEnv["storage"] {
  try {
    const s = window.sessionStorage;
    const probe = "nv.tprobe";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

function release(): string {
  const env = (import.meta as { env?: Record<string, unknown> }).env;
  const value = env?.VITE_RELEASE;
  return typeof value === "string" && value ? value : env?.DEV ? "dev" : "unknown";
}

export function browserEnv(): TelemetryEnv {
  return {
    now: () => Date.now(),
    storage: sessionStore(),
    random: (bytes) => window.crypto.getRandomValues(bytes),
    sendBeacon: typeof navigator.sendBeacon === "function" ? (url, data) => navigator.sendBeacon(url, data) : undefined,
    fetch: typeof window.fetch === "function" ? (url, init) => window.fetch(url, init) : undefined,
    gpc: () => (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true,
    pathname: () => window.location.pathname,
    origin: () => window.location.origin,
    userAgent: () => navigator.userAgent,
    release: release(),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (handle) => window.clearTimeout(handle as number),
  };
}

let instance: Telemetry | null = null;
let flushBound = false;

/** The shared instance, or null outside a browser (or where crypto is missing). */
export function telemetry(): Telemetry | null {
  if (instance) return instance;
  if (typeof window === "undefined" || typeof navigator === "undefined" || !window.crypto?.getRandomValues) return null;
  instance = new Telemetry(browserEnv());
  if (!flushBound) {
    flushBound = true;
    const flush = () => instance?.flush();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
    window.addEventListener("pagehide", flush);
  }
  return instance;
}
