/**
 * The four readiness parts laid out together. This is the only place that merges private
 * answers into the eligibility result, and it does so in memory on every render: the merged
 * result is passed down for display and never stored or sent.
 */
import { useMemo } from "react";
import type { EligibilityRuleSet } from "@shared/contracts/eligibility";
import type { ReadinessReport } from "@shared/contracts/readiness";
import { EligibilityPart } from "./EligibilityPart";
import { RequirementsPart } from "./RequirementsPart";
import { CompetitivenessPart } from "./CompetitivenessPart";
import { NextActionsPart } from "./NextActionsPart";
import { applyPrivateAnswers, baseResultFromRuleSet, questionsForOpenRules } from "./private-eligibility";
import { confirmationsFor, usePrivateAnswers } from "./private-answers-store";
import { nextActionLimit } from "./readiness-model";
import { Glass, PartHeading, SignInPrompt } from "./primitives";

export interface ReadinessPartsProps {
  readonly report: ReadinessReport;
  readonly ruleSet: EligibilityRuleSet | null;
  readonly officialUrl: string | null;
  readonly today: string;
  readonly sample: boolean;
  readonly variant: "card" | "detail";
  readonly moreHref?: string;
}

export function ReadinessParts({ report, ruleSet, officialUrl, today, sample, variant, moreHref }: ReadinessPartsProps) {
  const { answers, confirmed } = usePrivateAnswers();
  const scope = report.programCycleId;
  const eligibility = useMemo(
    () => applyPrivateAnswers(report.eligibility, ruleSet, answers, confirmationsFor(confirmed, scope)),
    [report.eligibility, ruleSet, answers, confirmed, scope],
  );
  const questions = useMemo(() => questionsForOpenRules(report.eligibility, ruleSet), [report.eligibility, ruleSet]);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-12">
      <div className="xl:col-span-6 grid min-w-0 grid-cols-1">
        <EligibilityPart result={eligibility} questions={questions} officialUrl={officialUrl} scope={scope} />
      </div>
      <div className="xl:col-span-6 grid min-w-0 grid-cols-1">
        <RequirementsPart report={report} today={today} sample={sample} officialUrl={officialUrl} />
      </div>
      <div className="xl:col-span-5 grid min-w-0 grid-cols-1">
        <CompetitivenessPart competitiveness={report.competitiveness} />
      </div>
      <div className="xl:col-span-7 grid min-w-0 grid-cols-1">
        <NextActionsPart
          actions={report.nextActions}
          eligibility={eligibility}
          limit={nextActionLimit(variant)}
          today={today}
          sample={sample}
          moreHref={moreHref}
        />
      </div>
    </div>
  );
}

/**
 * For programs whose readiness the server withholds (status-defined audiences): eligibility is
 * built from the published rule set and checked entirely on this device; the other parts point to
 * the official page, because the server does not link this student to the program.
 */
export function DeviceOnlyReadiness({ ruleSet, programCycleId, officialUrl, today }: { ruleSet: EligibilityRuleSet | null; programCycleId: string; officialUrl: string | null; today: string }) {
  const { answers, confirmed } = usePrivateAnswers();
  const base = useMemo(() => (ruleSet ? baseResultFromRuleSet(ruleSet, today) : null), [ruleSet, today]);
  const eligibility = useMemo(
    () => (base ? applyPrivateAnswers(base, ruleSet, answers, confirmationsFor(confirmed, programCycleId)) : null),
    [base, ruleSet, answers, confirmed, programCycleId],
  );
  const questions = useMemo(() => (base ? questionsForOpenRules(base, ruleSet) : []), [base, ruleSet]);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {eligibility ? (
        <EligibilityPart result={eligibility} questions={questions} officialUrl={officialUrl} scope={programCycleId} mode="withheld" />
      ) : (
        <Glass as="article" className="nvr-panel" aria-labelledby="dev-elig">
          <PartHeading id="dev-elig" title="Can I apply?" part="Part 1 · Eligibility" />
          <p className="nvr-body" style={{ marginTop: 10 }}>
            Novus has not checked this program's rules yet. See the official page.
          </p>
        </Glass>
      )}
      <Glass as="article" className="nvr-panel" aria-labelledby="dev-rest">
        <PartHeading id="dev-rest" title="Requirements, odds and next steps" part="Parts 2 to 4" />
        <p className="nvr-body" style={{ marginTop: 10 }}>
          This program is open only to students with a particular status, so Novus keeps nothing that links you to it. Its checklist and steps stay on
          the official page{officialUrl ? "" : "."}
          {officialUrl ? (
            <>
              :{" "}
              <a className="nvr-link" href={officialUrl} target="_blank" rel="noopener noreferrer">
                open it
              </a>
              .
            </>
          ) : null}
        </p>
      </Glass>
    </div>
  );
}

/**
 * Signed out: the eligibility check still runs, entirely on this device, from the program's
 * public rule set (a student can try a status filter without an account and without sending
 * anything). Parts 2 to 4 use a profile, so they ask the student to sign in.
 */
export function SignedOutReadiness({
  ruleSet,
  programCycleId,
  officialUrl,
  today,
  next,
}: {
  ruleSet: EligibilityRuleSet | null;
  programCycleId: string;
  officialUrl: string | null;
  today: string;
  next: string;
}) {
  const { answers, confirmed } = usePrivateAnswers();
  const base = useMemo(() => (ruleSet ? baseResultFromRuleSet(ruleSet, today) : null), [ruleSet, today]);
  const eligibility = useMemo(
    () => (base ? applyPrivateAnswers(base, ruleSet, answers, confirmationsFor(confirmed, programCycleId)) : null),
    [base, ruleSet, answers, confirmed, programCycleId],
  );
  const questions = useMemo(() => (base ? questionsForOpenRules(base, ruleSet) : []), [base, ruleSet]);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {eligibility ? (
        <EligibilityPart result={eligibility} questions={questions} officialUrl={officialUrl} scope={programCycleId} mode="device" />
      ) : (
        <Glass as="article" className="nvr-panel" aria-labelledby="out-elig">
          <PartHeading id="out-elig" title="Can I apply?" part="Part 1 · Eligibility" />
          <p className="nvr-body" style={{ marginTop: 10 }}>
            Novus has not checked this program's rules yet. See the official page.
          </p>
        </Glass>
      )}
      <div className="grid min-w-0 grid-cols-1 content-start">
        <SignInPrompt
          title="Sign in for parts 2 to 4"
          detail="Your requirements checklist, competitiveness band and next steps use your profile: class year, major, GPA band and institution."
          next={next}
        />
      </div>
    </div>
  );
}
