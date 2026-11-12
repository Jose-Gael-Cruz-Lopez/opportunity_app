import { describe, expect, it } from "vitest";
import { deviceClass, scrubSessionDevice, truncateIp } from "./privacy";
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  hotp,
  normalizeRecoveryCode,
  otpauthUri,
  totpAt,
  verifyTotp,
} from "./totp";
import { decryptString, encryptString } from "./crypto";
import { grantFromRow, grantsFromRows, rolesOf } from "./grants";
import { consoleOriginFor, surfaceForUrl } from "./config";
import { toBrowserSessionCookie, readCookie } from "./http";
import { lockoutMs, BASE_LOCKOUT_MS, MAX_LOCKOUT_MS } from "./second-factor";
import { renderSignInCode, mailerFromEnv } from "./mailer";

describe("truncateIp", () => {
  it.each([
    ["203.0.113.77", "203.0.113.0/24"],
    [" 10.1.2.3 ", "10.1.2.0/24"],
    ["::ffff:198.51.100.4", "198.51.100.0/24"],
    ["2001:db8:85a3:8d3:1319:8a2e:370:7348", "2001:db8:85a3::/48"],
    ["2001:db8::1", "2001:db8:0::/48"],
    ["[2001:0db8:0001::1]", "2001:db8:1::/48"],
    ["::1", "0:0:0::/48"],
  ])("%s -> %s", (input, expected) => {
    expect(truncateIp(input)).toBe(expected);
  });

  it.each(["", "not-an-ip", "300.1.1.1", "1.2.3", "2001:db8:::1", null, undefined])("rejects %s", (input) => {
    expect(truncateIp(input)).toBeNull();
  });
});

describe("deviceClass", () => {
  it.each([
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148", "phone"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130 Mobile Safari/537.36", "phone"],
    ["Mozilla/5.0 (Linux; Android 13; SM-X200) Chrome/130 Safari/537.36", "tablet"],
    ["Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", "tablet"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15", "desktop"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130", "desktop"],
    ["curl/8.4.0", "bot"],
    ["Googlebot/2.1", "bot"],
    ["", "unknown"],
  ])("%s -> %s", (ua, expected) => {
    expect(deviceClass(ua)).toBe(expected);
  });

  it("scrubs a session row and is idempotent", () => {
    const row = { ipAddress: "203.0.113.77", userAgent: "Mozilla/5.0 (iPhone)", userId: "u" };
    const once = scrubSessionDevice(row);
    expect(once).toEqual({ ipAddress: "203.0.113.0/24", userAgent: "phone", userId: "u" });
    expect(scrubSessionDevice(once)).toEqual(once);
    const bare: { userId: string; ipAddress?: string | null } = { userId: "u" };
    expect(scrubSessionDevice(bare)).toEqual({ userId: "u" });
  });
});

describe("TOTP (RFC 6238 appendix B, SHA-1)", () => {
  const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));

  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("t=%i gives %s", async (seconds, expected) => {
    expect(await hotp(base32Decode(secret), Math.floor(seconds / 30), 8)).toBe(expected);
    expect(await totpAt(secret, seconds * 1000)).toBe(expected.slice(2));
  });

  it("round-trips base32", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255, 7]);
    expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
    expect(base32Encode(new TextEncoder().encode("foobar"))).toBe("MZXW6YTBOI");
  });

  it("accepts one step of drift and refuses replays", async () => {
    const now = 1_800_000_000_000;
    const previous = await totpAt(secret, now - 30_000);
    const first = await verifyTotp(secret, previous, now);
    expect(first.ok).toBe(true);
    const step = first.ok ? first.step : -1;
    expect(await verifyTotp(secret, previous, now, step)).toEqual({ ok: false });
    expect((await verifyTotp(secret, await totpAt(secret, now - 90_000), now)).ok).toBe(false);
    expect((await verifyTotp(secret, "12345", now)).ok).toBe(false);
    expect((await verifyTotp(secret, "abcdef", now)).ok).toBe(false);
  });

  it("builds an otpauth URI", () => {
    const uri = otpauthUri("Novus", "curator@example.org", "JBSWY3DPEHPK3PXP");
    expect(uri).toMatch(/^otpauth:\/\/totp\/Novus%3Acurator%40example\.org\?/);
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain("issuer=Novus");
  });
});

describe("recovery codes", () => {
  it("are ten unique, readable codes", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
  });

  it("normalize case and separators", () => {
    expect(normalizeRecoveryCode("ABCDE FGHJK")).toBe(normalizeRecoveryCode("abcde-fghjk"));
  });
});

describe("secret sealing", () => {
  it("round-trips and binds the purpose", async () => {
    const sealed = await encryptString("k".repeat(40), "a", "JBSWY3DPEHPK3PXP");
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(await decryptString("k".repeat(40), "a", sealed)).toBe("JBSWY3DPEHPK3PXP");
    await expect(decryptString("k".repeat(40), "b", sealed)).rejects.toThrow();
    await expect(decryptString("j".repeat(40), "a", sealed)).rejects.toThrow();
  });
});

