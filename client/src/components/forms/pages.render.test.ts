import { beforeAll, describe, expect, it } from "vitest";
import * as React from "react";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

// vitest.config.ts compiles TSX with the classic runtime (React.createElement), while the Vite
// app uses the automatic one. Expose React globally and import the pages after that.
let RoadmapPage: ComponentType;
let AskPage: ComponentType;
let SettingsPage: ComponentType;
let OnboardingPage: ComponentType;
beforeAll(async () => {
  (globalThis as { React?: typeof React }).React = React;
  RoadmapPage = (await import("@/pages/roadmap/index")).default;
  AskPage = (await import("@/pages/ask/index")).default;
  SettingsPage = (await import("@/pages/settings/index")).default;
  OnboardingPage = (await import("@/pages/onboarding/index")).default;
});

/**
 * Smoke test: each page renders to HTML without throwing, with its landmark heading, before any
 * data arrives (server render runs no queries, so this is the first paint a student sees).
 */
function render(Page: ComponentType): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Server render has no window.location, so wouter gets the path explicitly, as the app's base.
  const page = createElement(Router, { base: "/app", ssrPath: "/app/page" }, createElement(Page));
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, page));
}

describe("pages render", () => {
  it("roadmap", () => {
    const html = render(RoadmapPage);
    expect(html).toContain('id="roadmap-title"');
    expect(html).toContain("Loading your roadmap");
  });

  it("ask shows suggestion tiles and the privacy note", () => {
    const html = render(AskPage);
    expect(html).toContain("I&#x27;m Novus.");
    expect(html).toContain("Suggested questions");
    expect(html).toContain("Do not share citizenship, income or identity here.");
  });

  it("settings lists what stays on the device", () => {
    const html = render(SettingsPage);
    expect(html).toContain("Settings and privacy");
    expect(html).toContain("Stays on this device");
    expect(html).toContain("Use the AI assistant");
  });

  it("onboarding starts at the age step with no sensitive questions", () => {
    const html = render(OnboardingPage);
    expect(html).toContain("When were you born?");
    expect(html).toContain("Step 1 of 5");
    expect(html).not.toMatch(/name="(citizenship|pell|firstGeneration|identity)"/);
  });
});
