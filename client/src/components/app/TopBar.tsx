import { useEffect, useRef, useState, type FormEvent } from "react";
import { Bell, LogOut, Search, Settings, ShieldCheck, Users } from "lucide-react";
import { Link, useLocation } from "wouter";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useSampleDataShown } from "@/lib/data-source";
import { formatAgo } from "@/lib/format";
import { useInbox, useSession } from "@/lib/queries";
import { appPaths } from "@/lib/routes";
import { SIGN_OUT_FAILED_COPY, useSignOut } from "@/lib/sign-out";
import { visibleNavItems } from "./nav";
import { BrandMark } from "./Brand";
import { LookSwitch } from "./LookSwitch";
import { Panel } from "./Panel";

/** True when a key event comes from a field where "/" or "k" is ordinary typing. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function GlobalSearch() {
  const [, navigate] = useLocation();
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);

  // Cmd/Ctrl+K anywhere, or "/" outside a text field, jumps to search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const combo = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      const slash = e.key === "/" && !isTypingTarget(e.target);
      if (combo || slash) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    navigate(appPaths.exploreSearch(q));
    setQ("");
  };

  return (
    <Panel as="form" role="search" className="nv-field h-12 min-w-0 max-w-[520px] flex-1 pl-4 pr-2.5" onSubmit={onSubmit}>
      <Search aria-hidden="true" className="h-5 w-5 flex-none nv-ink-2" strokeWidth={1.6} />
      <label htmlFor="nv-top-search" className="sr-only">
        Search programs
      </label>
      <input
        ref={input}
        id="nv-top-search"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search programs, organizations, fields"
        autoComplete="off"
        enterKeyHint="search"
      />
      <kbd className="nv-kbd nv-hide-sm" aria-hidden="true">
        ⌘K
      </kbd>
    </Panel>
  );
}

function Notifications() {
  const inbox = useInbox();
  const items = inbox.data?.data ?? [];
  const unread = items.filter((i) => !i.readAt).length;
  const now = Date.now();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="nv-icon-btn" aria-label={unread ? `Notifications, ${unread} new` : "Notifications"}>
          <Bell aria-hidden="true" className="h-5 w-5" strokeWidth={1.6} />
          {unread ? (
            <span className="nv-badge" aria-hidden="true">
              {unread}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(360px,calc(100vw-32px))] rounded-3xl p-2">
        <h2 className="px-3 pb-1 pt-2 text-sm font-semibold">Notifications</h2>
        {items.length === 0 ? (
          <p className="px-3 pb-3 nv-meta">Nothing new. Changes to programs you track show up here.</p>
        ) : (
          <ul>
            {items.slice(0, 6).map((item) => (
              <li key={item.id}>
                <Link href={item.href?.replace(/^\/app(?=\/|$)/, "") || "/"} className="block rounded-2xl px-3 py-2.5 hover:bg-white/[0.08]" onClick={close}>
                  <span className="block text-sm">{item.title}</span>
                  <span className="nv-meta">{formatAgo(item.createdAt, now)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {/* The only way to the notification centre on a phone, where the rail is hidden. */}
        <Link
          href={appPaths.notifications}
          className="mt-1 flex min-h-12 items-center rounded-2xl px-3 py-2.5 text-sm font-semibold hover:bg-white/[0.08]"
          onClick={close}
        >
          See all notifications
        </Link>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Phone account menu (under 1024 px, where the rail is hidden): the way to Notifications,
 * Settings, the privacy centre, Advisor and signing in or out from a phone. The rail covers these on desktop.
 */
function AccountMenu() {
  const session = useSession();
  const exit = useSignOut();
  const [open, setOpen] = useState(false);
  const user = session.data?.data.user ?? null;
  const advisor = visibleNavItems(user?.roles).some((item) => item.id === "advisor");
  const close = () => setOpen(false);
  const initial = user ? (user.displayName ?? user.email).charAt(0).toUpperCase() : null;
  const row = "flex min-h-12 items-center gap-3 rounded-2xl px-3 py-2.5 text-[15px] hover:bg-white/[0.08]";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="nv-icon-btn lg:hidden" aria-label={user ? "Account and settings" : "Sign in and settings"}>
          {initial ? (
            <span className="text-[15px] font-semibold" aria-hidden="true">
              {initial}
            </span>
          ) : (
            <Settings aria-hidden="true" className="h-5 w-5" strokeWidth={1.6} />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(320px,calc(100vw-32px))] rounded-3xl p-2">
        <nav aria-label="Account">
          {user ? (
            <p className="px-3 pb-1 pt-2">
              <b className="block truncate text-sm font-semibold">{user.displayName ?? "Your account"}</b>
              <span className="nv-meta block truncate">{user.email}</span>
            </p>
          ) : null}
          <ul className="flex flex-col">
            {!user ? (
              <>
                <li>
                  <Link href={appPaths.start} className={row} onClick={close}>
                    Get started
                  </Link>
                </li>
                <li>
                  <Link href={appPaths.signIn} className={row} onClick={close}>
                    Sign in
                  </Link>
                </li>
              </>
            ) : null}
            {user ? (
              <li>
                <Link href={appPaths.notifications} className={row} onClick={close}>
                  <Bell aria-hidden="true" className="h-5 w-5" strokeWidth={1.6} />
                  Notifications
                </Link>
              </li>
            ) : null}
            <li>
              <Link href={appPaths.settings} className={row} onClick={close}>
                <Settings aria-hidden="true" className="h-5 w-5" strokeWidth={1.6} />
                Settings
              </Link>
            </li>
            <li>
              <Link href={`${appPaths.settings}#inventory-title`} className={row} onClick={close}>
                <ShieldCheck aria-hidden="true" className="h-5 w-5" strokeWidth={1.6} />
                Privacy and private answers
              </Link>
            </li>
            {advisor ? (
              <li>
                <Link href={appPaths.advisor} className={row} onClick={close}>
                  <Users aria-hidden="true" className="h-5 w-5" strokeWidth={1.6} />
                  Advisor
                </Link>
              </li>
            ) : null}
            {user ? (
              <li>
                <button type="button" className={`${row} w-full text-left`} onClick={() => void exit.signOut()} disabled={exit.pending}>
                  <LogOut aria-hidden="true" className="h-5 w-5" strokeWidth={1.6} />
                  {exit.pending ? "Signing out…" : "Sign out"}
                </button>
              </li>
            ) : null}
          </ul>
          <p className="nv-meta px-3" role="status" aria-live="polite">
            {exit.failed ? SIGN_OUT_FAILED_COPY : ""}
          </p>
        </nav>
      </PopoverContent>
    </Popover>
  );
}

export function TopBar() {
  const sample = useSampleDataShown();
  return (
    <header className="nv-topbar">
      <Link href="/" className="rounded-xl lg:hidden" aria-label="Novus home">
        <BrandMark />
      </Link>
      <GlobalSearch />
      <span className="flex-1" />
      <LookSwitch />
      {sample ? (
        <span className="nv-sample-pill nv-hide-sm" title="Some of what you see is sample data while Novus is being built">
          Sample data
        </span>
      ) : null}
      <Notifications />
      <AccountMenu />
    </header>
  );
}
