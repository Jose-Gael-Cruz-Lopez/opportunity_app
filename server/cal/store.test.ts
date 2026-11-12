import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "@server/db/schema";
import { createCalendarFeed, rotateCalendarFeed } from "@server/db/repos/notifications";
import { addTrackerItem, changeConsent, updateProfile } from "@server/db/repos/students";
import { sampleIds } from "@server/db/seed/build";
import { createUser, seededDb } from "@server/db/testing/fixtures";
import { renderProgramFeed, renderUserFeed } from "./feeds";
import { createD1CalStore, feedAllows } from "./store";
import { calendarTokenHash } from "./token";

/** Integration: the D1 store against the committed migrations and the sample seed (all synthetic). */

const NOW = Date.parse("2026-11-11T15:00:00Z");
const ORIGIN = "https://novus.example.org";
const NAMED = "sample-reu-site-ecology";
const STATUS_DEFINED = "sample-phd-pathway-program";
const IDENTITY_DEFINED = "sample-women-in-computing-cohort";

describe("program feeds from D1", () => {
  it("renders a published program's national deadlines", async () => {
    const t = await seededDb();
    const store = createD1CalStore(t.db);
    const feed = await store.programFeed(NAMED, NOW);
    expect(feed?.kind).toBe("feed");
    if (feed?.kind !== "feed") return;
    expect(feed.groups.length).toBeGreaterThan(0);
    const body = renderProgramFeed(feed, ORIGIN);
    expect(body).toContain("Sample REU Site in Field Ecology");
    expect(body).toContain("Sample data\\, not a real program.");
    expect(body.match(/BEGIN:VEVENT/g)?.length).toBeGreaterThan(0);
  });

  it("returns null for unknown and unpublished programs, and a redirect for renamed slugs", async () => {
    const t = await seededDb();
    const store = createD1CalStore(t.db);
    expect(await store.programFeed("sample-does-not-exist", NOW)).toBeNull();

    await t.db.insert(s.slugRedirects).values({ fromSlug: "sample-old-reu-name", toProgramId: sampleIds.program(NAMED), createdAt: NOW });
    expect(await store.programFeed("sample-old-reu-name", NOW)).toEqual({ kind: "redirect", slug: NAMED });

    await t.db.update(s.programs).set({ isPublished: false }).where(eq(s.programs.id, sampleIds.program(NAMED)));
    expect(await store.programFeed(NAMED, NOW)).toBeNull();
  });
});

