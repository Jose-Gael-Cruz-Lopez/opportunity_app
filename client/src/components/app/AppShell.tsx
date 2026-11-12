import { useEffect, useRef, type ReactNode } from "react";
import { useLocation } from "wouter";
import { documentTitle, isBareRoute } from "@/lib/routes";
import { Rail } from "./Rail";
import { TabBar } from "./TabBar";
import { TopBar } from "./TopBar";

/** The blurred ground and its grain, drawn once behind every page. Decorative. */
export function Scene() {
  return (
    <>
      <div className="nv-scene" aria-hidden="true" />
      <div className="nv-grain" aria-hidden="true" />
    </>
  );
}

/**
 * App frame: skip link, rail (desktop), top bar, main region and tab bar (phones). On each route
 * change it updates the document title and moves focus to <main>, so keyboard and screen-reader
 * users start at the new page instead of the old link.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const main = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  const bare = isBareRoute(location);

  useEffect(() => {
    document.title = documentTitle(location);
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [location]);

  return (
    <>
      <Scene />
      <a href="#main" className="nv-skip">
        Skip to content
      </a>
      {bare ? (
        <div className="nv-app">
          <main id="main" ref={main} tabIndex={-1} className="mx-auto max-w-[1180px] px-4 py-6 outline-none">
            {children}
          </main>
        </div>
      ) : (
        <div className="nv-app">
          <Rail />
          <div className="nv-main">
            <TopBar />
            <main id="main" ref={main} tabIndex={-1} className="nv-content outline-none">
              {children}
            </main>
          </div>
          <TabBar />
        </div>
      )}
    </>
  );
}
