/**
 * The readiness assistant: asks Gemini (through the Worker's /me/readiness/:id/explain route) to
 * explain the four parts in plain words, citing the program's sources. It explains; it never
 * decides. The request carries a focus and an optional question only, never a private answer,
 * and with no assistant available the screen shows a summary built from the report itself.
 */
import { useId, useState, type FormEvent } from "react";
import type { ReadinessExplainResponse } from "@shared/contracts/ai";
import type { ReadinessReport } from "@shared/contracts/readiness";
import { PRODUCT } from "@shared/config/product";
import { useExplainReadiness } from "./data";
import { Glass, Icon, PartHeading } from "./primitives";
import { hostOf } from "./format";
import { questionLooksPrivate } from "./readiness-model";

const PART_TITLES = {
  eligibility: "Eligibility",
  requirements: "Requirements",
  competitiveness: "Competitiveness",
  next_actions: "Next actions",
} as const;

function ExplanationView({ data }: { data: ReadinessExplainResponse }) {
  const cited = new Map(data.citations.map((c) => [c.sourceId, c]));
  const refs = (ids: readonly string[]) =>
    ids.length === 0 ? null : (
      <span className="nvr-meta">
        {" "}
        [{ids.map((id) => (cited.get(id) ? id : null)).filter(Boolean).join(", ")}]
      </span>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 14 }}>
      <p>{data.summary}</p>
      {data.points.length > 0 ? (
        <ul className="nvr-rows" style={{ marginTop: 0 }}>
          {data.points.map((p, i) => (
            <li key={i} className="nvr-row" style={{ gridTemplateColumns: "minmax(0,1fr)" }}>
              <span>
                <span className="nvr-label">{PART_TITLES[p.part]}</span>
                <span style={{ display: "block", marginTop: 4 }}>
                  {p.text}
                  {refs(p.sourceIds)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {data.suggestions.length > 0 ? (
        <div>
          <p className="nvr-label">Suggestions</p>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }} className="nvr-body">
            {data.suggestions.map((s, i) => (
              <li key={i}>
                {s.text}
                {refs(s.sourceIds)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {data.citations.length > 0 ? (
        <div>
          <p className="nvr-label">Sources</p>
          <ul className="nvr-rows" style={{ marginTop: 6 }}>
            {data.citations.map((c) => (
              <li key={c.sourceId} className="nvr-row" style={{ gridTemplateColumns: "auto minmax(0,1fr)" }}>
                <span className="nvr-meta">{c.sourceId}</span>
                <span>
                  {c.url ? (
                    <a className="nvr-link" href={c.url} target="_blank" rel="noopener noreferrer">
                      {c.title}
                    </a>
                  ) : (
                    c.title
                  )}
                  {c.url ? <small>{hostOf(c.url)}</small> : null}
                  {c.quote ? <small>“{c.quote}”</small> : null}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {data.caveats.map((c, i) => (
        <p key={i} className="nvr-meta">
          {c}
        </p>
      ))}
      <p className="nvr-meta">
        {data.meta.fallback
          ? "Written from your report without the assistant."
          : `Written by ${data.meta.model ?? "the assistant"} from your report and the program's sources. It can be wrong: check dates on the official page.`}
      </p>
    </div>
  );
}

export function ReadinessAssistant({ report, sample }: { report: ReadinessReport; sample: boolean }) {
  const headingId = useId();
  const inputId = useId();
  const [question, setQuestion] = useState("");
  const [warning, setWarning] = useState("");
  const explain = useExplainReadiness(report, sample);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (q && questionLooksPrivate(q)) {
      setWarning("Please leave out status or identity details. Those answers stay on your device, and the assistant does not need them.");
      return;
    }
    setWarning("");
    explain.mutate({ focus: "overview", question: q || null });
  };

  return (
    <Glass as="section" className="nvr-panel" aria-labelledby={headingId}>
      <PartHeading id={headingId} title="Explain my readiness" part="Assistant" level={2} />
      <p className="nvr-body" style={{ marginTop: 6 }}>
        A plain-language walk through the four parts above, with links to the program's sources. The assistant explains; the parts above are
        decided by fixed rules.
      </p>
      <form onSubmit={submit} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <label htmlFor={inputId} className="nvr-sr">
          Optional question
        </label>
        <input
          id={inputId}
          className="nvr-input"
          style={{ flex: "1 1 240px", minHeight: 46, borderRadius: 999, padding: "0 16px" }}
          placeholder="Optional: ask about a part, e.g. when should I ask for letters?"
          maxLength={PRODUCT.ai.maxPromptChars}
          value={question}
          onChange={(e) => setQuestion(e.currentTarget.value)}
          aria-describedby={warning ? `${inputId}-warn` : undefined}
        />
        <button type="submit" className="nvr-btn" disabled={explain.isPending}>
          <Icon name="spark" />
          {explain.isPending ? "Explaining..." : "Explain"}
        </button>
      </form>
      {warning ? (
        <p id={`${inputId}-warn`} className="nvr-banner" role="alert" style={{ marginTop: 10 }}>
          {warning}
        </p>
      ) : null}
      {explain.isError ? (
        <p className="nvr-banner" data-tone="error" role="alert" style={{ marginTop: 10 }}>
          The assistant could not answer just now. Your four parts above are unaffected.
        </p>
      ) : null}
      <div aria-live="polite">{explain.data ? <ExplanationView data={explain.data} /> : null}</div>
    </Glass>
  );
}
