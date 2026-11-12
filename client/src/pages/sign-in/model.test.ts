import { describe, expect, it } from "vitest";
import { findSensitiveKeys } from "@shared/contracts/sensitive";
import {
  describeOutcome,
  destinationAfterSignIn,
  fetchTurnstileConfig,
  isPlausibleEmail,
  nextFromSearch,
  normalizeCode,
  outcomeFor,
  safeNextPath,
  sendCode,
  SEND_CODE_PATH,
  TURNSTILE_CONFIG_PATH,
  turnstileMode,
  verifyCode,
  VERIFY_CODE_PATH,
  withTurnstileToken,
} from "./model";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("sign-in helpers", () => {
  it("accepts plausible emails only", () => {
    expect(isPlausibleEmail(" sam@example.org ")).toBe(true);
    expect(isPlausibleEmail("sam@example")).toBe(false);
    expect(isPlausibleEmail("sam example.org")).toBe(false);
    expect(isPlausibleEmail("")).toBe(false);
  });

  it("normalizes pasted codes to six digits", () => {
    expect(normalizeCode("123 456")).toBe("123456");
    expect(normalizeCode("12-34-56-78")).toBe("123456");
    expect(normalizeCode("abc")).toBe("");
  });

  it("allows only in-app next paths (no open redirect)", () => {
    expect(safeNextPath("/onboarding")).toBe("/onboarding");
    expect(safeNextPath("/programs/x?y=1")).toBe("/programs/x?y=1");
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("/sign-in")).toBe("/");
    expect(safeNextPath(null)).toBe("/");
    expect(nextFromSearch("?next=%2Ftracker")).toBe("/tracker");
    expect(nextFromSearch("")).toBe("/");
  });

  it("sends new accounts to /start, everyone else to the safe next path", () => {
    expect(destinationAfterSignIn("", false)).toBe("/start");
    expect(destinationAfterSignIn("?next=%2Ftracker", false)).toBe("/start");
    expect(destinationAfterSignIn("?next=%2Ftracker", true)).toBe("/tracker");
    expect(destinationAfterSignIn("?next=https%3A%2F%2Fevil.example", true)).toBe("/");
    // Session unreadable: never trap a returning student in onboarding.
    expect(destinationAfterSignIn("?next=%2Froadmap", null)).toBe("/roadmap");
    // A new account keeps the save intent of the guided flow, and nothing else.
    expect(destinationAfterSignIn("?next=%2Fstart%3Fsave%3D1", false)).toBe("/start?save=1");
    expect(destinationAfterSignIn("?next=%2Fstarter%3Fsave%3D1", false)).toBe("/start");
  });

  it("maps responses to outcomes a student can act on", async () => {
    expect(await outcomeFor(json(200, { success: true }))).toEqual({ ok: true });
    expect(await outcomeFor(json(429, {}))).toEqual({ ok: false, reason: "rate_limited" });
    expect(await outcomeFor(json(400, { code: "INVALID_OTP", message: "Invalid OTP" }))).toEqual({ ok: false, reason: "invalid_code" });
    expect(await outcomeFor(json(403, { type: "about:blank", title: "Forbidden", status: 403, code: "forbidden" }))).toEqual({ ok: false, reason: "rejected" });
    expect(await outcomeFor(new Response("<html>", { status: 404, headers: { "content-type": "text/html" } }))).toEqual({ ok: false, reason: "unavailable" });
    expect(await outcomeFor(json(503, {}))).toEqual({ ok: false, reason: "unavailable" });
    expect(describeOutcome({ ok: false, reason: "invalid_code" }, "code")).toMatch(/code/);
  });

  it("sends only the email and the code, to the allowlisted endpoints", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return json(200, { success: true });
    };
    await sendCode(" sam@example.org ", fetcher);
    await verifyCode("sam@example.org", "123 456", fetcher);
    expect(calls[0]).toEqual({ url: SEND_CODE_PATH, body: { email: "sam@example.org", type: "sign-in" } });
    expect(calls[1]).toEqual({ url: VERIFY_CODE_PATH, body: { email: "sam@example.org", otp: "123456" } });
    for (const c of calls) expect(findSensitiveKeys(c.body)).toEqual([]);
  });

  it("keeps the Origin header on sign-in posts whatever the page's referrer policy", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const fetcher = async (_url: string, init?: RequestInit) => {
      inits.push(init);
      return json(200, { success: true });
    };
    await sendCode("sam@example.org", fetcher);
    await verifyCode("sam@example.org", "123456", fetcher);
    for (const init of inits) expect(init?.referrerPolicy).toBe("same-origin");
  });

  it("reports a network failure as unavailable", async () => {
    const down = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await sendCode("sam@example.org", down)).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("Turnstile on the code send", () => {
  it("chooses no widget, the widget, or the unavailable notice from the server config", () => {
    expect(turnstileMode(null)).toBe("off");
    expect(turnstileMode({ enabled: false, siteKey: null, header: "x-novus-turnstile", action: "send-code" })).toBe("off");
    expect(turnstileMode({ enabled: true, siteKey: "site-key", header: "x-novus-turnstile", action: "send-code" })).toBe("widget");
    expect(turnstileMode({ enabled: true, siteKey: null, header: "x-novus-turnstile", action: "send-code" })).toBe("unavailable");
  });

  it("reads the config, and treats an unreadable answer as unknown (null)", async () => {
    const seen: string[] = [];
    const ok = await fetchTurnstileConfig(async (input) => {
      seen.push(input);
      return json(200, { enabled: true, siteKey: "k", header: "x-novus-turnstile", action: "send-code" });
    });
    expect(seen).toEqual([`${TURNSTILE_CONFIG_PATH}?action=send-code`]);
    expect(ok).toEqual({ enabled: true, siteKey: "k", header: "x-novus-turnstile", action: "send-code" });
    expect(await fetchTurnstileConfig(async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }))).toBeNull();
    expect(await fetchTurnstileConfig(async () => json(200, { enabled: "yes" }))).toBeNull();
    expect(await fetchTurnstileConfig(async () => json(200, { enabled: true, siteKey: "k", header: "Cookie", action: "send-code" }))).toBeNull();
    expect(
      await fetchTurnstileConfig(async () => {
        throw new TypeError("offline");
      }),
    ).toBeNull();
  });

  it("adds the token header to the code send only", async () => {
    const headers: Headers[] = [];
    const outcome = await sendCode(
      "sam@example.org",
      withTurnstileToken("x-novus-turnstile", "tok-1", async (_input, init) => {
        headers.push(new Headers(init?.headers));
        return json(200, { success: true });
      }),
    );
    expect(outcome).toEqual({ ok: true });
    expect(headers[0]?.get("x-novus-turnstile")).toBe("tok-1");
    expect(headers[0]?.get("content-type")).toBe("application/json");
  });
});
