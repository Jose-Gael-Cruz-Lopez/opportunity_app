import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "wouter";
import { describeApiError } from "@/lib/api";
import { Panel } from "./Panel";
import { reportBoundaryError } from "@/lib/telemetry";

/** Loading placeholder: shape only, no shimmer (reduced motion friendly). */
export function LoadingPanel({ label, className }: { label: string; className?: string }) {
  return (
    <Panel className={className} aria-busy="true">
      <div className="p-6 nv-meta" role="status">
        {label}
      </div>
    </Panel>
  );
}

export function ErrorPanel({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  return (
    <Panel className={className} role="alert">
      <div className="flex flex-col items-start gap-3 p-6">
        <p className="nv-ink-2">{describeApiError(error)}</p>
        {onRetry ? (
          <button type="button" className="nv-btn" onClick={onRetry}>
            Try again
          </button>
        ) : null}
      </div>
    </Panel>
  );
}

export function EmptyPanel({ title, children, className }: { title: string; children?: ReactNode; className?: string }) {
  return (
    <Panel className={className}>
      <div className="flex flex-col items-center gap-2 p-8 text-center">
        <p className="font-semibold">{title}</p>
        {children ? <div className="nv-ink-2 text-sm">{children}</div> : null}
      </div>
    </Panel>
  );
}

/** Shown for a route whose page module has not been written yet. */
export function PagePlaceholder({ title }: { title: string }) {
  return (
    <section aria-labelledby="placeholder-title" className="flex flex-col gap-4">
      <h1 id="placeholder-title" className="nv-h-lg">
        {title}
      </h1>
      <EmptyPanel title="This page is on its way">
        It is part of the Novus build and will appear here soon. <Link href="/" className="nv-link underline">Back to Home</Link>
      </EmptyPanel>
    </section>
  );
}

export function NotFoundPage() {
  return (
    <section aria-labelledby="nf-title" className="flex flex-col gap-4">
      <h1 id="nf-title" className="nv-h-lg">
        Page not found
      </h1>
      <EmptyPanel title="Nothing lives at this address">
        <Link href="/explore" className="nv-link underline">
          Explore programs
        </Link>{" "}
        or go <Link href="/" className="nv-link underline">Home</Link>.
      </EmptyPanel>
    </section>
  );
}

interface BoundaryState {
  error: Error | null;
}

/** Keeps a crash in one page from blanking the shell; resets when the route changes. */
export class PageErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log the shape only; page state can hold private answers, so no props or values.
    console.error("Page crashed:", error.name, info.componentStack?.split("\n")[1]?.trim());
    // A content-free crash report: error class and first-party file and line only.
    reportBoundaryError(error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <EmptyPanel title="This page hit a problem">
          Reload to try again. If it keeps happening, tell us from Settings.
        </EmptyPanel>
      );
    }
    return this.props.children;
  }
}
