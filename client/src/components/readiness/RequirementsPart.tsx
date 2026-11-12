/**
 * Part 2, Requirements: the checklist, naming each gap and the latest date to start it so it is
 * ready by the effective deadline. Ticks save to the student's checklist progress; where the
 * server refuses (status-defined programs without consent) they stay on this device.
 */
import { useId, useMemo, useState } from "react";
import type { ReadinessReport, RequirementState } from "@shared/contracts/readiness";
import { Glass, Icon, PartHeading } from "./primitives";
import { useSaveRequirementProgress } from "./data";
import { checklistSideNote, effectiveDeadlineLine, progressUpdate, readyLine, toggledState, withOverrides } from "./readiness-model";

export interface RequirementsPartProps {
  readonly report: ReadinessReport;
  readonly today: string;
  readonly sample: boolean;
  readonly officialUrl: string | null;
}

export function RequirementsPart({ report, today, sample, officialUrl }: RequirementsPartProps) {
  const headingId = useId();
  const [overrides, setOverrides] = useState<ReadonlyMap<string, RequirementState>>(new Map());
  const [notice, setNotice] = useState("");
  const save = useSaveRequirementProgress(report.programCycleId, sample);
  const items = useMemo(() => withOverrides(report.requirements.items, overrides), [report.requirements.items, overrides]);
  const deadlineLine = effectiveDeadlineLine(report);

  const toggle = (key: string) => {
    const item = items.find((i) => i.key === key);
    if (!item || item.state === "not_applicable") return;
    const next = toggledState(item.state);
    const previous = overrides;
    setOverrides(new Map(overrides).set(key, next));
    save.mutate(progressUpdate(item, next), {
      onSuccess: (outcome) => setNotice(outcome === "saved" ? `Saved: ${item.label}` : `Kept on this device only: ${item.label}`),
      onError: () => {
        setOverrides(previous);
        setNotice(`Could not save ${item.label}. Try again.`);
      },
    });
  };

  return (
    <Glass as="article" className="nvr-panel" aria-labelledby={headingId}>
      <PartHeading id={headingId} title="What you need" part="Part 2 · Requirements" />
      {report.requirements.checked ? (
        <>
          <p className="nvr-meta" style={{ marginTop: 6 }}>
            {readyLine(items)}
          </p>
          <ul className="nvr-checks" aria-label="Requirements checklist">
            {items.map((item) => {
              const note = checklistSideNote(item, today);
              const quantity = item.quantity > 1 && !/\d|two|three|four/i.test(item.label) ? ` (${item.quantity})` : "";
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    className="nvr-check"
                    role="checkbox"
                    aria-checked={item.state === "met"}
                    aria-disabled={item.state === "not_applicable" || undefined}
                    onClick={() => toggle(item.key)}
                  >
                    <span className="nvr-ring" aria-hidden="true">
                      <Icon name="check" className="" />
                    </span>
                    <span className="nvr-lbl">
                      {item.label}
                      {quantity}
                      {item.gap && item.state !== "met" ? <small className="nvr-meta" style={{ display: "block" }}>{item.gap}</small> : null}
                    </span>
                    <span className="nvr-side" data-severity={note.severity ?? undefined}>
                      {note.text}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {deadlineLine ? (
            <p className="nvr-meta" style={{ marginTop: 12 }}>
              {deadlineLine}
            </p>
          ) : null}
        </>
      ) : (
        <p className="nvr-body" style={{ marginTop: 12 }}>
          Requirements not yet checked by Novus.{" "}
          {officialUrl ? (
            <a className="nvr-link" href={officialUrl} target="_blank" rel="noopener noreferrer">
              See the official page
            </a>
          ) : (
            "See the official page."
          )}
        </p>
      )}
      <p className="nvr-sr" role="status" aria-live="polite">
        {notice}
      </p>
    </Glass>
  );
}
