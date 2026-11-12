import { describe, expect, it } from "vitest";
import type { InboxItem } from "@shared/contracts/events";
import { DEFAULT_SAMPLE_PREFS, sampleNotifications } from "./fixtures";
import { applyFilter, categoryOf, groupByAge, inAppPath, markAllNotice, markEachRead, prefsSummary, priorityLabel, unreadIds, withReadAt } from "./model";

const NOW = Date.UTC(2026, 10, 11, 18, 0);

describe("notification center model", () => {
  const items = sampleNotifications(NOW);

  it("labels sample items as sample data", () => {
    for (const i of items) expect(`${i.title} ${i.body}`).toMatch(/sample/i);
  });

  it("sorts types into reminders, changes and notices", () => {
    expect(categoryOf("deadline.reminder")).toBe("reminder");
    expect(categoryOf("cycle.predicted_soon")).toBe("reminder");
    expect(categoryOf("deadline.changed")).toBe("change");
    expect(categoryOf("eligibility.changed")).toBe("change");
    expect(categoryOf("contact.confirmation")).toBe("account");
  });

  it("filters by unread and category without reordering", () => {
    expect(applyFilter(items, "all").map((i) => i.id)).toEqual(items.map((i) => i.id));
    expect(applyFilter(items, "unread").every((i) => i.readAt === null)).toBe(true);
    expect(applyFilter(items, "reminders").every((i) => categoryOf(i.type) === "reminder")).toBe(true);
    expect(applyFilter(items, "changes").every((i) => categoryOf(i.type) === "change")).toBe(true);
    expect(unreadIds(items)).toHaveLength(2);
  });

  it("links only to known in-app routes", () => {
    expect(inAppPath("/programs/sample-x")).toBe("/programs/sample-x");
    expect(inAppPath("/app/tracker")).toBe("/tracker");
    expect(inAppPath("/app/settings/privacy")).toBe("/settings/privacy");
    expect(inAppPath("/e/rc/token")).toBeNull();
    expect(inAppPath("//evil.example")).toBeNull();
    expect(inAppPath("https://example.org")).toBeNull();
    expect(inAppPath("/trackerx")).toBeNull();
    expect(inAppPath("/programs/")).toBeNull();
    expect(inAppPath(null)).toBeNull();
  });

  it("groups by arrival in the viewer's zone", () => {
    const groups = groupByAge(items, NOW, "America/New_York");
    expect(groups.map((g) => g.group)).toEqual(["Today", "This week", "Earlier"]);
    expect(groups[0]!.items).toHaveLength(1);
    const bad = { ...items[0]!, createdAt: "not a date" } as InboxItem;
    expect(groupByAge([bad], NOW, "UTC")).toEqual([]);
  });

  it("labels only P0 items as urgent", () => {
    expect(priorityLabel({ priority: "p0" })).toBe("Urgent");
    expect(priorityLabel({ priority: "p1" })).toBeNull();
  });

  it("describes what Novus will send, in plain words and without numbers about the student", () => {
    const lines = prefsSummary(DEFAULT_SAMPLE_PREFS);
    expect(lines.join(" ")).toContain("Quiet hours: 10:00 PM to 8:00 AM");
    expect(lines.join(" ")).toContain("2 days before each deadline");
    expect(prefsSummary({ ...DEFAULT_SAMPLE_PREFS, weeklyDay: 3 }).join(" ")).toContain("Wednesdays at 6:00 PM");
    expect(prefsSummary({ ...DEFAULT_SAMPLE_PREFS, channels: { email: false, inApp: true, push: false } })).toEqual(["Email is off. Reminders and changes still appear here."]);
    expect(prefsSummary({ ...DEFAULT_SAMPLE_PREFS, examPauseUntil: "2026-12-15" }).join(" ")).toContain("Exam pause until 2026-12-15");
    expect(lines.join(" ")).not.toMatch(/%|score|match/i);
  });
});

describe("mark read, one and all", () => {
  const items = sampleNotifications(NOW);
  const unread = unreadIds(items);

  it("reports the real count once every request settles, and never rejects", async () => {
    const failOn = new Set([unread[0]!]);
    const result = await markEachRead(unread, async (id) => {
      if (failOn.has(id)) throw new Error("offline");
    });
    expect(result.failed).toEqual([unread[0]]);
    expect(result.done).toEqual(unread.slice(1));
    expect(markAllNotice(unread.length, result.failed.length)).toBe(`${unread.length - 1} of ${unread.length} marked read. Try again for the rest.`);
    expect(markAllNotice(4, 0)).toBe("4 notifications marked read.");
    expect(markAllNotice(1, 0)).toBe("1 notification marked read.");
    expect(markAllNotice(3, 3)).toBe("Could not mark your notifications read. Try again.");
  });

  it("undoes only the failed items, keeping reads the server accepted", () => {
    const pages = [{ items, nextCursor: null, sample: true }];
    const readAt = new Date(NOW).toISOString();
    const allRead = withReadAt(pages, new Set(unread), readAt);
    expect(unreadIds(allRead[0]!.items)).toEqual([]);
    const oneUndone = withReadAt(allRead, new Set([unread[0]!]), null);
    expect(unreadIds(oneUndone[0]!.items)).toEqual([unread[0]]);
    // Items that were already read before keep their own timestamp.
    const earlier = items.find((i) => i.readAt !== null);
    if (earlier) expect(oneUndone[0]!.items.find((i) => i.id === earlier.id)?.readAt).toBe(earlier.readAt);
  });
});
