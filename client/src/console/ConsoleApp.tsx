import { useCallback, useEffect, useState } from "react";
import { Link, Route, Router, Switch, useLocation } from "wouter";
import { consoleApi, ConsoleError, type QueueResponse } from "./api";
import { useGlobalErrorCapture, usePageViews } from "@/lib/telemetry";
import { Gate, type GateKind } from "./Gate";
import { MetricsPage } from "./metrics/MetricsPage";
import { OpsPage } from "./OpsPage";
import { Workspace } from "./Workspace";

/**
 * The Curator console: a separate React entry served at /curate/* on the `curate.` host (Access,
 * TOTP, Strict session cookie). Screens: the review workspace, the ops pipeline view and, for
 * admins, the founders' metrics (aggregates only, counts under 5 hidden by the server). Solid
 * surfaces only; nothing here reads or shows a student's own data.
 */

export const CONSOLE_BASE = "/curate";

function NavLink({ href, children }: { href: string; children: string }) {
  const [location] = useLocation();
  const current = href === "/" ? location === "/" || location.startsWith("/tasks") : location.startsWith(href);
  return (
    <Link href={href} aria-current={current ? "page" : undefined}>
      {children}
    </Link>
  );
}

/** Content-free crash reports and console page views (docs/telemetry.md). */
function ConsoleTelemetry() {
  const [location] = useLocation();
  useGlobalErrorCapture("console");
  usePageViews(location, "console");
  return null;
}

/** Admins see the Metrics link; the server answers 403 to anyone else who opens the page. */
function MetricsNavLink({ isAdmin }: { isAdmin: boolean }) {
  const [location] = useLocation();
  return isAdmin || location.startsWith("/metrics") ? <NavLink href="/metrics">Metrics</NavLink> : null;
}

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function ConsoleApp() {
  const [gate, setGate] = useState<GateKind | null>(null);
  const [viewer, setViewer] = useState<QueueResponse["viewer"] | null>(null);
  const [attempt, setAttempt] = useState(0);
  const now = useNow();

  /** Routes auth failures to the gate; true when handled. */
  const onAuthError = useCallback((err: ConsoleError) => {
    if (err.kind === "signed_out" || err.kind === "step_up" || err.kind === "enroll") {
      setGate(err.kind);
      return true;
    }
    return false;
  }, []);

  const onViewer = useCallback((v: QueueResponse["viewer"]) => setViewer(v), []);

  return (
    <Router base={CONSOLE_BASE}>
      <ConsoleTelemetry />
      <div className="cn-root">
        <header className="cn-bar">
          <span className="cn-brand">
            Novus<small>Curator console</small>
          </span>
          <nav className="cn-nav" aria-label="Console">
            <NavLink href="/">Review</NavLink>
            <NavLink href="/ops">Pipeline</NavLink>
            <MetricsNavLink isAdmin={viewer?.roles.includes("admin") ?? false} />
          </nav>
          <span className="cn-spacer" />
          {viewer ? <span className="cn-who">{viewer.handle} · {viewer.roles.join(", ")}</span> : null}
        </header>
        <main className="cn-main" key={attempt}>
          <p className="cn-notice">Records marked Sample are demonstration data, not real programs. Approving writes the public registry and alerts students.</p>
          {gate ? (
            <Gate
              kind={gate}
              api={consoleApi}
              onPassed={() => {
                setGate(null);
                setAttempt((a) => a + 1);
              }}
            />
          ) : (
            <Switch>
              <Route path="/ops">
                <OpsPage api={consoleApi} isAdmin={viewer?.roles.includes("admin") ?? false} onAuthError={onAuthError} />
              </Route>
              <Route path="/metrics">
                <MetricsPage onAuthError={onAuthError} />
              </Route>
              <Route path="/tasks/:id">
                {(params) => <Workspace api={consoleApi} taskId={params.id} now={now} onAuthError={onAuthError} onViewer={onViewer} />}
              </Route>
              <Route>
                <Workspace api={consoleApi} taskId={null} now={now} onAuthError={onAuthError} onViewer={onViewer} />
              </Route>
            </Switch>
          )}
        </main>
      </div>
    </Router>
  );
}
