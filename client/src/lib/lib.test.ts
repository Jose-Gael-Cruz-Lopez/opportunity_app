import { describe, expect, it } from "vitest";
import { InboxItemSchema } from "@shared/contracts/events";
import { ProgramCardSchema } from "@shared/contracts/registry";
import { RoadmapSchema } from "@shared/contracts/roadmap";
import { MeSessionResponseSchema, TrackerItemSchema } from "@shared/contracts/student";
import { findSensitiveKeys } from "@shared/contracts/sensitive";
import { ApiError } from "./api";
import { liveOrSample, isApiMissing, parseDataMode } from "./data-source";
import { cardStatus, compareBySoonest, countdownFor, nextDeadline } from "./deadlines";
import { eligibilityHint } from "./eligibility-hint";
import { sampleProgramCards } from "./fixtures/programs";
import { sampleInbox, sampleRoadmap, sampleSession, sampleTracker } from "./fixtures/student";
import { firstName, formatAgo, formatDay, formatLocalTime, formatMoney, formatShortDate, formatTermLabel, plural } from "./format";
import { applyRoadmapAction, fetchAllPrograms } from "./queries";
import { shouldRetry } from "./queryClient";
import { appPaths, bootRedirect, documentTitle, isBareRoute, mapLegacyHash, matchPageRoute, redirectFor, signInThenReturn } from "./routes";
import { nextFromSearch } from "@/pages/sign-in/model";
import { hasSaveIntent, SIGN_UP_HREF, withoutSaveIntent } from "@/components/start/done-step";
import { summarizeTracker } from "./tracker-summary";
import { whyShownLine, whyShownReasons } from "./why-shown";
import type { ApiClient } from "./api";

/** 10:00 in New York on Wednesday 11 Nov 2026. */
const NOW = Date.parse("2026-11-11T15:00:00Z");
const ZONE = "America/New_York";
const cards = sampleProgramCards(NOW);
const bySlug = (slug: string) => {
  const card = cards.find((c) => c.slug === slug);
  if (!card) throw new Error(`no sample ${slug}`);
  return card;
};

describe("fixtures", () => {
  it("match the contracts and are all labelled as samples", () => {
    for (const card of cards) {
      expect(ProgramCardSchema.safeParse(card).success, card.slug).toBe(true);
      expect(card.isSample).toBe(true);
      expect(card.officialUrl.startsWith("https://example.org/")).toBe(true);
    }
    for (const t of sampleTracker(NOW)) expect(TrackerItemSchema.safeParse(t).success).toBe(true);
    for (const i of sampleInbox(NOW)) expect(InboxItemSchema.safeParse(i).success).toBe(true);
    expect(RoadmapSchema.safeParse(sampleRoadmap(NOW)).success).toBe(true);
    expect(MeSessionResponseSchema.safeParse(sampleSession()).success).toBe(true);
  });

  it("carry no status or identity fields", () => {
    expect(findSensitiveKeys(sampleSession())).toEqual([]);
    expect(findSensitiveKeys(cards)).toEqual([]);
  });

  it("tracker rows point at sample cards", () => {
    const ids = new Set(cards.map((c) => c.programCycleId));
    for (const t of sampleTracker(NOW)) expect(ids.has(t.programCycleId)).toBe(true);
  });
});

