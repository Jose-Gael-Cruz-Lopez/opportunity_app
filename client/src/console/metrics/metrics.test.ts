import { beforeAll, describe, expect, it } from "vitest";
import * as React from "react";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ONBOARDING_FUNNEL } from "@shared/onboarding/analytics";
import { TRACKER_STATUSES } from "@shared/taxonomy";
// Test-only cross-check against the server's wire schema (vitest resolves @server).
import { AdminMetricsViewSchema } from "@server/api/v1/admin/metrics/schemas";
import { ConsoleError, type FetchLike } from "../api";
import { createMetricsApi, FUNNEL_STEPS, metricsPath, type AdminMetricsView } from "./api";
import { sampleMetricsView } from "./fixtures";
import { barPercent, countText, daysText, freshnessTone, HIDDEN_TEXT, ingestNotice, maxShown, rateText, retentionShade, STATUS_LABELS, STEP_LABELS, weekLabel } from "./model";

// vitest compiles TSX with the classic runtime; expose React before importing components.
let MetricsView: ComponentType<Record<string, unknown>>;
beforeAll(async () => {
  (globalThis as { React?: typeof React }).React = React;
  MetricsView = (await import("./MetricsPage")).MetricsView as unknown as ComponentType<Record<string, unknown>>;
});

const render = (data: AdminMetricsView) => renderToStaticMarkup(createElement(MetricsView, { data, days: 28, weeks: 4, onDays: () => {}, onWeeks: () => {} }));

describe("contract", () => {
  it("the fixture fits the server's wire schema", () => {
    expect(() => AdminMetricsViewSchema.parse(sampleMetricsView)).not.toThrow();
  });

  it("knows every funnel step and Tracker status the server sends", () => {
    expect([...FUNNEL_STEPS]).toEqual([...ONBOARDING_FUNNEL]);
    for (const step of ONBOARDING_FUNNEL) expect(STEP_LABELS[step]).toBeTruthy();
    for (const status of TRACKER_STATUSES) expect(STATUS_LABELS[status]).toBeTruthy();
  });
});

describe("api", () => {
  it("calls the admin route same-origin with the chosen window", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const ok: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(sampleMetricsView), { status: 200 });
    };
    const view = await createMetricsApi(ok).metrics(90, 12);
    expect(calls[0]!.url).toBe("/api/v1/admin/metrics?days=90&weeks=12");
    expect(calls[0]!.init!.credentials).toBe("same-origin");
    expect(view.k).toBe(5);
    expect(metricsPath(7, 4)).toBe("/api/v1/admin/metrics?days=7&weeks=4");
  });

  it("turns a 403 into a forbidden console error", async () => {
    const api = createMetricsApi(async () => new Response(JSON.stringify({ type: "/problems/forbidden", title: "Forbidden", status: 403, code: "forbidden" }), { status: 403 }));
    await expect(api.metrics(28, 8)).rejects.toMatchObject({ kind: "forbidden" });
    await expect(api.metrics(28, 8)).rejects.toBeInstanceOf(ConsoleError);
  });
});

describe("model", () => {
  it("formats counts, hidden cells and rates", () => {
    expect(countText({ n: 1234, hidden: false })).toBe("1,234");
    expect(countText({ n: 0, hidden: false })).toBe("0");
    expect(countText({ n: null, hidden: true })).toBe(HIDDEN_TEXT);
    expect(rateText(0.917)).toBe("92%");
    expect(rateText(null)).toBe("–");
    expect(daysText(9.5)).toBe("9.5 d");
    expect(daysText(20)).toBe("20 d");
    expect(daysText(null)).toBe("–");
    expect(weekLabel("2026-11-09")).toBe("Nov 9");
  });

  it("sizes bars against the largest shown count and never draws a hidden one", () => {
    const cells = [{ n: 40, hidden: false }, { n: null, hidden: true }, { n: 10, hidden: false }, { n: 0, hidden: false }];
    expect(maxShown(cells)).toBe(40);
    expect(cells.map((c) => barPercent(c, 40))).toEqual([100, 0, 25, 0]);
    expect(barPercent({ n: 1, hidden: false }, 10_000)).toBe(1);
  });

  it("shades retention in steps of ten and switches to dark text on light fills", () => {
    expect(retentionShade(null)).toBeNull();
    expect(retentionShade(1)).toEqual({ mix: 100, darkText: true });
    expect(retentionShade(0.55)).toEqual({ mix: 60, darkText: true });
    expect(retentionShade(0.3)).toEqual({ mix: 30, darkText: false });
    expect(retentionShade(0)).toEqual({ mix: 10, darkText: false });
  });

  it("judges freshness against the 14-day target", () => {
    expect(freshnessTone(9.5, 14)).toBe("good");
    expect(freshnessTone(14, 14)).toBe("late");
    expect(freshnessTone(null, 14)).toBe("none");
  });

  it("explains empty event sections", () => {
    expect(ingestNotice(sampleMetricsView)).toBeNull();
    const empty = ingestNotice({ ...sampleMetricsView, ingest: { ...sampleMetricsView.ingest, eventRows: 0 } });
    expect(empty).toMatch(/No analytics events are recorded yet/);
    // POST /api/v1/events is built; the copy must not say otherwise.
    expect(empty).not.toMatch(/not built/);
    expect(ingestNotice({ ...sampleMetricsView, ingest: { ...sampleMetricsView.ingest, eventsDb: "unbound" } })).toMatch(/not bound/);
  });
});

describe("MetricsView", () => {
  it("renders the four sections with labelled tables", () => {
    const html = render(sampleMetricsView);
    for (const heading of ["Activation funnel", "Retention by week", "Tracker and reminders", "Registry freshness"]) expect(html).toContain(heading);
    for (const step of ONBOARDING_FUNNEL) expect(html).toContain(STEP_LABELS[step]);
    expect(html).toContain("Resume read on device");
    expect(html).toContain("optional");
    // A hidden count says so in words, with an icon, never as a number.
    expect(html).toContain(HIDDEN_TEXT);
    expect(html).toContain('title="Hidden: fewer than 5 people"');
    // The running week is marked; the hidden cohort shows no rate.
    expect(html).toContain("30%*");
    expect(html).toContain('aria-pressed="true">28 days</button>');
  });

  it("labels sample freshness and leaves the curated slice honest when empty", () => {
    const html = render(sampleMetricsView);
    expect(html).toContain("Sample programs");
    expect(html).toContain("21 / 28");
    expect(html).toContain("0 / 0");
    expect(html).toContain("under 14 d target");
  });

  it("never renders a composite score or a percent-ready figure", () => {
    const html = render(sampleMetricsView);
    expect(html).not.toMatch(/score|% ready/i);
  });

  it("says retention is not measured instead of showing a table of zeros", () => {
    const html = render({ ...sampleMetricsView, retention: { measured: false, cohorts: [] } });
    expect(html).toContain("Retention by week");
    expect(html).toContain("Not measured.");
    expect(html).not.toContain("Weekly retention by first-active week");
  });

  it("shows the ingest notice when no events exist", () => {
    const html = render({ ...sampleMetricsView, ingest: { eventsDb: "ok", eventRows: 0, onboardingEventRows: 0, lastEventAt: null } });
    expect(html).toContain("No analytics events are recorded yet");
    expect(html).toContain("last event never");
  });
});
