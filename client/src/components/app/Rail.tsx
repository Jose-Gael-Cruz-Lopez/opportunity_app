import { Lock, LogOut } from "lucide-react";
import { Link, useLocation } from "wouter";
import { CLASS_YEAR_LABELS } from "@shared/taxonomy";
import { termKeyForDate } from "@shared/time";
import { viewerToday } from "@/lib/deadlines";
import { formatTermLabel, plural } from "@/lib/format";
import { usePrograms, useSession, useTracker } from "@/lib/queries";
import { appPaths } from "@/lib/routes";
import { SIGN_OUT_FAILED_COPY, useSignOut } from "@/lib/sign-out";
import { summarizeTracker } from "@/lib/tracker-summary";
import { Brand } from "./Brand";
import { activeNavId, visibleNavItems } from "./nav";
import { Panel } from "./Panel";

/** Desktop navigation rail (hidden under 1024 px, where the tab bar takes over). */
export function Rail() {
  const [location] = useLocation();
  const session = useSession();
  const tracker = useTracker();
  const programs = usePrograms();
  const user = session.data?.data.user ?? null;
  const profile = session.data?.data.profile ?? null;
  const active = activeNavId(location);
  const now = Date.now();
  const today = viewerToday(now, profile?.timeZone);
  const summary = programs.data && tracker.data ? summarizeTracker(programs.data.data, tracker.data.data, now, profile?.timeZone) : null;
  const trackedCount = tracker.data?.data.filter((t) => t.status !== "not_applying").length;
  const exit = useSignOut();

  return (
    <Panel as="aside" tone="strong" className="nv-rail" aria-label="Main">
      {/* A full page load: the public site is served by the Worker, not by this SPA. */}
      <a href="/" className="mb-5 rounded-xl px-2 pt-1" aria-label="Novus public site">
        <Brand />
      </a>
      <nav aria-label="App">
        <ul className="nv-nav">
          {visibleNavItems(user?.roles).map((item) => (
            <li key={item.id}>
              <Link href={item.href} className="nv-nav-link" aria-current={active === item.id ? "page" : undefined}>
                <item.icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.6} />
                {item.label}
                {item.id === "tracker" && trackedCount ? (
                  <span className="nv-count">
                    {trackedCount}
                    <span className="sr-only"> tracked</span>
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div className="nv-rail-card mt-4">
        <span className="nv-meta">Your season</span>
        <b className="text-base font-semibold">
          {profile?.classYear ? `${CLASS_YEAR_LABELS[profile.classYear]} · ` : ""}
          {formatTermLabel(termKeyForDate(today))}
        </b>
        {summary ? <span className="nv-meta">{plural(summary.dueSoon, "deadline")} in the next 30 days</span> : null}
      </div>

      <p className="nv-privacy mt-2.5">
        <Lock aria-hidden="true" className="mt-px h-[18px] w-[18px] flex-none" style={{ color: "var(--nv-leaf)" }} />
        <span>Eligibility answers about status or identity stay on this device.</span>
      </p>

      <div className="mt-auto pt-3">
        {user ? (
          <div className="flex flex-col gap-2">
            <Link href={appPaths.settings} className="flex items-center gap-2.5 rounded-[20px] bg-white/[0.08] p-2.5 hover:bg-white/[0.12]">
              <span className="grid h-10 w-10 flex-none place-items-center rounded-full bg-white/[0.14] font-semibold" aria-hidden="true">
                {(user.displayName ?? user.email).charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0">
                <b className="block truncate text-[14.5px] font-semibold">{user.displayName ?? "Your account"}</b>
                <span className="nv-meta block truncate">{profile?.classYear ? CLASS_YEAR_LABELS[profile.classYear] : "Settings"}</span>
              </span>
            </Link>
            {/* Shared and library computers: ending the session must be one visible click away. */}
            <button type="button" className="nv-btn w-full" onClick={() => void exit.signOut()} disabled={exit.pending}>
              <LogOut aria-hidden="true" className="h-4 w-4" strokeWidth={1.6} />
              {exit.pending ? "Signing out…" : "Sign out"}
            </button>
            <p className="nv-meta" role="status" aria-live="polite">
              {exit.failed ? SIGN_OUT_FAILED_COPY : ""}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {/* The guided first five minutes is the one entry flow; /onboarding redirects to it. */}
            <Link href={appPaths.start} className="nv-btn nv-btn-cream w-full">
              Get started
            </Link>
            <Link href={appPaths.signIn} className="nv-btn w-full">
              Sign in
            </Link>
          </div>
        )}
      </div>
    </Panel>
  );
}
