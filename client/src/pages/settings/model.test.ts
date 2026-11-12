import { describe, expect, it } from "vitest";
import { CONSENT_KINDS, ConsentRecordSchema, findSensitiveKeys, type ConsentRecord } from "@shared/contracts";
import { PREFS_STORAGE_KEY } from "@/components/forms/prefs";
import { CONSENT_LABELS, DEVICE_STORAGE_KEYS, NEVER_COLLECTED, STAYS_ON_DEVICE, STORED_ON_NOVUS, activeConsents, deleteConfirmed } from "./model";
import { ONBOARDING_DRAFT_KEY } from "../onboarding/model";

const record = (over: Partial<ConsentRecord>): ConsentRecord =>
  ConsentRecordSchema.parse({
    kind: "analytics",
    textVersion: "v1",
    grantedAt: "2026-10-01T10:00:00Z",
    revokedAt: null,
    programId: null,
    ...over,
  });

describe("consents", () => {
  it("keeps the newest grant per kind and program and drops revoked ones", () => {
    const pid = "00000000-0000-4000-8000-000000000001";
    const rows = [
      record({ kind: "analytics", grantedAt: "2026-09-01T10:00:00Z", revokedAt: "2026-09-02T10:00:00Z" }),
      record({ kind: "analytics", grantedAt: "2026-10-01T10:00:00Z" }),
      record({ kind: "identity_tracking", programId: pid, revokedAt: "2026-10-02T10:00:00Z" }),
      record({ kind: "advisor_scope" }),
    ];
    expect(activeConsents(rows).map((r) => r.kind)).toEqual(["advisor_scope", "analytics"]);
  });

  it("has a label for every consent kind", () => {
    for (const kind of CONSENT_KINDS) expect(CONSENT_LABELS[kind].title.length).toBeGreaterThan(0);
  });
});

describe("deletion", () => {
  it("requires the confirm word", () => {
    expect(deleteConfirmed("DELETE")).toBe(true);
    expect(deleteConfirmed("  delete ")).toBe(true);
    expect(deleteConfirmed("delet")).toBe(false);
    expect(deleteConfirmed("")).toBe(false);
  });
});

describe("inventory", () => {
  it("lists private answers as device-only and never as stored", () => {
    expect(STAYS_ON_DEVICE.some((r) => /citizenship/.test(r.what))).toBe(true);
    expect(STORED_ON_NOVUS.some((r) => /citizenship|income|identity|first-generation/i.test(r.what))).toBe(false);
    expect(NEVER_COLLECTED.some((n) => /score or percentage/.test(n))).toBe(true);
  });

  it("resets exactly the storage keys this app writes", () => {
    expect(DEVICE_STORAGE_KEYS).toContain(PREFS_STORAGE_KEY);
    expect(DEVICE_STORAGE_KEYS).toContain(ONBOARDING_DRAFT_KEY);
    expect(findSensitiveKeys(Object.fromEntries(DEVICE_STORAGE_KEYS.map((k) => [k, 1])))).toEqual([]);
  });
});
