/**
 * Public outcome numbers for a program, exactly as shared/disclosure released them: banded totals
 * ("5-9", "10-19", rounded to 5 from 20), small cells as "fewer than 10", complements as "not
 * shown", or nothing at all below five counted reports. Plus the band status, which reads
 * "Official base rate only" until every band gate passes.
 *
 * Mount on the program page beside Part 3 (client/src/pages/program/index.tsx):
 *   <OutcomeSummaryPanel slug={slug} />
 * and BandStatusNote inside CompetitivenessPart if wanted:
 *   <BandStatusNote status={summary.bands.status} note={summary.bands.note} />
 */
import { useId } from "react";
import type { OutcomeSummary, OutcomeSummaryBandStatus, OutcomeSummaryCycle, ReleasedTableView } from "@shared/readiness/outcomes";
import { useOutcomeSummary } from "./api";
import { RESULT_LABELS } from "./model";

export const BAND_STATUS_LABELS: Readonly<Record<OutcomeSummaryBandStatus, string>> = {
  official_base_rate_only: "Official base rate only",
  live: "Bands on",
};

const DECISION_LABELS: Readonly<Record<string, string>> = {
  accepted: RESULT_LABELS.admitted,
  declined_offer: RESULT_LABELS.admitted_declined,
  rejected: RESULT_LABELS.not_selected,
  withdrew: "Withdrew",
  no_response: "Never heard back",
};

const STAGE_LABELS: Readonly<Record<string, string>> = {
  submitted: "Applied",
  campus_nominated: "Nominated by campus",
  not_nominated: "Not nominated by campus",
  interview_invited: "Invited to interview",
  interviewed: "Interviewed",
  waitlisted: "Waitlisted",
};

const SUPPRESSION_COPY: Readonly<Record<string, string>> = {
  below_min_total: "Not enough verified reports yet to show anything.",
  held: "Reports for this cycle are paused while Novus checks them.",
  single_category: "Not shown: it could identify someone.",
  unsafe_small_cells: "Not shown: it could identify someone.",
};

export function suppressionText(reason: string): string {
  return SUPPRESSION_COPY[reason] ?? "Not shown, to protect the students who reported.";
}

export function BandStatusNote({ status, note }: { status: OutcomeSummaryBandStatus; note: string }) {
  return (
    <p className="nvr-meta" data-band-status={status}>
      <b style={{ fontWeight: 600 }}>{BAND_STATUS_LABELS[status]}.</b> {note.replace(/^Official base rate only\.\s*/, "")}
    </p>
  );
}

function TableRows({ table, labels, caption }: { table: ReleasedTableView; labels: Readonly<Record<string, string>>; caption: string }) {
  if (table.suppressed) return null;
  return (
    <table className="nvr-rows" style={{ width: "100%", borderCollapse: "collapse" }}>
      <caption className="nvr-label" style={{ textAlign: "left" }}>
        {caption} (total {table.total})
      </caption>
      <tbody>
        {table.cells.map((c) => (
          <tr key={c.key}>
            <th scope="row" style={{ textAlign: "left", fontWeight: 400 }}>
              {labels[c.key] ?? c.key}
            </th>
            <td style={{ textAlign: "right" }}>{c.label}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CycleSummary({ cycle }: { cycle: OutcomeSummaryCycle }) {
  if (cycle.reports.suppressed) {
    return (
      <p className="nvr-body">
        <b style={{ fontWeight: 600 }}>{cycle.cycleKey}:</b> {suppressionText(cycle.reports.reason)}
      </p>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <p className="nvr-body">
        <b style={{ fontWeight: 600 }}>{cycle.cycleKey}:</b> {cycle.reports.total} verified reports.
      </p>
      <TableRows table={cycle.decisions} labels={DECISION_LABELS} caption="Results reported" />
      <TableRows table={cycle.furthestStage} labels={STAGE_LABELS} caption="Furthest step reported" />
      {cycle.timeline.filter((t) => !t.suppressed).length > 0 ? (
        <p className="nvr-meta">
          Decisions reported by month:{" "}
          {cycle.timeline
            .filter((t): t is Extract<ReleasedTableView, { suppressed: false }> => !t.suppressed)
            .map((t) => `${t.period} (${t.total})`)
            .join(", ")}
        </p>
      ) : null}
    </div>
  );
}

export function OutcomeSummaryView({ summary }: { summary: OutcomeSummary }) {
  const headingId = useId();
  return (
    <section className="nvr-panel" aria-labelledby={headingId}>
      <h3 id={headingId} className="nvr-h3">
        What students reported
      </h3>
      {summary.isSample ? (
        <p className="nvr-tag" data-sample="">
          Sample data
        </p>
      ) : null}
      {summary.cycles.length === 0 ? <p className="nvr-body">{suppressionText("below_min_total")}</p> : summary.cycles.map((c) => <CycleSummary key={c.cycleKey} cycle={c} />)}
      <BandStatusNote status={summary.bands.status} note={summary.bands.note} />
      <p className="nvr-meta">Only verified reports count (a school email address or stronger). Totals under five are never shown, and no single report is.</p>
    </section>
  );
}

export function OutcomeSummaryPanel({ slug }: { slug: string }) {
  const summary = useOutcomeSummary(slug);
  if (!summary.data) return null;
  return <OutcomeSummaryView summary={summary.data} />;
}
