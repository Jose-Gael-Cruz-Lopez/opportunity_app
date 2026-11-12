/** @jsxImportSource hono/jsx */
import type { ProgramDetail } from "@shared/contracts";
import { OPPORTUNITY_GROUP_LABELS } from "@shared/taxonomy";
import type { CycleHistoryEntry } from "../data";
import { daysBetween } from "@shared/time";
import { formatDate, formatMonth } from "../format";
import { Icon, Page, type SiteContext } from "../components/layout";
import { RemindMeIsland } from "../islands";
import { DaysLeft, DeadlineWhen, SampleTag, StatusChip, VerificationLine, WindowRuler } from "../components/ui";
import { breadcrumbJsonLd, programDescription, programJsonLd, programTitle, type PageMeta } from "../seo";
import {
  collectSources,
  compensationText,
  costText,
  describeDeadline,
  describeRequirements,
  describeStatus,
  describeVerification,
  groupOf,
  nextDeadline,
  sortDeadlines,
  STATUS_LABELS,
  summarizeEligibility,
  templateSummary,
  todayIso,
  typeLabels,
  type DeadlineDisplay,
  type EligibilitySummary,
} from "../view-model";

/**
 * Program page (/programs/{slug}): status, countdown, the deadline in its source zone and the
 * viewer's, who verified it and when, the eligibility rules with "Answer privately", requirements,
 * key dates, cycle history, sources and the official apply link. Complete without JavaScript.
 */

export interface ProgramPageModel {
  readonly detail: ProgramDetail;
  readonly history: readonly CycleHistoryEntry[];
  readonly now: number;
}

export function programPageMeta(model: ProgramPageModel, site: SiteContext): PageMeta {
  const { detail, now } = model;
  const cardish = {
    name: detail.program.name,
    organizationName: detail.organization.name,
    opportunityTypes: detail.program.opportunityTypes,
    classYears: [],
  };
  const next = nextDeadline({ deadlines: detail.deadlines }, now);
  const summary = detail.program.summary ?? templateSummary(cardish, next);
  const path = `/programs/${detail.program.slug}`;
  const group = OPPORTUNITY_GROUP_LABELS[groupOf(detail.program.opportunityTypes[0] ?? "")];
  const jsonLd = detail.program.isSample
    ? []
    : [
        programJsonLd(site.origin, detail, summary, next?.jsonLdDate ?? null),
        breadcrumbJsonLd(site.origin, [
          { name: "Explore", path: "/explore" },
          { name: group, path: `/explore?group=${groupOf(detail.program.opportunityTypes[0] ?? "")}` },
          { name: detail.program.name, path },
        ]),
      ];
  return {
    title: programTitle(detail.program.name, detail.cycle.termLabel),
    description: programDescription(cardish, summary),
    path,
    // Sample records and unpublished drafts are never indexed.
    indexable: !detail.program.isSample && detail.program.isPublished,
    ogType: "article",
    jsonLd,
  };
}

/** True when the next national deadline is within 14 days (the last-good copy then lives a day). */
export function deadlineSoon(model: ProgramPageModel): boolean {
  const next = nextDeadline({ deadlines: model.detail.deadlines }, model.now);
  return next?.daysLeft !== null && next?.daysLeft !== undefined && next.daysLeft <= 14;
}

export function ProgramPage(props: { model: ProgramPageModel; site: SiteContext }) {
  const { model, site } = props;
  return (
    <Page meta={programPageMeta(model, site)} site={site} nav="explore">
      <ProgramBody model={model} />
    </Page>
  );
}

