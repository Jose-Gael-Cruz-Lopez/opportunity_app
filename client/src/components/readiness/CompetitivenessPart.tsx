/**
 * Part 3, Competitiveness: a band relative to the program's usual rate when every gate passes,
 * otherwise the program's official selection numbers or "Not enough outcomes yet" with the
 * reason. Never a score, a percentage or a chance about the student.
 */
import { useId } from "react";
import type { Competitiveness } from "@shared/contracts/readiness";
import {
  BAND_EXPLAINERS,
  BAND_LABELS,
  COMPETITIVENESS_HEADLINES,
  INSUFFICIENT_REASON_COPY,
  describeStageOdds,
  hostOf,
} from "./format";
import { Glass, Icon, PartHeading } from "./primitives";

const SCALE = ["below_typical", "typical", "above_typical"] as const;
const DIRECTION_WORDS = { helps: "Helps", hurts: "Works against", neutral: "Neutral" } as const;

function StageOddsList({ c }: { c: Competitiveness }) {
  if (c.basis.stageOdds.length === 0) return null;
  return (
    <ul className="nvr-odds" aria-label="Official selection numbers">
      {c.basis.stageOdds.map((o) => {
        const v = describeStageOdds(o, c.basis.currentStage);
        return (
          <li key={v.key} data-current={v.current ? "" : undefined}>
            <b style={{ fontWeight: 600 }}>{v.headline}</b> <span className="nvr-meta">({v.year})</span>
            <span className="nvr-body" style={{ display: "block" }}>
              {v.natural}
              {v.current ? " · the stage you would enter" : ""}
            </span>
            <span className="nvr-meta" style={{ display: "block", marginTop: 4 }}>
              <a className="nvr-link" href={v.sourceUrl} target="_blank" rel="noopener noreferrer">
                {hostOf(v.sourceUrl)}
              </a>{" "}
              · {v.verified}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function CompetitivenessPart({ competitiveness: c }: { competitiveness: Competitiveness }) {
  const headingId = useId();
  return (
    <Glass as="article" className="nvr-panel" aria-labelledby={headingId}>
      <PartHeading id={headingId} title="How competitive" part="Part 3 · Competitiveness" />
      <p className="nvr-label" style={{ marginTop: 10 }}>
        {COMPETITIVENESS_HEADLINES[c.status]}
      </p>

      {c.status === "available" && c.band ? (
        <>
          {c.band === "same_for_everyone" ? (
            <p className="nvr-h3" style={{ marginTop: 10 }}>
              {BAND_LABELS.same_for_everyone}
            </p>
          ) : (
            <div className="nvr-band" role="img" aria-label={`Band: ${BAND_LABELS[c.band]}, on a scale of below typical, typical and above typical`}>
              {SCALE.map((b) => (
                <span key={b} data-on={b === c.band ? "" : undefined} aria-hidden="true">
                  {BAND_LABELS[b]}
                </span>
              ))}
            </div>
          )}
          <p className="nvr-body" style={{ marginTop: 12 }}>
            {BAND_EXPLAINERS[c.band]}
          </p>
          {c.basis.factors.length > 0 ? (
            <ul className="nvr-rows" aria-label="What the band rests on">
              {c.basis.factors.map((f) => (
                <li key={f.code} className="nvr-row" style={{ gridTemplateColumns: "auto minmax(0,1fr)" }}>
                  <span className="nvr-label">{DIRECTION_WORDS[f.direction]}</span>
                  <span>{f.label}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {c.status === "insufficient_data" ? (
        <div style={{ marginTop: 12 }}>
          <p className="nvr-body">
            {INSUFFICIENT_REASON_COPY[c.reason ?? ""] ?? "Not enough outcomes have been reported yet."}
          </p>
        </div>
      ) : null}

      {c.status === "not_applicable" ? (
        <p className="nvr-body" style={{ marginTop: 10 }}>
          Everyone who meets the rules and applies on time can take part, or places go first come, first served.
        </p>
      ) : null}

      <StageOddsList c={c} />

      <p className="nvr-body" style={{ marginTop: 12 }}>
        {c.basis.summary}
      </p>
      {c.basis.reportsBanded ? (
        <p className="nvr-meta" style={{ marginTop: 8 }}>
          Outcomes reported to Novus: {c.basis.reportsBanded}.
        </p>
      ) : null}
      <p className="nvr-meta" style={{ marginTop: "auto", paddingTop: 14, display: "flex", gap: 8, alignItems: "center" }}>
        <Icon name="info" />
        <span>
          Program-level numbers only, never a score about you.
          {c.basis.methodologyUrl ? (
            <>
              {" "}
              <a className="nvr-link" href={c.basis.methodologyUrl} target="_blank" rel="noopener noreferrer">
                How this works
              </a>
            </>
          ) : null}
        </span>
      </p>
    </Glass>
  );
}