describe("format", () => {
  it("formats calendar dates without slipping a day", () => {
    expect(formatDay("2026-12-04")).toBe("Fri, Dec 4");
    expect(formatShortDate("2026-12-04")).toBe("Dec 4");
    expect(formatShortDate("2027-03")).toBe("March 2027");
    expect(formatLocalTime("17:00")).toBe("5:00 PM");
    expect(formatLocalTime("00:30")).toBe("12:30 AM");
    expect(formatTermLabel("fall-2026")).toBe("Fall 2026");
  });

  it("formats relative times, money and plurals", () => {
    expect(formatAgo(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe("2d ago");
    expect(formatAgo(new Date(NOW - 60_000).toISOString(), NOW)).toBe("just now");
    expect(formatAgo(new Date(NOW - 9 * 86_400_000).toISOString(), NOW)).toBe("1w ago");
    expect(formatMoney(3200, "hour")).toBe("$32/hr");
    expect(formatMoney(750000, "total")).toBe("$7,500");
    expect(plural(1, "day")).toBe("1 day");
    expect(plural(3, "day")).toBe("3 days");
    expect(firstName("  Sam Rivera ")).toBe("Sam");
    expect(firstName(null)).toBeNull();
  });
});

describe("deadlines", () => {
  it("finds the next actionable deadline, preferring an earlier campus step", () => {
    const nominated = bySlug("sample-national-science-scholarship");
    const next = nextDeadline(nominated, NOW, ZONE);
    expect(next?.deadline.scope).toBe("campus");
    expect(next?.daysLeft).toBe(23);
  });

  it("labels status by tone and words", () => {
    expect(cardStatus(bySlug("sample-early-insight-week"), NOW, ZONE)).toMatchObject({ tone: "soon", label: "9 days left" });
    expect(cardStatus(bySlug("sample-coastal-research-scholars"), NOW, ZONE)).toMatchObject({ tone: "open", label: "78 days left" });
    expect(cardStatus(bySlug("sample-tech-apprenticeship"), NOW, ZONE)).toMatchObject({ tone: "open", label: "Rolling" });
    expect(cardStatus(bySlug("sample-summer-lab-research"), NOW, ZONE).label).toBe("Opens Dec 1");
    expect(cardStatus(bySlug("sample-venture-fellows"), NOW, ZONE)).toMatchObject({ tone: "off", label: "Closed" });
  });

  it("skips a deadline that passed earlier today", () => {
    const card = bySlug("sample-early-insight-week");
    const afterDue = Date.parse(card.deadlines[0]?.dueAt ?? "") + 60_000;
    expect(nextDeadline(card, afterDue, ZONE)).toBeNull();
  });

  it("sorts open-with-date, then rolling, then upcoming, then closed", () => {
    const sorted = [...cards].sort((a, b) => compareBySoonest(a, b, NOW, ZONE)).map((c) => c.status);
    const firstExpected = sorted.indexOf("expected");
    const firstClosed = sorted.indexOf("closed");
    expect(sorted.slice(0, firstExpected).every((s) => s === "open")).toBe(true);
    expect(firstClosed).toBe(sorted.length - 1);
  });

  it("places today inside the application window", () => {
    const c = countdownFor(bySlug("sample-coastal-research-scholars"), NOW, ZONE);
    expect(c).not.toBeNull();
    expect(c?.daysLeft).toBe(78);
    expect(c?.windowDays).toBe(83);
    expect(c?.progress).toBeCloseTo(5 / 83, 5);
    expect(c?.dueTime).toBe("17:00");
  });
});

describe("eligibility hint (non-sensitive only)", () => {
  const profile = { classYear: "second_year" as const, majorFamily: "agriculture_environment" as const };
  it("gives each case a word, never a number", () => {
    expect(eligibilityHint(bySlug("sample-conservation-crews"), profile).kind).toBe("open_to_you");
    expect(eligibilityHint(bySlug("sample-coastal-research-scholars"), profile).kind).toBe("check_privately");
    expect(eligibilityHint(bySlug("sample-software-sophomore-internship"), profile).kind).toBe("check_major");
    expect(eligibilityHint(bySlug("sample-case-competition"), profile).kind).toBe("not_your_year");
    expect(eligibilityHint(bySlug("sample-early-insight-week"), null).kind).toBe("unknown");
    for (const c of cards) expect(eligibilityHint(c, profile).label).not.toMatch(/\d/);
  });
});

describe("why shown", () => {
  const profile = { classYear: "second_year" as const, majorFamily: "agriculture_environment" as const, timeZone: ZONE };
  it("names the campus step and start-by date", () => {
    const codes = whyShownReasons(bySlug("sample-national-science-scholarship"), profile, NOW).map((r) => r.code);
    expect(codes).toContain("CAMPUS_DATE_FIRST");
    expect(codes).toContain("TIGHT_TIMELINE");
  });
  it("explains standing and field fit, and falls back to the summary", () => {
    const line = whyShownLine(bySlug("sample-conservation-crews"), profile, NOW);
    expect(line).toMatch(/second-year/);
    expect(whyShownLine(bySlug("sample-venture-fellows"), null, NOW)).toBe(bySlug("sample-venture-fellows").summary);
  });
  it("never contains a percentage", () => {
    for (const c of cards) expect(whyShownLine(c, profile, NOW)).not.toMatch(/%/);
  });
});

describe("tracker summary", () => {
  it("counts the student's own activity and finds the soonest countdown", () => {
    const s = summarizeTracker(cards, sampleTracker(NOW), NOW, ZONE);
    expect(s.tracked).toBe(5);
    expect(s.applying).toBe(2);
    expect(s.submitted).toBe(1);
    expect(s.dueSoon).toBe(2);
    expect(s.weeklyDue.reduce((a, b) => a + b, 0)).toBe(2);
    expect(s.nextUp?.card.slug).toBe("sample-software-sophomore-internship");
  });
});

describe("routes", () => {
  it("matches every page route", () => {
    expect(matchPageRoute("/")?.id).toBe("home");
    expect(matchPageRoute("/explore?q=x")?.id).toBe("explore");
    expect(matchPageRoute("/programs/abc-def")?.id).toBe("program");
    expect(matchPageRoute("/readiness/abc")?.id).toBe("readiness");
    expect(matchPageRoute("/settings")?.id).toBe("settings");
    expect(matchPageRoute("/settings/privacy")?.id).toBe("settings");
    expect(matchPageRoute("/advisor/lists/1")?.id).toBe("advisor");
    expect(matchPageRoute("/programs")).toBeNull();
    expect(matchPageRoute("/nope")).toBeNull();
    expect(isBareRoute("/onboarding/quiz")).toBe(true);
    // The old onboarding form redirects to the guided flow; nothing else redirects.
    expect(redirectFor("/onboarding")).toBe("/start");
    expect(redirectFor("/onboarding/quiz")).toBe("/start");
    expect(redirectFor("/start")).toBeNull();
    expect(redirectFor("/tracker")).toBeNull();
    expect(isBareRoute("/explore")).toBe(false);
    expect(documentTitle("/tracker")).toBe("Tracker · Novus");
  });

  it("maps old hash links and stray entry paths", () => {
    expect(mapLegacyHash("#/dashboard")).toBe("/explore");
    expect(mapLegacyHash("#/opportunity/3")).toBe("/explore");
    expect(mapLegacyHash("#section")).toBeNull();
    expect(bootRedirect("/", "#/roadmap")).toBe("/app/roadmap");
    expect(bootRedirect("/", "")).toBe("/app");
    expect(bootRedirect("/app/explore", "")).toBeNull();
    expect(bootRedirect("/app", "#main")).toBeNull();
  });
});

describe("data source", () => {
  it("parses the mode and only falls back when the API is missing", async () => {
    expect(parseDataMode("live")).toBe("live");
    expect(parseDataMode(undefined)).toBe("auto");
    expect(isApiMissing(new ApiError("not_api", "html"))).toBe(true);
    expect(isApiMissing(new ApiError("problem", "401", { status: 401 }))).toBe(false);

    const missing = () => Promise.reject(new ApiError("network", "offline"));
    await expect(liveOrSample(missing, () => 1, "auto")).resolves.toEqual({ data: 1, source: "sample" });
    await expect(liveOrSample(missing, () => 1, "live")).rejects.toBeInstanceOf(ApiError);
    await expect(liveOrSample(() => Promise.resolve(2), () => 1, "auto")).resolves.toEqual({ data: 2, source: "live" });
    await expect(liveOrSample(() => Promise.resolve(2), () => 1, "fixtures")).resolves.toEqual({ data: 1, source: "sample" });
    const denied = () => Promise.reject(new ApiError("problem", "Sign in", { status: 401 }));
    await expect(liveOrSample(denied, () => 1, "auto")).rejects.toBeInstanceOf(ApiError);
  });
});

describe("queries helpers", () => {
  it("retries only network errors and 5xx", () => {
    expect(shouldRetry(0, new ApiError("network", "x"))).toBe(true);
    expect(shouldRetry(0, new ApiError("problem", "x", { status: 503 }))).toBe(true);
    expect(shouldRetry(0, new ApiError("problem", "x", { status: 404 }))).toBe(false);
    expect(shouldRetry(2, new ApiError("network", "x"))).toBe(false);
    expect(shouldRetry(0, new Error("x"))).toBe(false);
  });

  it("applies roadmap actions immutably", () => {
    const plan = sampleRoadmap(NOW);
    const key = plan.terms[0]?.prepare[1]?.itemKey ?? "";
    const next = applyRoadmapAction(plan, key, "complete");
    expect(next.terms[0]?.prepare[1]?.state).toBe("done");
    expect(plan.terms[0]?.prepare[1]?.state).toBe("open");
    expect(applyRoadmapAction(next, key, "reopen").terms[0]?.prepare[1]?.state).toBe("open");
  });

  it("follows cursors when loading every program", async () => {
    const pages = [
      { items: cards.slice(0, 2), page: { nextCursor: "c2", limit: 100 }, release: 1 },
      { items: cards.slice(2, 3), page: { nextCursor: null, limit: 100 }, release: 1 },
    ];
    const seen: unknown[] = [];
    const client = {
      call: async (_id: string, opts: { query?: { cursor?: string } }) => {
        seen.push(opts.query?.cursor);
        return pages[seen.length - 1];
      },
      url: () => "",
    } as unknown as ApiClient;
    const all = await fetchAllPrograms(client);
    expect(all).toHaveLength(3);
    expect(seen).toEqual([undefined, "c2"]);
  });
});

describe("sign in, then return", () => {
  it("round-trips an in-app path through the sign-in page's next parameter", () => {
    for (const next of [appPaths.start, appPaths.tracker, appPaths.program("goldwater"), appPaths.readiness("pc_1", "goldwater")]) {
      const href = signInThenReturn(next);
      expect(href.startsWith(`${appPaths.signIn}?next=`)).toBe(true);
      expect(nextFromSearch(href.slice(href.indexOf("?")))).toBe(next);
    }
  });

  it("the /start sign-up link returns to /start with the save intent, not /app/app/start", () => {
    const next = nextFromSearch(SIGN_UP_HREF.slice(SIGN_UP_HREF.indexOf("?")));
    expect(next).toBe("/start?save=1");
    expect(hasSaveIntent(next.slice(next.indexOf("?")))).toBe(true);
  });

  it("reads and strips the save intent", () => {
    expect(hasSaveIntent("?save=1")).toBe(true);
    expect(hasSaveIntent("?save=0")).toBe(false);
    expect(hasSaveIntent("")).toBe(false);
    expect(withoutSaveIntent("?save=1")).toBe("");
    expect(withoutSaveIntent("?a=b&save=1")).toBe("?a=b");
  });
});
