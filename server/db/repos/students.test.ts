import { beforeEach, describe, expect, it } from "vitest";
import { StudentProfileSchema, TrackerItemSchema } from "../../../shared/contracts/student";
import { createUser, seededDb, type TestDb } from "../testing/fixtures";
import { sampleIds, type SampleSeed } from "../seed/build";
import * as students from "./students";

const NOW = Date.parse("2026-11-11T15:00:00Z");

describe("roadmap action reducer", () => {
  it("applies pin, dismiss, complete and their inverses", () => {
    const open = { pinned: false, state: "open" as const };
    expect(students.applyRoadmapAction(open, "pin")).toEqual({ pinned: true, state: "open" });
    expect(students.applyRoadmapAction({ pinned: true, state: "open" }, "dismiss")).toEqual({ pinned: false, state: "dismissed" });
    expect(students.applyRoadmapAction({ pinned: false, state: "dismissed" }, "restore")).toEqual(open);
    expect(students.applyRoadmapAction(open, "complete").state).toBe("done");
    expect(students.applyRoadmapAction({ pinned: true, state: "done" }, "reopen")).toEqual({ pinned: true, state: "open" });
  });
});

describe("student repositories", () => {
  let t: TestDb & { seed: SampleSeed };
  let userId: string;
  beforeEach(async () => {
    t = await seededDb();
    userId = await createUser(t.db);
  });

  it("creates and patches a profile; refuses status or identity keys", async () => {
    const created = await students.updateProfile(t.db, userId, { classYear: "first_year", majorCip: "11.0701", interestTags: ["data"] }, NOW);
    expect(created.ok).toBe(true);
    const patched = await students.updateProfile(t.db, userId, { gpaBand: "3_5_to_3_74" }, NOW + 1);
    expect(patched.ok && patched.value).toMatchObject({ classYear: "first_year", gpaBand: "3_5_to_3_74", interestTags: ["data"] });
    expect(patched.ok && StudentProfileSchema.safeParse(patched.value).success).toBe(true);
    expect((await students.getProfile(t.db, userId))?.version).toBe(2);
    for (const bad of [{ citizenship: "f1" }, { firstGeneration: "yes" }, { pellStatus: "recipient" }, { raceEthnicity: ["asian"] }]) {
      const r = await students.updateProfile(t.db, userId, bad as never, NOW);
      expect(r).toEqual({ ok: false, error: "invalid", detail: "sensitive_field_rejected" });
    }
  });

  it("tracks a cycle, guards concurrent edits and restores a removed item", async () => {
    const cycle = sampleIds.cycle("sample-summer-analytics-internship");
    const added = await students.addTrackerItem(t.db, userId, { programCycleId: cycle, status: "interested", nameInMessages: true }, NOW);
    expect(added.ok).toBe(true);
    const item = added.ok ? added.value : null;
    expect(item && TrackerItemSchema.safeParse(item).success).toBe(true);
    expect(item?.programSlug).toBe("sample-summer-analytics-internship");

    const updated = await students.updateTrackerItem(t.db, userId, item!.id, { status: "applying", version: 1 }, NOW + 1);
    expect(updated.ok && updated.value.version).toBe(2);
    const stale = await students.updateTrackerItem(t.db, userId, item!.id, { status: "submitted", version: 1 }, NOW + 2);
    expect(stale).toMatchObject({ ok: false, error: "version_conflict" });

    const other = await createUser(t.db);
    expect(await students.updateTrackerItem(t.db, other, item!.id, { status: "submitted", version: 2 }, NOW)).toMatchObject({ ok: false, error: "not_found" });

    expect(await students.removeTrackerItem(t.db, userId, item!.id, NOW + 3)).toBe(true);
    expect(await students.listTrackerItems(t.db, userId)).toEqual([]);
    const readded = await students.addTrackerItem(t.db, userId, { programCycleId: cycle, status: "interested", nameInMessages: false }, NOW + 4);
    expect(readded.ok && readded.value.id).toBe(item!.id);
    expect(await students.listTrackerItems(t.db, userId)).toHaveLength(1);
  });

  it("needs consent to track a sensitive-audience program, and revocation deletes the linked rows", async () => {
    const cycle = sampleIds.cycle("sample-phd-pathway-program");
    const program = sampleIds.program("sample-phd-pathway-program");
    expect(await students.addTrackerItem(t.db, userId, { programCycleId: cycle, status: "interested", nameInMessages: false }, NOW)).toMatchObject({
      ok: false,
      error: "consent_required",
    });
    t.raw.exec("INSERT INTO consent_texts (version, kind, text_sha256, published_at) VALUES ('st-1', 'sensitive_tracking', 'x', 1)");
    expect((await students.changeConsent(t.db, userId, { kind: "sensitive_tracking", textVersion: "st-1", programId: program, granted: true }, NOW)).ok).toBe(true);
    expect((await students.addTrackerItem(t.db, userId, { programCycleId: cycle, status: "interested", nameInMessages: false }, NOW)).ok).toBe(true);
    const req = sampleIds.requirement("sample-phd-pathway-program", 0);
    expect((await students.setRequirementProgress(t.db, userId, { subjectKey: `req:${req}`, state: "in_progress" }, NOW)).ok).toBe(true);

    await students.changeConsent(t.db, userId, { kind: "sensitive_tracking", textVersion: "st-1", programId: program, granted: false }, NOW + 1);
    expect(await students.listTrackerItems(t.db, userId)).toEqual([]);
    expect(await students.listRequirementProgress(t.db, userId)).toEqual([]);
    expect((await students.listConsents(t.db, userId))[0]?.revokedAt).not.toBeNull();
  });

  it("records roadmap actions and visits", async () => {
    const program = sampleIds.program("sample-summer-analytics-internship");
    const r = await students.recordRoadmapAction(t.db, userId, "apply:x:summer-2027", "pin", program, NOW);
    expect(r).toEqual({ ok: true, value: { pinned: true, state: "open" } });
    await students.recordRoadmapAction(t.db, userId, "apply:x:summer-2027", "complete", program, NOW + 1);
    await students.saveRoadmapVisit(t.db, userId, ["apply:x:summer-2027"], null, NOW + 2);
    const state = await students.getRoadmapState(t.db, userId);
    expect(state.actions.get("apply:x:summer-2027")).toMatchObject({ pinned: true, state: "done" });
    expect(state.lastShownItemKeys).toEqual(["apply:x:summer-2027"]);
    // Roadmap actions on a sensitive-audience program are refused whatever the consents.
    const sensitive = sampleIds.program("sample-phd-pathway-program");
    expect(await students.recordRoadmapAction(t.db, userId, "apply:y:summer-2027", "pin", sensitive, NOW)).toMatchObject({ ok: false, error: "consent_required" });
  });

  it("refuses interest tags whose values state a status or identity (keys alone cannot catch them)", async () => {
    for (const tags of [["DACA recipient"], ["robotics", "first gen"], ["pell grant"], ["first-generation"]]) {
      const r = await students.updateProfile(t.db, userId, { interestTags: tags }, NOW);
      expect(r, tags.join(",")).toEqual({ ok: false, error: "invalid", detail: "sensitive_field_rejected" });
    }
    expect(t.raw.query("SELECT 1 FROM student_profiles WHERE user_id = ?", userId)).toEqual([]);
    expect(students.sensitiveTagValues(["robotics", "marine biology", "first gen"])).toEqual([2]);
    const fine = await students.updateProfile(t.db, userId, { interestTags: ["robotics", "marine biology"] }, NOW);
    expect(fine.ok).toBe(true);
  });

  it("roles default to student", async () => {
    expect(await students.getUserRoles(t.db, userId)).toEqual(["student"]);
    await students.grantRole(t.db, userId, "curator", NOW);
    await students.grantRole(t.db, userId, "curator", NOW);
    expect((await students.getUserRoles(t.db, userId)).sort()).toEqual(["curator", "student"]);
  });

  it("soft delete hides the account; purge removes every owned row", async () => {
    await students.updateProfile(t.db, userId, { classYear: "second_year" }, NOW);
    await students.addTrackerItem(t.db, userId, { programCycleId: sampleIds.cycle("sample-reu-site-ecology"), status: "interested", nameInMessages: true }, NOW);
    await students.softDeleteUser(t.db, userId, NOW);
    expect(await students.getUserById(t.db, userId)).toBeUndefined();
    expect((await students.usersPendingPurge(t.db, NOW)).map((u) => u.id)).toEqual([userId]);
    await students.purgeUser(t.db, userId);
    for (const table of ["users", "student_profiles", "tracker_items"]) {
      const col = table === "users" ? "id" : "user_id";
      expect(t.raw.query(`SELECT 1 FROM ${table} WHERE ${col} = ?`, userId)).toEqual([]);
    }
    expect(t.raw.query("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("purge also removes a staff user's second-factor rows (no cascades in the schema)", async () => {
    t.raw.query(
      "INSERT INTO staff_second_factors (user_id, secret_enc, recovery_code_hashes, created_at, updated_at) VALUES (?, 'enc', '[]', ?, ?)",
      userId,
      NOW,
      NOW,
    );
    t.raw.query(
      "INSERT INTO session_second_factors (session_id, user_id, method, verified_at, expires_at) VALUES ('s-1', ?, 'totp', ?, ?)",
      userId,
      NOW,
      NOW + 1000,
    );
    await students.purgeUser(t.db, userId);
    for (const table of ["staff_second_factors", "session_second_factors", "users"]) {
      const col = table === "users" ? "id" : "user_id";
      expect(t.raw.query(`SELECT 1 FROM ${table} WHERE ${col} = ?`, userId)).toEqual([]);
    }
  });
});
