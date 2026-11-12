import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createPrivateAnswersStore, CLEAR_PRIVATE_ANSWERS_EVENT as STORE_EVENT, listenForClearRequests } from "@/components/readiness/private-answers-store";
import { toAccountSession } from "@/components/forms/request";
import { resolveDataMode } from "@/lib/data-source";
import { sampleSession } from "@/lib/fixtures/student";
import { appPaths, FOLDER_ALIASES, isBareRoute, matchPageRoute, PAGE_ROUTES } from "@/lib/routes";
import { CLEAR_PRIVATE_ANSWERS_EVENT as SETTINGS_EVENT } from "@/pages/settings/model";

/**
 * Cross-module checks for the assembled SPA: every route has a page, the cache and CSS
 * conventions that let independently written pages share one app, and the privacy wiring
 * between Settings and the private-answer store.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

describe("every route resolves to a real page", () => {
  const appSource = readFileSync(join(SRC, "App.tsx"), "utf8");
  const globFolders = /pages\/\{([^}]+)\}\/index\.tsx/.exec(appSource)?.[1]?.split(",") ?? [];

  for (const route of PAGE_ROUTES) {
    if ("redirectTo" in route) {
      it(`${route.path} redirects to ${route.redirectTo}, a real page, and is not bundled`, () => {
        expect(matchPageRoute(route.redirectTo)).not.toBeNull();
        expect("redirectTo" in (matchPageRoute(route.redirectTo) ?? {})).toBe(false);
        expect(globFolders).not.toContain(route.folder);
      });
      continue;
    }
    it(`${route.path} -> pages/${route.folder}`, () => {
      const folders = FOLDER_ALIASES[route.id] ?? [route.folder];
      const existing = folders.filter((f) => existsSync(join(SRC, "pages", f, "index.tsx")));
      expect(existing.length).toBeGreaterThan(0);
      // App.tsx's glob must list the folder, or Vite leaves the page out and shows a placeholder.
      expect(existing.some((f) => globFolders.includes(f))).toBe(true);
      const source = readFileSync(join(SRC, "pages", existing[0] as string, "index.tsx"), "utf8");
      expect(source).toMatch(/export default function/);
    });
  }

  it("routes start and sign-in as full-screen pages and keys readiness by cycle", () => {
    expect(matchPageRoute("/start")?.id).toBe("start");
    expect(matchPageRoute("/sign-in")?.id).toBe("signIn");
    expect(isBareRoute("/sign-in")).toBe(true);
    expect(isBareRoute("/start")).toBe(true);
    expect(PAGE_ROUTES.find((r) => r.id === "readiness")?.path).toBe("/readiness/:programCycleId");
    expect(appPaths.readiness("c-1", "some-program")).toBe("/readiness/c-1?program=some-program");
    expect(appPaths.readiness("c-1")).toBe("/readiness/c-1");
  });
});

describe("data mode", () => {
  it("defaults to auto in development and live in production", () => {
    expect(resolveDataMode({ envValue: undefined, isDev: true, search: "" })).toBe("auto");
    expect(resolveDataMode({ envValue: undefined, isDev: false, search: "" })).toBe("live");
  });

  it("honours VITE_NOVUS_DATA and ?sample=1", () => {
    expect(resolveDataMode({ envValue: "fixtures", isDev: false, search: "" })).toBe("fixtures");
    expect(resolveDataMode({ envValue: "live", isDev: true, search: "" })).toBe("live");
    expect(resolveDataMode({ envValue: "auto", isDev: false, search: "" })).toBe("auto");
    expect(resolveDataMode({ envValue: "live", isDev: false, search: "?sample=1" })).toBe("fixtures");
  });

  it("never treats a sample session as an account", () => {
    expect(toAccountSession({ data: sampleSession(), source: "sample" })).toEqual({ session: null, sample: true });
    const live = sampleSession();
    expect(toAccountSession({ data: live, source: "live" })).toEqual({ session: live, sample: false });
  });
});

describe("Settings clears private answers held by the readiness store", () => {
  it("uses one event name in both modules", () => {
    expect(STORE_EVENT).toBe(SETTINGS_EVENT);
  });

  it("clears the store when the event fires", () => {
    const target = new EventTarget();
    const store = createPrivateAnswersStore(60_000);
    const stop = listenForClearRequests(store, target);
    store.setAnswer("citizenship", "us_citizen");
    target.dispatchEvent(new Event(STORE_EVENT));
    expect(store.getSnapshot().answers).toEqual({});
    stop();
    store.setAnswer("citizenship", "us_citizen");
    target.dispatchEvent(new Event(STORE_EVENT));
    expect(store.getSnapshot().answers).toEqual({ citizenship: "us_citizen" });
    store.clear();
  });
});

describe("page stylesheets cannot override the shell", () => {
  const classes = (css: string, prefix: string) => new Set([...css.matchAll(new RegExp(`\\.(${prefix}-[A-Za-z0-9_-]+)`, "g"))].map((m) => m[1]));
  const keyframes = (css: string) => new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
  const shellCss = readFileSync(join(SRC, "index.css"), "utf8");
  const shell = classes(shellCss, "nv");
  const sheets = ["components/readiness/novus.css", "components/forms/theme.css", "components/start/start.css"];

  for (const sheet of sheets) {
    it(`${sheet} shares no class or keyframes name with index.css`, () => {
      const css = readFileSync(join(SRC, sheet), "utf8");
      const clash = [...classes(css, "nv")].filter((c) => shell.has(c));
      expect(clash).toEqual([]);
      const kfClash = [...keyframes(css)].filter((k) => keyframes(shellCss).has(k));
      expect(kfClash).toEqual([]);
    });
  }
});
