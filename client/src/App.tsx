import { Switch, Route, Router, useLocation } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider, useTheme } from "@/components/theme-provider";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Sun, Moon } from "lucide-react";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/landing";
import DashboardPage from "@/pages/dashboard";
import RoadmapPage from "@/pages/roadmap";
import CommunityPage from "@/pages/community";
import ReadinessPage from "@/pages/readiness";
import OpportunityProfilePage from "@/pages/opportunity-profile";

// Pages that use the dashboard layout (sidebar)
const DASHBOARD_ROUTES = ["/dashboard", "/roadmap", "/community", "/readiness", "/opportunity"];

function ThemeToggleButton() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      onClick={toggleTheme}
      className="p-2 rounded-lg hover:bg-muted transition-colors"
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      data-testid="button-theme-toggle-app"
    >
      {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </button>
  );
}

function DashboardLayout({ children }: { children: React.ReactNode }) {
  const sidebarStyle = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3.5rem",
  };

  return (
    <SidebarProvider style={sidebarStyle as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center justify-between px-4 py-2 border-b border-border/50 bg-background/80 backdrop-blur-sm">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
            <ThemeToggleButton />
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
