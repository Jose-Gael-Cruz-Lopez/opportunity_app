import { describe, expect, it } from "vitest";
import { activeNavId, NAV_ITEMS, visibleNavItems } from "./nav";
import { tintForTypes } from "./ProgramArt";

describe("navigation", () => {
  it("highlights exactly one item per location", () => {
    expect(activeNavId("/")).toBe("home");
    expect(activeNavId("/explore?q=lab")).toBe("explore");
    expect(activeNavId("/programs/some-slug")).toBe("explore");
    expect(activeNavId("/readiness/some-slug")).toBe("explore");
    expect(activeNavId("/tracker")).toBe("tracker");
    expect(activeNavId("/settings/privacy")).toBe("settings");
    expect(activeNavId("/notifications")).toBe("notifications");
    expect(activeNavId("/trackers")).toBeNull();
  });

  it("shows the advisor item only to advisors and admins", () => {
    expect(visibleNavItems(["student"]).some((i) => i.id === "advisor")).toBe(false);
    expect(visibleNavItems(["advisor"]).some((i) => i.id === "advisor")).toBe(true);
    expect(visibleNavItems(undefined).some((i) => i.id === "advisor")).toBe(false);
  });

  it("keeps the phone tab bar to five items", () => {
    expect(NAV_ITEMS.filter((i) => i.inTabBar)).toHaveLength(5);
  });

  it("tints card art by opportunity family", () => {
    expect(tintForTypes(["research_program"])).toBe("sky");
    expect(tintForTypes(["unknown"])).toBe("clay");
  });
});
