/** @jsxImportSource hono/jsx */
import type { ProgramCard } from "@shared/contracts";
import { PRODUCT } from "@shared/config/product";
import { DISCLOSURE } from "@shared/disclosure/config";
import { OPPORTUNITY_GROUP_LABELS, OPPORTUNITY_TYPES, type OpportunityGroup } from "@shared/taxonomy";
import { formatDate, joinList, plural } from "../format";
import { Page, type SiteContext } from "../components/layout";
import { AUDIT_PATH, plannedPublication } from "../audit";
import { availableHubs, HUB_MIN_VERIFIED, hubLabel, hubPath } from "../hubs";
import { breadcrumbJsonLd, metaDescription, webPageJsonLd, type PageMeta } from "../seo";
import { countByGroup } from "../view-model";

/**
 * Methods (/methods): how Novus verifies records, step by step; evidence; freshness labels;
 * deadlines and time zones; how deadline accuracy is measured; where AI is and is not used; odds
 * and disclosure thresholds; the private eligibility check; coverage; advisors; money;
 * corrections and data terms. Thresholds come from shared/config/product.ts and
 * shared/disclosure/config.ts so this page cannot drift from the code that applies them.
 */

export interface MethodsModel {
  readonly cards: readonly ProgramCard[];
  /** For type-hub links; omitted renders no hub links. */
  readonly now?: number;
}

/** Plan s04 4.13 / s10 10.9: the first monthly random-sample deadline check. */
export const FIRST_ACCURACY_CHECK = { start: "2026-12-14", end: "2026-12-18" } as const;
/** The public "at least 95%" claim rests on a trailing window of this many months (n = 50 each). */
export const ACCURACY_WINDOW_MONTHS = 6;
export const ACCURACY_SAMPLE_PER_MONTH = 50;

/** Opportunity types Novus does not verify at all (out of scope in the taxonomy). */
export const NOT_COVERED: readonly string[] = OPPORTUNITY_TYPES.filter((t) => !t.inScope).map((t) => t.label);

export function methodsPageMeta(site?: SiteContext): PageMeta {
  const description = metaDescription(
    "Every Novus record is read from an official page and checked by a person, with the source linked. How verification, freshness, time zones, AI, odds, private eligibility checks and corrections work.",
  );
  return {
    title: "How Novus verifies programs and deadlines | Novus",
    description,
    path: "/methods",
    indexable: true,
    jsonLd: site
      ? [
          webPageJsonLd(site.origin, { name: "How Novus verifies programs and deadlines", description, path: "/methods" }),
          breadcrumbJsonLd(site.origin, [
            { name: "Novus", path: "/" },
            { name: "Methods", path: "/methods" },
          ]),
        ]
      : [],
  };
}

const SECTIONS = [
  { id: "verify", label: "How we verify" },
  { id: "workflow", label: "Step by step" },
  { id: "freshness", label: "Freshness" },
  { id: "dates", label: "Dates and time zones" },
  { id: "accuracy", label: "Accuracy" },
  { id: "ai", label: "Where AI is used" },
  { id: "odds", label: "Odds and small numbers" },
  { id: "privacy", label: "Private eligibility" },
  { id: "coverage", label: "Coverage" },
  { id: "advisors", label: "For advisors" },
  { id: "money", label: "How Novus makes money" },
  { id: "corrections", label: "Corrections" },
  { id: "terms", label: "Using our data" },
] as const;

/** The verification workflow, in order. Each step names what software does and what a person does. */
export const WORKFLOW_STEPS: readonly { title: string; text: string }[] = [
  {
    title: "Find the official page",
    text: "Each program is traced to the organization's own site, its application portal or a government record. Job boards, aggregators and social posts are never a source.",
  },
  {
    title: "Watch it politely",
    text: "NovusBot re-reads each official page on a schedule. It obeys robots.txt, spaces its visits to every site and identifies itself on its own page. Each version it reads is kept as a dated snapshot.",
  },
  {
    title: "Sort the change",
    text: "Software compares the new version with the last one. Cosmetic edits are set aside; a change to a deadline, status, eligibility rule or requirement opens a review task for a person at once.",
  },
  {
    title: "Draft with evidence",
    text: "Software may draft the changed values, sometimes with an AI model. Every draft must quote the page word for word, and every date it proposes must appear on the page. A draft that fails these checks is thrown away, never shown.",
  },
  {
    title: "Read documents twice",
    text: "PDFs are read by two independent text readers. Scanned documents go through two OCR engines that must agree on every date and number; where they disagree, a person reads the original.",
  },
  {
    title: "A person decides",
    text: "A Curator reads the official page beside the draft and approves, corrects or rejects each value. Proposed values are marked as proposed and never pre-selected.",
  },
  {
    title: "Publish with a receipt",
    text: "An approved fact goes live with the Curator's handle, the date and the link it was read from. Pages show the change within five minutes.",
  },
];