describe("per-user feeds from D1", () => {
  async function setup() {
    const t = await seededDb();
    const userId = await createUser(t.db);
    const token = "AbCdEfGhIjKlMnOpQrStUv";
    await createCalendarFeed(t.db, userId, await calendarTokenHash(token), false, NOW);
    return { t, userId, token, store: createD1CalStore(t.db) };
  }

  it("lists tracked deadlines for a live token and nothing for an unknown one", async () => {
    const { t, userId, token, store } = await setup();
    expect(await store.userFeed(await calendarTokenHash("unknown-token-value-0000"), NOW)).toBeNull();
    const empty = await store.userFeed(await calendarTokenHash(token), NOW);
    expect(empty).toEqual({ groups: [] });

    const added = await addTrackerItem(t.db, userId, { programCycleId: sampleIds.cycle(NAMED), status: "interested", nameInMessages: true }, NOW);
    expect(added.ok).toBe(true);
    const feed = await store.userFeed(await calendarTokenHash(token), NOW);
    expect(feed?.groups).toHaveLength(1);
    expect(feed?.groups[0]?.neutral).toBe(false);
    expect(renderUserFeed(feed!, ORIGIN)).toContain("Sample REU Site in Field Ecology");
  });

  it("stops working as soon as the token is rotated", async () => {
    const { t, userId, token, store } = await setup();
    await rotateCalendarFeed(t.db, userId, await calendarTokenHash("NewTokenNewTokenNewTok"), false, NOW + 1);
    expect(await store.userFeed(await calendarTokenHash(token), NOW)).toBeNull();
    expect(await store.userFeed(await calendarTokenHash("NewTokenNewTokenNewTok"), NOW)).toEqual({ groups: [] });
  });

  it("adds the student's own campus date", async () => {
    const { t, userId, token, store } = await setup();
    await addTrackerItem(t.db, userId, { programCycleId: sampleIds.cycle(NAMED), status: "applying", nameInMessages: true }, NOW);
    await t.db.update(s.trackerItems).set({ ownCampusDeadline: "2027-01-20" }).where(eq(s.trackerItems.userId, userId));
    const feed = await store.userFeed(await calendarTokenHash(token), NOW);
    expect(feed?.groups[0]?.ownCampus).toMatchObject({ date: "2027-01-20" });
    expect(renderUserFeed(feed!, ORIGIN)).toContain("your campus deadline");
    // Profiles never carry status answers; a plain institution update must still be accepted.
    expect((await updateProfile(t.db, userId, { classYear: "first_year" }, NOW)).ok).toBe(true);
  });

  it("writes neutral text for consented status- and identity-defined programs", async () => {
    const { t, userId, token, store } = await setup();
    t.raw.exec("INSERT INTO consent_texts (version, kind, text_sha256, published_at) VALUES ('st-1', 'sensitive_tracking', 'x', 1)");
    t.raw.exec("INSERT INTO consent_texts (version, kind, text_sha256, published_at) VALUES ('it-1', 'identity_tracking', 'x', 1)");
    expect((await changeConsent(t.db, userId, { kind: "sensitive_tracking", textVersion: "st-1", programId: sampleIds.program(STATUS_DEFINED), granted: true }, NOW)).ok).toBe(true);
    expect((await changeConsent(t.db, userId, { kind: "identity_tracking", textVersion: "it-1", programId: null, granted: true }, NOW)).ok).toBe(true);
    // nameInMessages true does not name a status-defined program; false keeps an identity one neutral.
    expect((await addTrackerItem(t.db, userId, { programCycleId: sampleIds.cycle(STATUS_DEFINED), status: "interested", nameInMessages: true }, NOW)).ok).toBe(true);
    expect((await addTrackerItem(t.db, userId, { programCycleId: sampleIds.cycle(IDENTITY_DEFINED), status: "interested", nameInMessages: false }, NOW)).ok).toBe(true);

    const feed = await store.userFeed(await calendarTokenHash(token), NOW);
    expect(feed?.groups).toHaveLength(2);
    expect(feed?.groups.every((g) => g.neutral)).toBe(true);
    const body = renderUserFeed(feed!, ORIGIN);
    for (const forbidden of ["PhD Pathway", "Women in Computing", STATUS_DEFINED, IDENTITY_DEFINED, "example.org/"]) {
      // The only example.org URL allowed is the Novus origin's tracker link.
      const text = body.replaceAll("https://novus.example.org/app/tracker", "");
      expect(text, forbidden).not.toContain(forbidden);
    }
    expect(body).toContain("Saved deadline");
  });

  it("refuses flagged programs without a live consent (defense in depth)", () => {
    const none = { sensitivePrograms: new Set<string>(), identity: false };
    expect(feedAllows({ id: "p", sensitiveAudience: false, identityAudience: [] }, none)).toBe(true);
    expect(feedAllows({ id: "p", sensitiveAudience: true, identityAudience: [] }, none)).toBe(false);
    expect(feedAllows({ id: "p", sensitiveAudience: true, identityAudience: [] }, { sensitivePrograms: new Set(["p"]), identity: false })).toBe(true);
    expect(feedAllows({ id: "p", sensitiveAudience: false, identityAudience: ["gender_identity"] }, none)).toBe(false);
    expect(feedAllows({ id: "p", sensitiveAudience: false, identityAudience: ["gender_identity"] }, { sensitivePrograms: new Set(), identity: true })).toBe(true);
    expect(feedAllows({ id: "p", sensitiveAudience: true, identityAudience: ["health"] }, { sensitivePrograms: new Set(["p"]), identity: true })).toBe(false);
  });
});
