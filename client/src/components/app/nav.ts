import { Bell, Compass, Home, ListChecks, Map, Settings, Sparkles, Users, type LucideIcon } from "lucide-react";
import type { Role } from "@shared/taxonomy";
import { appPaths } from "@/lib/routes";

/** Navigation items. Readiness and program pages are reached from cards, not the nav (plan D2). */
export interface NavItem {
  readonly id: "home" | "explore" | "tracker" | "roadmap" | "ask" | "notifications" | "advisor" | "settings";
  readonly href: string;
  readonly label: string;
  /** Shorter label for the phone tab bar. */
  readonly short: string;
  readonly icon: LucideIcon;
  /** Only shown to these roles; undefined means everyone. */
  readonly roles?: readonly Role[];
  /** Phone tab bar holds at most five items. */
  readonly inTabBar: boolean;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { id: "home", href: appPaths.home, label: "Home", short: "Home", icon: Home, inTabBar: true },
  { id: "explore", href: appPaths.explore, label: "Explore", short: "Explore", icon: Compass, inTabBar: true },
  { id: "tracker", href: appPaths.tracker, label: "Tracker", short: "Tracker", icon: ListChecks, inTabBar: true },
  { id: "roadmap", href: appPaths.roadmap, label: "Roadmap", short: "Roadmap", icon: Map, inTabBar: true },
  { id: "ask", href: appPaths.ask, label: "Ask Novus", short: "Ask", icon: Sparkles, inTabBar: true },
  { id: "notifications", href: appPaths.notifications, label: "Notifications", short: "Alerts", icon: Bell, inTabBar: false },
  { id: "advisor", href: appPaths.advisor, label: "Advisor", short: "Advisor", icon: Users, roles: ["advisor", "admin"], inTabBar: false },
  { id: "settings", href: appPaths.settings, label: "Settings", short: "Settings", icon: Settings, inTabBar: false },
];

export function visibleNavItems(roles: readonly Role[] | undefined): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.roles || item.roles.some((r) => roles?.includes(r)));
}

/**
 * Which nav item a location belongs to. Program and readiness pages sit under Explore, so one
 * item is highlighted at a time (the old sidebar highlighted several).
 */
export function activeNavId(location: string): NavItem["id"] | null {
  const path = location.split(/[?#]/)[0] || "/";
  if (path === "/" || path === "") return "home";
  if (path.startsWith("/programs/") || path.startsWith("/readiness/")) return "explore";
  const match = NAV_ITEMS.find((item) => item.href !== "/" && (path === item.href || path.startsWith(`${item.href}/`)));
  return match?.id ?? null;
}
