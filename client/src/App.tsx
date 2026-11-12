import { lazy, Suspense, useEffect, type ComponentType, type LazyExoticComponent } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Redirect, Route, Router, Switch, useLocation } from "wouter";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppShell, LoadingPanel, NotFoundPage, PageErrorBoundary, PagePlaceholder } from "@/components/app";
import { LookProvider } from "@/design";
import { useSession } from "@/lib/queries";
import { queryClient } from "@/lib/queryClient";
import { analyticsAllowedFor, setTelemetryConsent, useGlobalErrorCapture, usePageViews } from "@/lib/telemetry";
import { APP_BASE, FOLDER_ALIASES, PAGE_ROUTES, type PageRoute } from "@/lib/routes";

/** Props every page receives; pages may also call wouter's useParams/useSearch themselves. */
export interface PageProps {
  params: Record<string, string | undefined>;
}

type PageModule = { default: ComponentType<PageProps> };

/**
 * Pages load from client/src/pages/<folder>/index.tsx. Each is its own chunk (so a route only
 * loads its own JS), and a page that has not been written yet renders a placeholder instead of
 * breaking the build. The folder list is explicit (it must be a literal for Vite) so an
 * unrelated folder under pages/ never enters the bundle; keep it in step with lib/routes.ts.
 */
// "onboarding" is redirect-only (to /start), so its old page is not bundled.
const PAGE_MODULES = import.meta.glob<PageModule>("./pages/{home,explore,program,programs,readiness,tracker,roadmap,ask,notifications,settings,start,sign-in,advisor}/index.tsx");

function loaderFor(route: PageRoute): (() => Promise<PageModule>) | null {
  const folders = FOLDER_ALIASES[route.id] ?? [route.folder];
  for (const folder of folders) {
    const load = PAGE_MODULES[`./pages/${folder}/index.tsx`];
    if (load) return load;
  }
  return null;
}

const PAGES: ReadonlyArray<{ route: PageRoute; Page: LazyExoticComponent<ComponentType<PageProps>> | null }> = PAGE_ROUTES.map((route) => {
  const load = "redirectTo" in route ? null : loaderFor(route);
  return { route, Page: load ? lazy(load) : null };
});

/**
 * First-party telemetry (docs/telemetry.md): content-free crash reports, one page_view per
 * route change, and analytics off for accounts in minor mode. The server also refuses analytics
 * for accounts that switched it off.
 */
function TelemetryWiring(props: { location: string }) {
  useGlobalErrorCapture("spa");
  usePageViews(props.location);
  const session = useSession();
  const data = session.data?.data;
  useEffect(() => {
    if (data) setTelemetryConsent(analyticsAllowedFor(data, Date.now()));
  }, [data]);
  return null;
}

function Routes() {
  const [location] = useLocation();
  return (
    <AppShell>
      <TelemetryWiring location={location} />
      <PageErrorBoundary resetKey={location}>
        <Suspense fallback={<LoadingPanel label="Loading…" />}>
          <Switch>
            {PAGES.map(({ route, Page }) => (
              <Route key={route.id} path={route.path}>
                {(params: Record<string, string | undefined>) =>
                  "redirectTo" in route ? (
                    <Redirect to={route.redirectTo} replace />
                  ) : Page ? (
                    <Page params={params} />
                  ) : (
                    <PagePlaceholder title={route.label} />
                  )
                }
              </Route>
            ))}
            <Route>
              <NotFoundPage />
            </Route>
          </Switch>
        </Suspense>
      </PageErrorBoundary>
    </AppShell>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LookProvider>
        <TooltipProvider delayDuration={300}>
          <Router base={APP_BASE}>
            <Routes />
          </Router>
          <Toaster />
        </TooltipProvider>
      </LookProvider>
    </QueryClientProvider>
  );
}
