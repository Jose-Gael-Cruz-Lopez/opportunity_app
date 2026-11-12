/**
 * Part 1, Eligibility: each rule with its verdict, the official wording and a reason. Rules about
 * citizenship, Pell, first-generation status or identity are answered privately: the answers live
 * in the in-memory store and are evaluated in this browser; nothing about them leaves the page.
 */
import { useId, useState } from "react";
import type { EligibilityResult, EligibilityRuleResult } from "@shared/contracts/eligibility";
import { PRODUCT } from "@shared/config/product";
import { ELIGIBILITY_STATUS_LABELS, VERDICT_MARKS } from "./format";
import { Glass, Icon, PartHeading } from "./primitives";
import { answerFor, type PrivateQuestion } from "./private-eligibility";
import { confirmationKey, usePrivateAnswers } from "./private-answers-store";
import { orderedRules } from "./readiness-model";

function VerdictMark({ verdict }: { verdict: EligibilityRuleResult["verdict"] }) {
  const mark = VERDICT_MARKS[verdict];
  return (
    <span className="nvr-mk" data-verdict={verdict}>
      {verdict === "met" ? <Icon name="check" /> : verdict === "not_met" ? <Icon name="x" /> : <span aria-hidden="true">?</span>}
      <span className="nvr-sr">{mark.label}:</span>
    </span>
  );
}

function PrivateQuestionField({ q }: { q: PrivateQuestion }) {
  const { answers, setAnswer } = usePrivateAnswers();
  const name = useId();
  const raw = answerFor(answers, q.field);
  const selected = new Set(Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)]);

  const onToggle = (value: string, checked: boolean) => {
    if (!q.multiple) return setAnswer(q.field, value);
    // "Prefer not to say" excludes the other choices, and choosing one clears it.
    let next = new Set(selected);
    if (value === "prefer_not") next = checked ? new Set(["prefer_not"]) : new Set();
    else {
      next.delete("prefer_not");
      if (checked) next.add(value);
      else next.delete(value);
    }
    setAnswer(q.field, next.size ? [...next] : undefined);
  };

  return (
    <fieldset>
      <legend>{q.prompt}</legend>
      <div className="nvr-opts">
        {q.options.map((o) => {
          const checked = selected.has(o.value);
          return (
            <label key={o.value} className="nvr-choice" data-checked={checked ? "" : undefined}>
              <input
                type={q.multiple ? "checkbox" : "radio"}
                name={name}
                value={o.value}
                checked={checked}
                onChange={(e) => onToggle(o.value, e.currentTarget.checked)}
              />
              {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export interface EligibilityPartProps {
  readonly result: EligibilityResult;
  readonly questions: readonly PrivateQuestion[];
  readonly officialUrl: string | null;
  /** The program cycle these confirmations belong to. */
  readonly scope: string;
  /** "withheld": the server keeps no readiness for this program, so every rule is a self-check. */
  /** server: the report's result. withheld or device: built from the public rule set, checked here. */
  readonly mode?: "server" | "withheld" | "device";
}

export function EligibilityPart({ result, questions, officialUrl, scope, mode = "server" }: EligibilityPartProps) {
  const headingId = useId();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const { confirmed, setConfirmed, clear, answers } = usePrivateAnswers();
  const hasAnswers = Object.keys(answers).length > 0;
  // Items the student can confirm on the device: attestations, and non-sensitive rules left open
  // (sensitive ones are answered through the private questions instead).
  const studentChecks = result.pending.filter((p) => p.resolver === "student" && (p.kind === "attestation" || (p.kind === "rule" && !p.sensitive)));
  const novusChecks = result.pending.filter((p) => p.resolver === "novus");

  return (
    <Glass as="article" className="nvr-panel" aria-labelledby={headingId}>
      <PartHeading id={headingId} title="Can I apply?" part="Part 1 · Eligibility" />
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
        <span className="nvr-status" data-status={result.status}>
          {ELIGIBILITY_STATUS_LABELS[result.status]}
        </span>
        <span className="nvr-meta">
          {mode === "withheld"
            ? "Checked on this device only for this program."
            : mode === "device"
              ? "Checked on this device from the official rules. No account needed, nothing sent."
              : "Each rule comes from the official page."}
        </span>
      </div>

      <ul className="nvr-rows" aria-label="Eligibility rules">
        {orderedRules(result).map((r) => (
          <li key={r.ruleId} className="nvr-row" id={`rule-${r.ruleId}`}>
            <VerdictMark verdict={r.verdict} />
            <span>
              {r.officialText}
              <small>{r.reason}</small>
            </span>
            {r.sensitive && questions.length > 0 ? (
              <button type="button" className="nvr-mini" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((v) => !v)}>
                <Icon name="lock" className="nvr-icon" />
                {r.verdict === "unknown" ? "Answer privately" : "Change"}
              </button>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ul>

      {questions.length > 0 ? (
        <div className="nvr-private" id={panelId} hidden={!open}>
          {questions.map((q) => (
            <PrivateQuestionField key={q.field} q={q} />
          ))}
          <p className="nvr-lock">
            <Icon name="lock" />
            <span>
              These answers stay in this browser tab. Novus does not send, store or log them, and they clear after {PRODUCT.sensitiveIdleClearMinutes} minutes
              or when you close the tab.
            </span>
          </p>
          {hasAnswers ? (
            <button type="button" className="nvr-mini" style={{ alignSelf: "flex-start" }} onClick={clear}>
              Clear my private answers
            </button>
          ) : null}
        </div>
      ) : null}

      {studentChecks.length > 0 ? (
        <div style={{ marginTop: 14 }}>
          <p className="nvr-label">Confirm against the official wording</p>
          <ul className="nvr-rows">
            {studentChecks.map((p) => {
              const isOn = confirmed.has(confirmationKey(scope, p.id));
              return (
                <li key={p.id} className="nvr-row">
                  <span className="nvr-mk" data-verdict={isOn ? "met" : "unknown"} aria-hidden="true">
                    {isOn ? <Icon name="check" /> : "?"}
                  </span>
                  <span>{p.selfCheckText}</span>
                  <button type="button" className="nvr-mini" role="checkbox" aria-checked={isOn} onClick={() => setConfirmed(confirmationKey(scope, p.id), !isOn)}>
                    {isOn ? "Confirmed" : "I meet this"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {novusChecks.length > 0 ? (
        <p className="nvr-body" style={{ marginTop: 14 }}>
          Novus has not checked {novusChecks.length === 1 ? "one rule" : `${novusChecks.length} rules`} yet.{" "}
          {officialUrl ? (
            <a className="nvr-link" href={officialUrl} target="_blank" rel="noopener noreferrer">
              See the official page
            </a>
          ) : (
            "See the official page."
          )}
        </p>
      ) : null}

      {result.nomination ? (
        <p className="nvr-body" style={{ marginTop: 12 }}>
          Your campus nominates for this program. Ask your fellowship or scholarships office about its internal deadline.
        </p>
      ) : null}
      {result.basedOnListedRequirements ? (
        <p className="nvr-meta" style={{ marginTop: 10 }}>
          Based on the requirements the program lists; some rules are not stated on its page.
        </p>
      ) : null}
    </Glass>
  );
}
