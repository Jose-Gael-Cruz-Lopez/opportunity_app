/** @jsxImportSource hono/jsx */
import { Page, type SiteContext } from "../components/layout";
import { Crumbs } from "../components/collection";
import { formatDate } from "../format";
import {
  accuracyText,
  AUDIT_GRADES,
  AUDIT_PATH,
  AUDIT_PROMPT,
  AUDIT_SCHEDULE,
  AUDIT_STRATA,
  milestoneState,
  plannedPublication,
  totalOf,
  type AuditMilestone,
  type AuditReport,
} from "../audit";
import { breadcrumbJsonLd, metaDescription, reportJsonLd, webPageJsonLd, type PageMeta } from "../seo";
import { todayIso } from "../view-model";

/**
 * The AI deadline-accuracy audit (/research/ai-deadline-audit, and dated editions under it).
 * Before the first report the page publishes the protocol and schedule and shows no results; a
 * report leads with an accessible table (plan s08 8.14), never an image. Assistant accuracy is a
 * fact about assistants, never about a student.
 */

export interface AuditModel {
  /** The edition shown, or null before the first one is published. */
  readonly report: AuditReport | null;
  /** The path rendered (the canonical page or a dated edition). */
  readonly path: string;
  readonly now: number;
}

const SPAN = (m: AuditMilestone): string =>
  m.start === m.end ? formatDate(m.start, { weekday: false }) : `${formatDate(m.start, { weekday: false, year: false })} to ${formatDate(m.end, { weekday: false })}`;

export function auditPageMeta(model: AuditModel, site: SiteContext): PageMeta {
  const { report } = model;
  const title = report ? `${report.title} | Novus` : "How accurate are AI assistants about application deadlines? | Novus";
  const description = metaDescription(
    report
      ? `We asked consumer AI assistants for the deadlines of ${report.sampleSize} programs and scored every answer against the official page. Methods, scored table and Novus's own errors.`
      : `A pre-registered audit of how often consumer AI assistants give students the right application deadline. The first report publishes ${formatDate(plannedPublication(), { weekday: false })}.`,
  );
  const crumbs = [
    { name: "Methods", path: "/methods" },
    { name: "AI deadline audit", path: AUDIT_PATH },
    ...(report && model.path !== AUDIT_PATH ? [{ name: report.id, path: model.path }] : []),
  ];
  const real = !report?.isSample;
  return {
    title,
    description,
    path: model.path,
    indexable: real,
    ogType: report ? "article" : "website",
    jsonLd: real
      ? [
          report
            ? reportJsonLd(site.origin, { title: report.title, description, path: model.path, publishedOn: report.publishedOn })
            : webPageJsonLd(site.origin, { name: "AI deadline-accuracy audit", description, path: model.path }),
          breadcrumbJsonLd(site.origin, crumbs),
        ]
      : [],
  };
}