describe("lockout", () => {
  it("starts at 5 failures and doubles per block, capped at 24 hours", () => {
    expect(lockoutMs(4)).toBe(0);
    expect(lockoutMs(5)).toBe(BASE_LOCKOUT_MS);
    expect(lockoutMs(9)).toBe(BASE_LOCKOUT_MS);
    expect(lockoutMs(10)).toBe(2 * BASE_LOCKOUT_MS);
    expect(lockoutMs(200)).toBe(MAX_LOCKOUT_MS);
  });
});

describe("grants", () => {
  it("maps rows to scoped grants and drops nonsense rows", () => {
    expect(grantFromRow({ role: "curator", workspaceId: null, organizationId: null })).toEqual({ role: "curator", scope: { kind: "global" } });
    expect(grantFromRow({ role: "advisor", workspaceId: "w1", organizationId: null })).toEqual({
      role: "advisor",
      scope: { kind: "workspace", workspaceId: "w1", level: "advisor" },
    });
    expect(grantFromRow({ role: "sponsor_admin", workspaceId: null, organizationId: "o1" })?.scope).toEqual({
      kind: "organization",
      organizationId: "o1",
      level: "sponsor_admin",
    });
    expect(grantFromRow({ role: "admin", workspaceId: "w1", organizationId: null })).toBeNull();
    expect(grantFromRow({ role: "superuser", workspaceId: null, organizationId: null })).toBeNull();
    expect(grantFromRow({ role: "advisor", workspaceId: "w1", organizationId: "o1" })).toBeNull();
  });

  it("always includes student and de-duplicates", () => {
    const grants = grantsFromRows([
      { role: "curator", workspaceId: null, organizationId: null },
      { role: "curator", workspaceId: null, organizationId: null },
    ]);
    expect(grants).toHaveLength(2);
    expect(rolesOf(grants)).toEqual(["student", "curator"]);
    expect(rolesOf(grantsFromRows([]))).toEqual(["student"]);
  });
});

describe("surfaces and cookies", () => {
  it("derives the console origin", () => {
    expect(consoleOriginFor("https://novus.example.org")).toBe("https://curate.novus.example.org");
    expect(consoleOriginFor("https://www.novus.example.org")).toBe("https://curate.novus.example.org");
    expect(consoleOriginFor("http://localhost:8787")).toBe("http://curate.localhost:8787");
    expect(surfaceForUrl("https://curate.novus.example.org/api/auth/sign-out")).toBe("console");
    expect(surfaceForUrl("https://novus.example.org/api/auth/sign-out")).toBe("app");
  });

  it("makes a browser-session cookie but leaves deletions alone", () => {
    const v = "__Host-novus.session=abc; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=Wed, 01 Jan 2027 00:00:00 GMT";
    expect(toBrowserSessionCookie(v)).toBe("__Host-novus.session=abc; Path=/; HttpOnly; Secure; SameSite=Lax");
    const del = "__Host-novus.session=; Max-Age=0; Path=/";
    expect(toBrowserSessionCookie(del)).toBe(del);
  });

  it("reads one cookie", () => {
    expect(readCookie("a=1; __Host-novus.shared_device=1; b=2", "__Host-novus.shared_device")).toBe("1");
    expect(readCookie("a=1", "b")).toBeNull();
    expect(readCookie(null, "b")).toBeNull();
  });
});

describe("mailer", () => {
  it("renders a short plain-text code email", () => {
    const { subject, text } = renderSignInCode({ to: "a@example.org", code: "123456", expiresInMinutes: 10, purpose: "sign-in" });
    expect(subject).toBe("123456 is your Novus code");
    expect(text).toContain("expires in 10 minutes");
    expect(text).not.toMatch(/https?:\/\//);
  });

  it("refuses to send without a binding outside local", async () => {
    const env = { DB: {} as D1Database, APP_ORIGIN: "https://novus.example.org", BETTER_AUTH_SECRET: "x", ENVIRONMENT: "production" };
    await expect(mailerFromEnv(env).sendSignInCode({ to: "a@example.org", code: "1", expiresInMinutes: 10, purpose: "sign-in" })).rejects.toThrow();
  });

  it("uses the EMAIL binding when present", async () => {
    const sent: unknown[] = [];
    const EMAIL = { send: async (m: unknown) => (sent.push(m), { messageId: "x" }) } as unknown as SendEmail;
    const env = { DB: {} as D1Database, APP_ORIGIN: "https://novus.example.org", BETTER_AUTH_SECRET: "x", ENVIRONMENT: "production", EMAIL };
    await mailerFromEnv(env).sendSignInCode({ to: "a@example.org", code: "123456", expiresInMinutes: 10, purpose: "sign-in" });
    expect(sent).toEqual([expect.objectContaining({ to: "a@example.org", from: "Novus <no-reply@novus.example.org>" })]);
  });
});
