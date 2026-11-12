/**
 * Part 4, Next actions: dated steps sorted by slack, each linked to a Roadmap item where one
 * exists. "Add to Roadmap" pins that item so the Roadmap keeps it in its term.
 */
import { useId, useState } from "react";
import { Link } from "wouter";
import type { EligibilityResult } from "@shared/contracts/eligibility";
import type { NextAction } from "@shared/contracts/readiness";
import { formatShortDate, SEVERITY_LABELS } from "./format";
import { Glass, Icon, PartHeading, appHref } from "./primitives";
import { useRoadmapAction } from "./data";
import { severityOn, visibleNextActions } from "./readiness-model";

export interface NextActionsPartProps {
  readonly actions: readonly NextAction[];
  readonly eligibility: EligibilityResult;
  readonly limit: number;
  readonly today: string;
  readonly sample: boolean;
  /** Shown under the list on cards: a link to the full Readiness view. */
  readonly moreHref?: string;
}

export function NextActionsPart({ actions, eligibility, limit, today, sample, moreHref }: NextActionsPartProps) {
  const headingId = useId();
  const roadmap = useRoadmapAction(sample);
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState("");
  const shown = visibleNextActions(actions, eligibility, limit);

  const add = (a: NextAction) => {
    if (!a.roadmapItemKey) return;
    const key = a.roadmapItemKey;
    roadmap.mutate(
      { itemKey: key, action: "pin" },
      {
        onSuccess: () => {
          setAdded((prev) => new Set(prev).add(key));
          setNotice(`Added to your Roadmap: ${a.label}`);
        },
        onError: () => setNotice(`Could not add "${a.label}" to your Roadmap. Try again.`),
      },
    );
  };

  return (
    <Glass as="article" className="nvr-panel" aria-labelledby={headingId}>
      <PartHeading id={headingId} title="Next steps" part="Part 4 · Next actions" />
      {shown.length === 0 ? (
        <p className="nvr-body" style={{ marginTop: 12 }}>
          Nothing to do right now. Novus will add steps here when a date gets close.
        </p>
      ) : (
        <ol className="nvr-steps" aria-label="Next actions">
          {shown.map((a) => {
            const severity = a.dueOn ? severityOn(a.dueOn, today) ?? a.severity : a.severity;
            const isAdded = a.roadmapItemKey ? added.has(a.roadmapItemKey) : false;
            return (
              <li key={a.id}>
                <span className="nvr-meta" data-severity={severity ?? undefined}>
                  {a.dueOn ? formatShortDate(a.dueOn) : "Any time"}
                  {severity === "late" || severity === "soon" ? <span style={{ display: "block" }}>{SEVERITY_LABELS[severity]}</span> : null}
                </span>
                <span>
                  {a.label}
                  {a.detail ? <span className="nvr-meta" style={{ display: "block", marginTop: 2 }}>{a.detail}</span> : null}
                </span>
                {a.roadmapItemKey ? (
                  <button
                    type="button"
                    className="nvr-mini"
                    aria-pressed={isAdded}
                    disabled={isAdded || roadmap.isPending}
                    onClick={() => add(a)}
                  >
                    <Icon name={isAdded ? "check" : "map"} />
                    {isAdded ? "On Roadmap" : "Add to Roadmap"}
                  </button>
                ) : (
                  <span />
                )}
              </li>
            );
          })}
        </ol>
      )}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: "auto", paddingTop: 16 }}>
        <Link href={appHref("/roadmap")} className="nvr-btn">
          <Icon name="map" />
          Open Roadmap
        </Link>
        {moreHref ? (
          <Link href={moreHref} className="nvr-btn">
            Full readiness
            <Icon name="chev" />
          </Link>
        ) : null}
      </div>
      <p className="nvr-sr" role="status" aria-live="polite">
        {notice}
      </p>
    </Glass>
  );
}