export function AuditPage(props: { model: AuditModel; site: SiteContext }) {
  const { model, site } = props;
  const { report } = model;
  const today = todayIso(model.now);
  return (
    <Page meta={auditPageMeta(model, site)} site={site} nav="methods" island={false}>
      <section class="dusk" aria-labelledby="au-h">
        <div class="wrap">
          <Crumbs items={[{ name: "Methods", href: "/methods" }, { name: "AI deadline audit" }]} />
          <span class="label kick">Research</span>
          <h1 id="au-h">
            Do AI assistants get the <em>deadline</em> right?
          </h1>
          <p class="lede">
            Students ask chatbots when applications close. We ask them too, by hand, for {report?.sampleSize ?? 50} real program cycles, and
            score every answer against the official page.
          </p>
          {report ? (
            <p class="version label">
              {report.isSample ? "Sample report for this preview · " : ""}Published {formatDate(report.publishedOn, { weekday: false })}
            </p>
          ) : (
            <p class="version label">First report due {formatDate(plannedPublication(), { weekday: false })} · no results yet</p>
          )}
        </div>
      </section>
      <div class="day">
        <div class="wrap prose wide">
          {report ? <Results report={report} /> : <NotYet />}

          <h2 id="protocol">The protocol</h2>
          <p>Everything below is fixed before the first question is asked, and the protocol's hash is published so it cannot change quietly.</p>
          <ul>
            <li>
              <strong>The question</strong>, one phrasing, typed by hand: <q>{AUDIT_PROMPT}</q>
            </li>
            <li>
              <strong>The assistants</strong>: ChatGPT, Gemini and Claude consumer apps on the free tier, default model, web search on where
              offered, fresh accounts with memory off. Each answer is screenshotted.
            </li>
            <li>
              <strong>The sample</strong>: {report?.sampleSize ?? 50} program cycles with deadlines after the run, across six strata. It includes
              at least 10 with a separate campus deadline, 5 that changed since the last cycle and 5 that ended or paused. Results are reported
              per stratum, on this purposive sample, never as an accuracy for all programs.
            </li>
            <li>
              <strong>The ground truth</strong>: two people verify each deadline on the official page independently. Neither is the Curator who
              verified it for Novus, and both record the official value before seeing Novus's.
            </li>
            <li>
              <strong>The Novus arm</strong>: Novus's own published deadlines are scored on the same cycles against the same ground truth, and
              our errors are published beside everyone else's.
            </li>
          </ul>
          <h3 class="sub">Strata</h3>
          <ul class="toc">
            {AUDIT_STRATA.map((s) => (
              <li>
                <span class="chip">{s}</span>
              </li>
            ))}
          </ul>

          <h2 id="scoring">How answers are scored</h2>
          <p>
            Two scorers grade every answer independently from transcripts with the assistant's name and Novus's removed, using a written rubric.
            Their agreement (Cohen's kappa) is reported, and a third person settles disagreements.
          </p>
          <dl class="grades">
            {AUDIT_GRADES.map((g) => (
              <div>
                <dt>{g.label}</dt>
                <dd>{g.rule}</dd>
              </div>
            ))}
          </dl>
          <p>A cited source that does not support the answer is flagged separately, whatever the grade.</p>

          <h2 id="statistics">Statistics</h2>
          <p>
            Each share comes with a Wilson 95% interval: {accuracyText(45, 50)} is the worked example. Paired comparisons use exact McNemar
            tests with a Holm correction. With {report?.sampleSize ?? 50} pairs only large differences are detectable, and the report says so.
          </p>
          <p>
            Novus's own monthly accuracy check (a random sample of published deadlines, re-verified by someone other than the original verifier)
            is reported separately and labelled as such. It is never the audit's ground truth.
          </p>

          <h2 id="schedule">Schedule</h2>
          <ol class="timeline">
            {AUDIT_SCHEDULE.map((m) => {
              const state = milestoneState(m, today);
              return (
                <li class={state}>
                  <span class="label when">{SPAN(m)}</span>
                  <span>
                    <b>{m.label}</b>
                    <span class="sr"> ({state === "done" ? "done" : state === "now" ? "in progress" : "planned"})</span>
                    <span class="note"> {m.detail}</span>
                  </span>
                </li>
              );
            })}
          </ol>

          <h2 id="disclosure">Disclosure</h2>
          <p>
            Novus uses Google's Gemini models through their API for optional plain-language explanations and for drafts a Curator reviews; a
            person approves every deadline on Novus. Gemini is also one of the assistants tested here. Each company sees its own results before publication, and counsel reviews
            every comparative claim.
          </p>
          <p>
            <a class="pill solid" href="/methods">
              How Novus verifies deadlines
            </a>
          </p>
        </div>
      </div>
    </Page>
  );
}

function NotYet() {
  return (
    <>
      <h2 id="results">Results</h2>
      <p class="callout" role="note">
        No results are published yet. The first report, with the scored table, every screenshot and Novus's own errors, is due{" "}
        {formatDate(plannedPublication(), { weekday: false })}. Until then this page shows only the plan.
      </p>
    </>
  );
}

function Results(props: { report: AuditReport }) {
  const { report } = props;
  return (
    <>
      <h2 id="results">Results</h2>
      {report.isSample ? (
        <p class="callout" role="note">
          This is a <strong>sample</strong> report with invented numbers, shown to preview the layout. It describes no real assistant.
        </p>
      ) : null}
      <div class="table-wrap" role="region" aria-labelledby="results-cap" tabindex={0}>
        <table class="data">
          <caption id="results-cap">
            Answers about {report.sampleSize} program cycles, by assistant and arm. Correct answers with a Wilson 95% interval.
          </caption>
          <thead>
            <tr>
              <th scope="col">Assistant</th>
              <th scope="col">Arm</th>
              <th scope="col">Correct</th>
              <th scope="col">Partly correct</th>
              <th scope="col">Incorrect</th>
              <th scope="col">No answer</th>
              <th scope="col">Unsupported source</th>
            </tr>
          </thead>
          <tbody>
            {report.arms.map((arm) => (
              <tr>
                <th scope="row">
                  {arm.assistant}
                  <span class="note"> · {arm.plan}, {arm.modelLabel}</span>
                </th>
                <td>{arm.arm}</td>
                <td>{accuracyText(arm.correct, totalOf(arm))}</td>
                <td>{arm.partlyCorrect}</td>
                <td>{arm.incorrect}</td>
                <td>{arm.noAnswer}</td>
                <td>{arm.unsupportedCitations}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {report.kappa !== null ? <p class="note">Agreement between the two scorers: Cohen's kappa {report.kappa.toFixed(2)}.</p> : null}
      {report.pooledNovusAccuracy ? (
        <p>
          Separately, Novus's monthly random-sample check ({report.pooledNovusAccuracy.window}):{" "}
          {accuracyText(report.pooledNovusAccuracy.correct, report.pooledNovusAccuracy.n)} published deadlines correct.
        </p>
      ) : null}
      {report.limitations.length ? (
        <>
          <h3 class="sub">Limitations</h3>
          <ul>
            {report.limitations.map((l) => (
              <li>{l}</li>
            ))}
          </ul>
        </>
      ) : null}
      {report.evidenceUrl ? (
        <p>
          <a class="linkish" href={report.evidenceUrl}>
            Screenshots, raw answers and grades
          </a>
        </p>
      ) : null}
    </>
  );
}
