import { Link } from "wouter";
import { appPaths } from "@/lib/routes";

/**
 * The buttons every empty or failed screen ends with, so no screen is a dead end: take back the
 * last answer, drop the strict preferences (paid only, remote, timing, location) and filters,
 * try again, or browse Explore. Each is shown only when the caller can do it.
 */
export function WayForward({
  onEditAnswers,
  onWiden,
  onRetry,
  onSeeAll,
}: {
  onEditAnswers?: () => void;
  onWiden?: () => void;
  onRetry?: () => void;
  onSeeAll?: () => void;
}) {
  return (
    <div className="st-actions">
      {onRetry && (
        <button type="button" className="st-btn st-btn-cream" onClick={onRetry}>
          Try again
        </button>
      )}
      {onWiden && (
        <button type="button" className="st-btn st-btn-cream" onClick={onWiden}>
          Widen my search
        </button>
      )}
      {onSeeAll && (
        <button type="button" className="st-btn" onClick={onSeeAll}>
          See all my matches
        </button>
      )}
      {onEditAnswers && (
        <button type="button" className="st-btn st-btn-ghost" onClick={onEditAnswers}>
          Change my answers
        </button>
      )}
      <Link className="st-btn st-btn-ghost" href={appPaths.explore}>
        Browse Explore
      </Link>
    </div>
  );
}
