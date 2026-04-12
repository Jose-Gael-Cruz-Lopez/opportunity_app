import { useEffect } from "react";
import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/landing";
import DashboardPage from "@/pages/dashboard";
import RoadmapPage from "@/pages/roadmap";
import CommunityPage from "@/pages/community";
import ReadinessPage from "@/pages/readiness";
import OpportunityProfilePage from "@/pages/opportunity-profile";

// Pages that use the dashboard layout (sidebar)
const DASHBOARD_ROUTES = ["/dashboard", "/roadmap", "/community", "/readiness", "/opportunity"];

function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { setTheme } = useTheme();

  /* App shell matches landing: light cream palette (not system dark mode). */
  useEffect(() => {
    setTheme("light");
  }, [setTheme]);

  const sidebarStyle = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3.5rem",
  };

  return (
    <SidebarProvider style={sidebarStyle as React.CSSProperties}>
      <div className="flex h-screen w-full bg-[#f8f5f0]">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center justify-between px-4 py-3 border-b border-[#1a3a5c]/10 bg-[#f8f5f0]/95 backdrop-blur-md">
            <SidebarTrigger
              data-testid="button-sidebar-toggle"
              className="text-[#1a3a5c] hover:bg-[#ff6b35]/10"
            />
          </header>
          <main className="flex-1 overflow-hidden">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function AppRouter() {
  const [location] = useLocation();
  const isDashboardRoute = DASHBOARD_ROUTES.some((r) => location.startsWith(r));

  if (isDashboardRoute) {
    return (
      <DashboardLayout>
        <Switch>
          <Route path="/dashboard" component={DashboardPage} />
          <Route path="/roadmap" component={RoadmapPage} />
          <Route path="/community" component={CommunityPage} />
          <Route path="/readiness" component={ReadinessPage} />
          <Route path="/opportunity/:id" component={OpportunityProfilePage} />
          <Route component={NotFound} />
        </Switch>
      </DashboardLayout>
    );
  }

  return (
    <Switch>
      <Route path="/" component={LandingPage} />
      <Route path="/dashboard" component={DashboardPage} />
      <Route path="/roadmap" component={RoadmapPage} />
      <Route path="/community" component={CommunityPage} />
      <Route path="/readiness" component={ReadinessPage} />
      <Route path="/opportunity/:id" component={OpportunityProfilePage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <ThemeProvider>
          <Toaster />
          <Router hook={useHashLocation}>
            <AppRouter />
          </Router>
        </ThemeProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
