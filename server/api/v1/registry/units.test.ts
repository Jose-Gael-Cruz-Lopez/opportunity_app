import { describe, expect, it } from "vitest";
import { DeadlineListQuerySchema, ProgramListQuerySchema } from "@shared/contracts/api";
import { CardCache } from "./cards";
import { decodeOffsetCursor, encodeOffsetCursor, filterListCards, openToTwoYear, paginate, upcomingDeadlines } from "./listing";
import { cardPlacement, placementAt, publicOrder } from "./order";
import { CARDS, card, deadline, memoryStore, TEST_NOW } from "./testing";

const DAY = 86_400_000;
const slugs = (cards: readonly { slug: string }[]) => cards.map((c) => c.slug);

describe("publicOrder", () => {
  it("puts open cycles first, by next deadline, nomination-gated cycles at E1, then expected and closed", () => {
    expect(slugs(publicOrder(CARDS, TEST_NOW))).toEqual([
      // E1 of a 29 Jan national deadline is 20 Nov, before the 25 Nov sprint.
      "sample-nominated-scholarship",
      "sample-soon-sprint",
      "sample-applicant-local-award",
      "sample-late-internship",
      "sample-expected-fellowship",
      "sample-closed-program",
    ]);
  });

  it("is the same whatever order the cards arrive in, with slug as the last tie-break", () => {
    const shuffled = [...CARDS].reverse();
    expect(slugs(publicOrder(shuffled, TEST_NOW))).toEqual(slugs(publicOrder(CARDS, TEST_NOW)));
    const twins = [card(50, { slug: "sample-b", name: "B", organizationName: "X" }), card(51, { slug: "sample-a", name: "A", organizationName: "X" })];
    expect(slugs(publicOrder(twins, TEST_NOW))).toEqual(["sample-a", "sample-b"]);
  });

  it("moves a nomination-gated deadline from E1 to E2 to national as each passes", () => {
    const national = Date.UTC(2027, 0, 29, 23);
    expect(placementAt(national, false, TEST_NOW)).toBe(national);
    expect(placementAt(national, true, TEST_NOW)).toBe(national - 70 * DAY);
    const afterE1 = national - 60 * DAY;
    expect(placementAt(national, true, afterE1)).toBe(national - 42 * DAY);
    const afterE2 = national - 10 * DAY;
    expect(placementAt(national, true, afterE2)).toBe(national);
  });

  it("ignores past and informational deadlines when placing a card", () => {
    const c = card(60, {
      slug: "sample-mixed",
      name: "Mixed",
      organizationName: "X",
      deadlines: [deadline({ date: "2026-10-01" }), deadline({ date: "2026-12-01", kind: "program_start" })],
    });
    expect(cardPlacement(c, TEST_NOW)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("list filters", () => {
  const parse = (q: Record<string, string | string[]>) => ProgramListQuerySchema.parse(q);

  it("filters by type, class year and status (comma lists and repeated params)", () => {
    expect(slugs(filterListCards(CARDS, parse({ type: "sprinternship,national_scholarship" }), TEST_NOW))).toEqual([
      "sample-soon-sprint",
      "sample-nominated-scholarship",
    ]);
    expect(slugs(filterListCards(CARDS, parse({ classYear: ["third_year"] }), TEST_NOW))).toContain("sample-nominated-scholarship");
    expect(slugs(filterListCards(CARDS, parse({ status: "closed" }), TEST_NOW))).toEqual(["sample-closed-program"]);
  });

  it("treats a card without verified rules as open to two-year students (unknown is never a no)", () => {
    expect(openToTwoYear({ ...CARDS[0]!, rules: null }, "2026-11-11")).toBe(true);
    expect(slugs(filterListCards(CARDS, parse({ openToCommunityCollege: "true" }), TEST_NOW))).toHaveLength(CARDS.length);
    expect(filterListCards(CARDS, parse({ openToCommunityCollege: "false" }), TEST_NOW)).toEqual([]);
  });
});

describe("cursors and pages", () => {
  it("round-trips offsets and rejects malformed cursors", () => {
    expect(decodeOffsetCursor(undefined)).toBe(0);
    expect(decodeOffsetCursor(encodeOffsetCursor(25, 7))).toBe(25);
    expect(decodeOffsetCursor("not-a-cursor")).toBeNull();
    expect(decodeOffsetCursor(btoa(JSON.stringify([-1, "r1"])))).toBeNull();
    expect(decodeOffsetCursor(btoa(JSON.stringify(["x", "r1"])))).toBeNull();
  });

  it("returns a next cursor only when more items remain", () => {
    const all = [1, 2, 3, 4, 5];
    const first = paginate(all, 0, 2, 7);
    expect(first.items).toEqual([1, 2]);
    expect(decodeOffsetCursor(first.page.nextCursor ?? undefined)).toBe(2);
    expect(paginate(all, 4, 2, 7).page.nextCursor).toBeNull();
  });
});

describe("upcomingDeadlines", () => {
  const parse = (q: Record<string, string>) => DeadlineListQuerySchema.parse(q);

  it("lists national submission deadlines inside the window, nomination-gated ones at E1", () => {
    const items = upcomingDeadlines(publicOrder(CARDS, TEST_NOW), parse({ withinDays: "30" }), TEST_NOW);
    expect(items.map((i) => i.programSlug)).toEqual(["sample-nominated-scholarship", "sample-soon-sprint", "sample-applicant-local-award"]);
    const nominated = items[0]!;
    expect(nominated.nominationRequired).toBe(true);
    // The item keeps its real national instant; only its place in the list moves.
    expect(nominated.sortAt).toBe("2027-01-29T23:00:00.000Z");
    const local = items.find((i) => i.programSlug === "sample-applicant-local-award")!;
    expect(local.applicantLocal).toBe(true);
    expect(local.timeZone).toBeNull();
  });

  it("excludes informational dates, past deadlines and campus scope", () => {
    const year = upcomingDeadlines(CARDS, parse({ withinDays: "365" }), TEST_NOW);
    expect(year.some((i) => i.kind === "program_start")).toBe(false);
    expect(year.some((i) => i.programSlug === "sample-closed-program")).toBe(false);
    expect(upcomingDeadlines(CARDS, parse({ scope: "campus" }), TEST_NOW)).toEqual([]);
  });

  it("filters by type and class year", () => {
    const items = upcomingDeadlines(CARDS, parse({ withinDays: "365", type: "sprinternship" }), TEST_NOW);
    expect(items.map((i) => i.programSlug)).toEqual(["sample-soon-sprint"]);
  });
});

describe("CardCache", () => {
  it("reuses the set within the check window and reloads on a new release", async () => {
    let release = 1;
    const store = memoryStore({
      async currentRelease() {
        store.calls.push("currentRelease");
        return release;
      },
    });
    const cache = new CardCache({ checkMs: 60_000, maxAgeMs: 300_000 });
    const a = await cache.get(store, TEST_NOW);
    const b = await cache.get(store, TEST_NOW + 30_000);
    expect(b).toBe(a);
    expect(store.calls.filter((c) => c === "listCards")).toHaveLength(1);

    // Same release after the window: one release check, no reload.
    const c = await cache.get(store, TEST_NOW + 61_000);
    expect(c).toBe(a);
    expect(store.calls.filter((x) => x === "currentRelease")).toHaveLength(2);

    release = 2;
    const d = await cache.get(store, TEST_NOW + 130_000);
    expect(d.release).toBe(2);
    expect(store.calls.filter((x) => x === "listCards")).toHaveLength(2);
  });

  it("shares one reload between concurrent requests and builds the index lazily", async () => {
    const store = memoryStore();
    const cache = new CardCache();
    const [a, b] = await Promise.all([cache.get(store, TEST_NOW), cache.get(store, TEST_NOW)]);
    expect(a).toBe(b);
    expect(store.calls.filter((x) => x === "listCards")).toHaveLength(1);
    expect(a.index()).toBe(a.index());
    expect(a.index().cards.size).toBe(CARDS.length);
  });
});