export function MethodsPage(props: { model: MethodsModel; site: SiteContext }) {
  const { model, site } = props;
  const counts = countByGroup(model.cards);
  const groups = [...counts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]) as [OpportunityGroup, number][];
  const verified = model.cards.filter((c) => c.verification.state === "verified").length;
  const sample = model.cards.some((c) => c.isSample);
  const hubs = model.now !== undefined ? availableHubs(model.cards, model.now).filter((k) => k.kind === "group") : [];
  const [inFresh, inAging] = PRODUCT.freshness.inSeason;
  const [offFresh, offAging] = PRODUCT.freshness.offSeason;
  const pub = DISCLOSURE.audiences.public;
  const advisor = DISCLOSURE.audiences.advisor;
  const sponsor = DISCLOSURE.audiences.sponsor;
  const windowN = ACCURACY_WINDOW_MONTHS * ACCURACY_SAMPLE_PER_MONTH;
  return (
    <Page meta={methodsPageMeta(site)} site={site} nav="methods" island={false}>
      <section class="dusk" aria-labelledby="m-h">
        <div class="wrap">
          <span class="label kick">Methods</span>
          <h1 id="m-h">
            How we <em>verify</em>.
          </h1>
          <p class="lede">Every fact on Novus was read from an official page, and a person checked it before it appeared.</p>
          <nav aria-label="On this page">
            <ul class="toc">
              {SECTIONS.map((s) => (
                <li>
                  <a class="pill" href={`#${s.id}`}>
                    {s.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      </section>
      <div class="day">
        <div class="wrap prose">
          <h2 id="verify">How we verify</h2>
          <p>
            Novus lists programs from their official pages: the organization's own site, its application portal or a government record.
            We never copy listings from job boards or social media, and we link every record to where it was read.
          </p>
          <ul>
            <li>Software watches each official page and flags changes. It never publishes anything on its own.</li>
            <li>
              A Curator reads the change against the official page, then approves, corrects or rejects it. The page shows who verified it and
              when.
            </li>
            <li>
              Each fact keeps its evidence: the link, the date it was read, and where allowed a short quote of at most{" "}
              {PRODUCT.ai.maxExcerptWords} words.
            </li>
            <li>Summaries are written by Novus. Eligibility rules are paraphrased, with the official wording linked.</li>
          </ul>

          <h2 id="workflow">Step by step</h2>
          <ol class="steps">
            {WORKFLOW_STEPS.map((step, i) => (
              <li>
                <span class="dot num" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <p>
            Who NovusBot is and how to reach it: <a href="/bot">the NovusBot page</a>.
          </p>

          <h2 id="freshness">Freshness</h2>
          <p>
            Programs change between cycles, so every record shows how recently a person checked it. In season (open, opening within{" "}
            {PRODUCT.inSeason.openOrP10WithinDays} days, or with a deadline within {PRODUCT.inSeason.deadlineWithinDays} days):
          </p>
          <ul>
            <li>
              <strong>Verified</strong>: checked in the last {inFresh} days.
            </li>
            <li>
              <strong>Verified, aging</strong>: checked {inFresh + 1} to {inAging} days ago.
            </li>
            <li>
              <strong>Needs re-check</strong>: older than that. Confirm on the official site before you rely on it.
            </li>
            <li>
              <strong>Being re-checked</strong>: the official page changed and a person is reviewing it. The old values stay visible
              meanwhile.
            </li>
          </ul>
          <p>
            Out of season the windows are {offFresh} and {offAging} days.
          </p>

          <h2 id="dates">Dates and time zones</h2>
          <ul>
            <li>
              Each deadline is shown the way the official page states it, in that page's time zone, with your own local time beside it.
            </li>
            <li>
              Some programs say "11:59 PM in your time zone". We show those as your time, and count down on your own clock.
            </li>
            <li>
              When a page gives a date but no time, we say "time not stated" and suggest submitting a day early, because many portals and
              offices close before midnight.
            </li>
            <li>
              Expected dates for a cycle that has not opened yet are estimates from past cycles, always labelled as estimates and shown as a
              range.
            </li>
            <li>Campus deadlines for nominated awards come before the national one. We mark them separately.</li>
            <li>
              When a deadline passes, a program that was open shows "checking for extensions" for {PRODUCT.extensionCheckHours} hours while we
              look.
            </li>
          </ul>

          <h2 id="accuracy">How we measure accuracy</h2>
          <p>
            Every month we draw a simple random sample of {ACCURACY_SAMPLE_PER_MONTH} published deadlines, and someone other than the person
            who verified each one checks it again on the official page. A deadline counts as correct only if the date, the time, the time-zone
            rule, the kind of deadline and its scope (campus or national) all match.
          </p>
          <ul>
            <li>
              We say "at least 95% accurate" only while the lower end of the Wilson 95% interval over the last {ACCURACY_WINDOW_MONTHS} months
              ({windowN} deadlines) stays at or above 95%.
            </li>
            <li>The claim comes down automatically when that bound falls below 95%, or when any single month finds 5 or more errors.</li>
            <li>
              The first check runs {formatDate(FIRST_ACCURACY_CHECK.start, { weekday: false, year: false })} to{" "}
              {formatDate(FIRST_ACCURACY_CHECK.end, { weekday: false })}. Until enough months exist, the window is every month since then, and
              this page will name its dates. <strong>No accuracy figure is published yet.</strong>
            </li>
          </ul>
          <p>
            Separately, we test what students hear elsewhere: the <a href={AUDIT_PATH}>AI deadline-accuracy audit</a> asks consumer AI
            assistants for the deadlines of 50 programs and scores their answers, and ours, against the official pages. The first report is due{" "}
            {formatDate(plannedPublication(), { weekday: false })}.
          </p>

          <h2 id="ai">Where AI is used, and where it is not</h2>
          <p>Decisions about you and facts about programs are made by deterministic code and people, never by a model:</p>
          <ul>
            <li>Eligibility verdicts, requirement checklists, start-by dates and next steps.</li>
            <li>Deadlines, statuses and the dates we expect for unannounced cycles.</li>
            <li>The order programs appear in, and search.</li>
            <li>Odds, which come only from official counts.</li>
          </ul>
          <p>An AI model (Google's Gemini, through its API) may help with:</p>
          <ul>
            <li>Drafts of changed values for a Curator, under the checks in step 4 above.</li>
            <li>A plain-language explanation of a readiness report that code already computed, citing the program's sources.</li>
            <li>Feedback on an essay you paste in, with no grade.</li>
            <li>Answers to questions, from Novus records and official sources, with citations.</li>
          </ul>
          <p>
            Model output is checked before anyone sees it: cited records must exist, quotes must be exact, dates must appear in a source, and any
            score, percentage, grade or chance about you is rejected. Your private eligibility answers are never put in a prompt. Everything works
            with AI switched off; you then see the same facts without the extra explanation, and the page says that AI is off. We never use your
            data to train generative AI models.
          </p>

          <h2 id="odds">Odds and small numbers</h2>
          <ul>
            <li>
              Odds come from official counts only, shown as counts ("12 of 40 applicants reached interviews") and a natural frequency ("about 3
              in 10"). Never as a personal probability.
            </li>
            <li>
              Novus never shows a single score, percentage or "match" about you. Readiness is four separate parts: eligibility with reasons, a
              checklist naming each gap, a competitiveness band, and next steps.
            </li>
            <li>
              A personal competitiveness band appears only after a model built from verified reports passes every check for sample size,
              held-out accuracy, calibration and fairness. None has passed yet, so today you see official counts or "not enough data". School,
              location, demographics and private answers are never inputs.
            </li>
          </ul>
          <p>Numbers built from students' reports go through one disclosure rule before they are shown anywhere:</p>
          <ul>
            <li>
              On public pages: nothing for a group under {pub.minTotal}, and each cell needs {pub.minCell} or more people.
            </li>
            <li>
              Counts under {DISCLOSURE.bandBelow} are shown as ranges; larger ones are rounded to the nearest {DISCLOSURE.roundTo}.
            </li>
            <li>
              Advising offices see cells of {advisor.minCell} or more; sponsors and institutions see only groups of {sponsor.minCell} or more.
            </li>
          </ul>

          <h2 id="privacy">Private eligibility</h2>
          <p>
            Some rules depend on things that are nobody's business: citizenship or immigration status, financial aid, or which communities
            you belong to. Questions about these are optional, and your answers are checked in your browser only. They are never sent to
            Novus, saved, logged or shown to an AI model. Pages that can show your answers ask your browser not to keep a copy.
          </p>
          <p>
            Public pages set no cookies and carry no ad pixels, ad SDKs or session replay. Our promises about your data are in{" "}
            <a href="/pledge">the Novus pledge</a>.
          </p>

          <h2 id="coverage">Coverage</h2>
          <p>
            Novus lists {plural(model.cards.length, "program")} today, {verified} of them verified by a person
            {sample ? ", including invented sample records used for this preview" : ""}:
          </p>
          <ul>
            {groups.map(([g, n]) => (
              <li>
                {OPPORTUNITY_GROUP_LABELS[g]}: {n}
              </li>
            ))}
          </ul>
          <p>
            We focus on programs first- and second-year students can apply to: internships, fellowships, research, apprenticeships,
            scholarships, insight weeks, sprints and conferences. A program missing from the list does not mean it does not exist.
          </p>
          <p>
            A kind of program gets its own page once {HUB_MIN_VERIFIED} or more of its programs are verified by a person.
            {hubs.length ? " Pages so far: " : " None has reached that yet; Explore's filters cover every kind meanwhile."}
            {hubs.map((k, i) => (
              <>
                {i > 0 ? ", " : ""}
                <a href={hubPath(k)}>{hubLabel(k)}</a>
              </>
            ))}
            {hubs.length ? "." : ""}
          </p>
          <p>
            Not covered: {joinList(NOT_COVERED.map((l) => l.toLowerCase()))}. Novus does not verify these; their official pages are the place
            to check.
          </p>

          <h2 id="advisors">For advisors</h2>
          <ul>
            <li>
              Advising offices can publish lists of programs for their students, publicly or as an unlisted link, with their own notes. A list's
              page shows the programs and the office's words, never anything about who opened it.
            </li>
            <li>
              Campus deadlines reach us from the office's own address. A Curator confirms each one through the office's published contact
              before it shows, labelled "Confirmed by your campus" and only to that school's students.
            </li>
            <li>
              Reports to an office are monthly aggregates through the disclosure rule above. Programs for students of a particular status or
              health condition never appear in them.
            </li>
          </ul>

          <h2 id="money">How Novus makes money</h2>
          <p>
            Students never pay. Today Novus earns nothing: pilots with advising offices are free. We plan to charge colleges for advisor tools,
            and later to carry sponsorships that are always labelled "Ad".
          </p>
          <ul>
            <li>Payment never changes eligibility, the order programs appear in, or moderation.</li>
            <li>Ads never appear in Explore, on program pages or in reminders.</li>
            <li>Sponsors never receive readiness information, reports from students or individual profiles.</li>
          </ul>
          <p>
            The full list of promises is <a href="/pledge">the Novus pledge</a>.
          </p>

          <h2 id="corrections">Corrections</h2>
          <p>
            Every program page has a "Report an error" button. Tell us which fact is wrong and link the official page that says otherwise.
            A person reviews every report: within a day when the deadline is two weeks away or less, and within three days otherwise.
            Nothing public changes until then.
          </p>
          <p>Please don't include your immigration status or financial-aid details in a report.</p>

          <h2 id="terms">Using our data</h2>
          <p>
            Program facts belong to the organizations that publish them; always confirm on the official page before you apply. Novus's
            summaries and verification records may be quoted with a link back to the program page.
          </p>
          {sample ? (
            <p class="callout" role="note">
              This environment includes <strong>sample</strong> records. Their names say "Sample" or "Example", their links go to
              example.org, and they are not real programs.
            </p>
          ) : null}
        </div>
      </div>
    </Page>
  );
}
