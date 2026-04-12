import {
  Compass, GraduationCap, Microscope, Trophy, Map, Target,
  Bookmark, Send, Users, Heart, PenSquare, Home, Settings, LogOut
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { PathfulLogo } from "./pathful-logo";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
  SidebarSeparator,
} from "@/components/ui/sidebar";

const iconMap: Record<string, React.ReactNode> = {
  Compass: <Compass className="w-4 h-4" />,
  GraduationCap: <GraduationCap className="w-4 h-4" />,
  Microscope: <Microscope className="w-4 h-4" />,
  Trophy: <Trophy className="w-4 h-4" />,
  Map: <Map className="w-4 h-4" />,
  Target: <Target className="w-4 h-4" />,
  Bookmark: <Bookmark className="w-4 h-4" />,
  Send: <Send className="w-4 h-4" />,
  Users: <Users className="w-4 h-4" />,
  Heart: <Heart className="w-4 h-4" />,
  PenSquare: <PenSquare className="w-4 h-4" />,
  Home: <Home className="w-4 h-4" />,
  Settings: <Settings className="w-4 h-4" />,
};

const navGroups = [
  {
    label: "Discover",
    items: [
      { title: "Opportunity Feed", href: "/dashboard", icon: "Compass" },
      { title: "Scholarships", href: "/dashboard", icon: "GraduationCap" },
      { title: "Research", href: "/dashboard", icon: "Microscope" },
      { title: "Competitions", href: "/dashboard", icon: "Trophy" },
    ],
  },
  {
    label: "My Path",
    items: [
      { title: "Career Roadmap", href: "/roadmap", icon: "Map" },
      { title: "Readiness Score", href: "/readiness", icon: "Target" },
      { title: "Saved", href: "/dashboard", icon: "Bookmark" },
      { title: "Applications", href: "/dashboard", icon: "Send" },
    ],
  },
  {
    label: "Connect",
    items: [
      { title: "Community", href: "/community", icon: "Users" },
      { title: "Mentors", href: "/community", icon: "Heart" },
      { title: "My Stories", href: "/community", icon: "PenSquare" },
    ],
  },
];

export function AppSidebar() {
  const [location] = useLocation();

  return (
    <Sidebar
      data-testid="sidebar-nav"
      className="border-r border-[#1a3a5c]/10"
    >
      <SidebarHeader className="p-4">
        <Link href="/">
          <PathfulLogo className="text-[#1a3a5c] cursor-pointer" />
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel className="text-xs font-semibold uppercase tracking-wider text-[#5a6a7a]">
              {group.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => {
                  const isActive = location === item.href;
                  return (
                    <SidebarMenuItem key={item.title}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        data-testid={`nav-${item.title.toLowerCase().replace(/\s+/g, '-')}`}
                      >
                        <Link href={item.href}>
                          {iconMap[item.icon]}
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="p-4">
        <SidebarSeparator />
        <div className="flex items-center gap-3 mt-3 px-2">
          <div className="w-8 h-8 rounded-full bg-[#ff6b35]/15 border border-[#ff6b35]/25 flex items-center justify-center text-[#ff6b35] text-xs font-bold">
            JC
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-[#1a3a5c] truncate font-display">Jose Cruz-Lopez</div>
            <div className="text-xs text-[#5a6a7a] truncate">Computer Science</div>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