function ProgramBody(props: { model: ProgramPageModel }) {
  const { detail, now } = props.model;
  const { program, organization, cycle } = detail;
  const next = nextDeadline({ deadlines: detail.deadlines }, now);
  const status = describeStatus(cycle.status, next);
  const today = todayIso(now);
  const verification = describeVerification(
    {
      state: detail.citation.verificationState,
      verifiedOn: detail.citation.lastVerifiedAt,
      verifiedBy: detail.citation.verifiedBy,
      freshness: detail.citation.freshness,
    },
    today,
  );
  const cardish = { name: program.name, organizationName: organization.name, opportunityTypes: program.opportunityTypes, classYears: [] };
  const summary = program.summary ?? templateSummary(cardish, next);
  const group = groupOf(program.opportunityTypes[0] ?? "");
  const eligibility = summarizeEligibility(detail.ruleSet);
  const pay = compensationText(cycle.compensation);
  const applyHref = `/out/${cycle.id}`;
  const nominated = Boolean(detail.ruleSet?.nomination) || detail.requirements.some((r) => r.kind === "campus_nomination");

  return (
    <>
      <section class="dusk" aria-labelledby="prog-name">
        <div class="wrap">
          <nav aria-label="Breadcrumb" class="crumbs label">
            <ol>
              <li>
                <a href="/explore">Explore</a>
              </li>
              <li>
                <a href={`/explore?group=${group}`}>{OPPORTUNITY_GROUP_LABELS[group]}</a>
              </li>
              <li aria-current="page">{program.name}</li>
            </ol>
          </nav>
          <div class="prog-hero">
            <article class="panel">
              <div class="tags">
                <StatusChip status={status} />
                {typeLabels(program.opportunityTypes).map((t) => (
                  <span class="chip">{t}</span>
                ))}
                <span class="chip">{cycle.termLabel}</span>
                {program.isSample ? <SampleTag /> : null}
              </div>
              <h1 id="prog-name">{program.name}</h1>
              <p class="org">
                <a class="linkish" href={`/orgs/${organization.slug}`}>
                  {organization.name}
                </a>
                {organization.isSample && !/sample|example/i.test(organization.name) ? " (sample organization)" : ""}
              </p>
              <p class="summary">{summary}</p>
              <VerificationLine line={verification} />
              {detail.citation.evidenceUrl ? (
                <p class="ver">
                  <Icon name="doc" />
                  <span>
                    <a class="linkish" href={detail.citation.evidenceUrl} rel="noopener nofollow">
                      Where this was read
                    </a>
                    {detail.citation.evidenceExcerpt ? `: “${detail.citation.evidenceExcerpt}”` : ""}
                  </span>
                </p>
              ) : null}
              <dl class="facts">
                <div class="fact">
                  <dt class="label">Pay</dt>
                  <dd>{pay ?? "Not stated"}</dd>
                </div>
                <div class="fact">
                  <dt class="label">Cost</dt>
                  <dd>{costText(cycle)}</dd>
                </div>
                {cycle.opensOn ? (
                  <div class="fact">
                    <dt class="label">Opens</dt>
                    <dd>{formatDate(cycle.opensOn, { weekday: false })}</dd>
                  </div>
                ) : null}
              </dl>
              <div class="actions">
                <a class="pill solid" href={applyHref} rel="nofollow">
                  Apply on the official site <Icon name="out" />
                </a>
                <a class="pill" href={`/app/programs/${program.slug}?track=1`} data-island="track" data-cycle={cycle.id}>
                  <Icon name="track" /> Track
                </a>
                <a class="pill" href={`/cal/p/${program.slug}.ics`}>
                  <Icon name="clock" /> Add to calendar
                </a>
              </div>
            </article>
            <CountdownPanel next={next} detail={detail} now={now} />
          </div>
        </div>
      </section>

      <div class="day">
        <div class="wrap cols">
          <div>
            {nominated ? (
              <div class="callout warn" role="note">
                <strong>Campus deadline first.</strong> Campus deadlines for this program come weeks before the national one and may already
                have passed: contact your fellowship office today.
              </div>
            ) : null}
            <EligibilitySection slug={program.slug} summary={eligibility} sensitiveAudience={program.sensitiveAudience} />
            <RequirementsSection detail={detail} now={now} />
            <KeyDatesSection detail={detail} now={now} />
            <HistorySection history={props.model.history} current={cycle.termLabel} />
          </div>
          <aside aria-label="Sources and corrections">
            <SourcesSection detail={detail} />
            {cycle.status !== "ended" && cycle.status !== "paused" ? (
              <RemindMeIsland
                cycleId={cycle.id}
                programSlug={program.slug}
                restricted={program.sensitiveAudience || program.identityAudience.length > 0}
                now={now}
              />
            ) : null}
            <section class="section" aria-labelledby="report-h">
              <h2 id="report-h">See something wrong?</h2>
              <p>
                Tell us which fact is wrong and where the official page says otherwise. Nothing public changes until a person checks it.
              </p>
              <div class="actions" data-island="report-error" data-slug={program.slug}>
                <a class="pill" href={`/app/programs/${program.slug}#report`}>
                  Report an error
                </a>
              </div>
              {cycle.pellDisplacement === "yes" || cycle.pellDisplacement === "possible" ? (
                <p class="note">This award may change other financial aid you receive. Your financial aid office can tell you how.</p>
              ) : null}
              <p class="cite">
                Record {detail.citation.recordVersion} · {STATUS_LABELS[cycle.status]} · {detail.citation.freshness} · {detail.citation.license}
              </p>
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}

function CountdownPanel(props: { next: DeadlineDisplay | null; detail: ProgramDetail; now: number }) {
  const { next, detail } = props;
  const cycle = detail.cycle;
  if (cycle.status === "paused" || cycle.status === "ended") {
    return (
      <aside class="panel countdown" aria-label="Status">
        <p class="eyebrow label">{STATUS_LABELS[cycle.status]}</p>
        <p class="when">This program is not taking applications. Similar programs that are open now are on Explore.</p>
        <a class="pill" href={`/explore?group=${groupOf(detail.program.opportunityTypes[0] ?? "")}&status=open`}>
          See open programs
        </a>
      </aside>
    );
  }
  if (!next) {
    return (
      <aside class="panel countdown" aria-label="Next deadline">
        <p class="eyebrow label">Next deadline</p>
        <p class="when">No dates published yet. We add them as soon as the official page does.</p>
      </aside>
    );
  }
  const eyebrow = next.passed ? `${next.kindLabel} deadline passed` : next.predicted ? `${next.kindLabel} expected` : `${next.kindLabel} closes in`;
  const span = windowSpan(cycle.opensOn, next.listDate, props.now);
  return (
    <aside class="panel countdown" aria-label="Next deadline">
      <p class="eyebrow label">{eyebrow}</p>
      {next.daysLeft !== null && !next.predicted ? (
        <p class="big">
          <DaysLeft d={next} />
        </p>
      ) : null}
      <div>
        <p class="when">
          <DeadlineWhen d={next} />
        </p>
        {next.advice ? <p class="advice">{next.advice}</p> : null}
        {next.basisNote ? <p class="local">{next.basisNote}</p> : null}
      </div>
      {span !== null && cycle.opensOn && next.listDate ? (
        <div>
          <WindowRuler fraction={span.fraction} label={`Day ${span.day} of a ${span.total}-day application window`} />
          <div class="ends">
            <span>Opened {formatDate(cycle.opensOn, { weekday: false, year: false })}</span>
            <span>Due {formatDate(next.listDate, { weekday: false, year: false })}</span>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

/**
 * Where today sits inside [opensOn, deadline], as a day count (never a percentage, which reads
 * like a score), or null when either end is unknown, month-only or reversed.
 */
export function windowSpan(opensOn: string | null, due: string | null, now: number): { fraction: number; day: number; total: number } | null {
  if (!opensOn || !due || due.length !== 10) return null;
  const total = daysBetween(opensOn, due);
  if (total <= 0) return null;
  const day = Math.min(total, Math.max(0, daysBetween(opensOn, todayIso(now))));
  return { fraction: day / total, day, total };
}

function EligibilitySection(props: { slug: string; summary: EligibilitySummary | null; sensitiveAudience: boolean }) {
  const { summary } = props;
  return (
    <section class="section" aria-labelledby="elig-h" id="eligibility">
      <div class="section-head">
        <h2 id="elig-h">Can I apply?</h2>
        {summary ? <span class="chip">Eligible if…</span> : null}
      </div>
      {!summary ? (
        <p>Novus hasn't checked this program's rules yet: see the official page.</p>
      ) : (
        <>
          {summary.fromCycleKey ? <p class="note">These rules come from the {summary.fromCycleKey} cycle and may change.</p> : null}
          {summary.groups.map((group) => (
            <>
              {group.label ? <h3 class="group-label">{group.label}</h3> : null}
              <ul class="rules">
                {group.rules.map((rule) => (
                  <li>
                    <span class={rule.sensitive ? "mk lock" : "mk"} aria-hidden="true">
                      {rule.sensitive ? <Icon name="lock" /> : "?"}
                    </span>
                    <span class="rule-text">
                      <span>{rule.text}</span>
                      {rule.evidence?.quote ? (
                        <span class="quote">
                          Official text: “{rule.evidence.quote}”{" "}
                          <a class="linkish" href={rule.evidence.url} rel="noopener nofollow">
                            source
                          </a>
                        </span>
                      ) : rule.evidence ? (
                        <span class="quote">
                          Paraphrased by Novus. Check the{" "}
                          <a class="linkish" href={rule.evidence.url} rel="noopener nofollow">
                            official page
                          </a>
                          .
                        </span>
                      ) : null}
                      {rule.sensitive ? (
                        <a class="private" href={`/app/programs/${props.slug}#check`}>
                          <Icon name="lock" /> Answer privately
                        </a>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ))}
          {summary.attestations.length ? (
            <>
              <h3 class="group-label">You confirm when you apply</h3>
              <ul class="rules">
                {summary.attestations.map((text) => (
                  <li>
                    <span class="mk lock" aria-hidden="true">
                      <Icon name="lock" />
                    </span>
                    <span class="rule-text">{text}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {summary.nomination ? <p class="callout">{summary.nomination}</p> : null}
          {summary.notReviewed.length ? (
            <p class="note">Not fully checked yet: {summary.notReviewed.join(", ")}. See the official page for these.</p>
          ) : null}
          <div class="callout" data-island="eligibility-check" data-slug={props.slug}>
            <strong>Check against your answers.</strong>{" "}
            {summary.hasSensitive
              ? "Questions marked with a lock are optional. Novus never sends or saves your answer: it is checked in your browser."
              : "Your answers are checked in your browser."}{" "}
            <a class="linkish" href={`/app/programs/${props.slug}#check`}>
              Start the check
            </a>
          </div>
          {props.sensitiveAudience ? (
            <p class="note">Novus never links your account to this program unless you choose to track it.</p>
          ) : null}
        </>
      )}
    </section>
  );
}

function RequirementsSection(props: { detail: ProgramDetail; now: number }) {
  const lines = describeRequirements(props.detail, props.now);
  return (
    <section class="section" aria-labelledby="req-h">
      <div class="section-head">
        <h2 id="req-h">What you need</h2>
        {!props.detail.requirementsChecked && lines.length ? <span class="note">Not all items checked by a person yet</span> : null}
      </div>
      {lines.length === 0 ? (
        <p>Requirements aren't listed yet. The official page has the full list.</p>
      ) : (
        <ul class="reqs">
          {lines.map((r) => (
            <li>
              <span class="k label">{r.kindLabel}</span>
              <span>
                {r.text}
                {r.verified ? "" : " (not yet checked)"}
              </span>
              {r.startBy ? <span class="by">Start by {formatDate(r.startBy, { weekday: false })}</span> : <span />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function KeyDatesSection(props: { detail: ProgramDetail; now: number }) {
  const rows = sortDeadlines(props.detail.deadlines).map((d) => describeDeadline(d, props.now));
  return (
    <section class="section" aria-labelledby="dates-h">
      <h2 id="dates-h">Key dates</h2>
      {rows.length === 0 ? (
        <p>No dates published yet.</p>
      ) : (
        <ul class="dl">
          {rows.map((d) => (
            <li class={d.passed ? "passed" : undefined}>
              <span class="k">
                {d.kindLabel}
                {d.scope === "campus" ? " (campus)" : ""}
              </span>
              <span>
                <DeadlineWhen d={d} />
                {d.advice ? <span class="advice"> {d.advice}</span> : null}
                {d.basisNote ? <span class="basis"> · {d.basisNote}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HistorySection(props: { history: readonly CycleHistoryEntry[]; current: string }) {
  if (props.history.length === 0) return null;
  return (
    <section class="section" aria-labelledby="hist-h">
      <h2 id="hist-h">Cycle history</h2>
      <p class="note">Programs come back every year. Past dates help you plan letters and essays before this cycle opens.</p>
      <ul class="history">
        {props.history.map((h) => (
          <li>
            <span>
              <strong>{h.termLabel}</strong> · {STATUS_LABELS[h.status]}
            </span>
            <span class="note">
              {h.opensOn ? `Opened ${formatDate(h.opensOn, { weekday: false })}` : ""}
              {h.opensOn && h.applicationDate ? " · " : ""}
              {h.applicationDate
                ? h.applicationDate.length === 7
                  ? `Due ${formatMonth(h.applicationDate)}`
                  : `Due ${formatDate(h.applicationDate, { weekday: false })}`
                : ""}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SourcesSection(props: { detail: ProgramDetail }) {
  const sources = collectSources(props.detail);
  return (
    <section class="section" aria-labelledby="src-h">
      <h2 id="src-h">Sources</h2>
      <p class="note">Every fact on this page was read from an official page. A person checks each change before it appears.</p>
      <ul class="sources">
        {sources.map((s) => (
          <li>
            <a class="linkish" href={s.url} rel="noopener nofollow">
              {s.label}
            </a>
            {s.retrievedOn ? <span class="note">read {formatDate(s.retrievedOn, { weekday: false })}</span> : null}
          </li>
        ))}
      </ul>
      <p class="note">
        <a href="/methods">How Novus verifies records</a>
      </p>
    </section>
  );
}
