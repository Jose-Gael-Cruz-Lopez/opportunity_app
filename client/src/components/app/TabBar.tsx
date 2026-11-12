import { Link, useLocation } from "wouter";
import { activeNavId, NAV_ITEMS } from "./nav";
import { Panel } from "./Panel";

/** Phone tab bar (under 1024 px): five destinations, 48 px targets, solid unless glass is on. */
export function TabBar() {
  const [location] = useLocation();
  const active = activeNavId(location);
  return (
    <div className="nv-tabbar">
      <Panel as="nav" tone="strong" aria-label="App tabs">
        {NAV_ITEMS.filter((item) => item.inTabBar).map((item) => (
          <Link key={item.id} href={item.href} className="nv-tab" aria-current={active === item.id ? "page" : undefined}>
            <item.icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.6} />
            {item.short}
          </Link>
        ))}
      </Panel>
    </div>
  );
}
