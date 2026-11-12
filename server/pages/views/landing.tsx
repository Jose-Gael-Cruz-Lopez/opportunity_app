/** @jsxImportSource hono/jsx */
import type { EligibilityRule, ProgramCard } from "@shared/contracts";
import { OPPORTUNITY_GROUP_LABELS, type OpportunityGroup } from "@shared/taxonomy";
import { assetPath } from "../assets";
import { Head, Icon, IconSprite, NoticeBanner, type SiteContext } from "../components/layout";
import { DaysLeft, DeadlineWhen, WindowRuler } from "../components/ui";
import { formatDate, plural } from "../format";
import { metaDescription, organizationJsonLd, websiteJsonLd, type PageMeta } from "../seo";
import {
  classYearText,
  compensationText,
  countByGroup,
  describeStatus,
  describeVerification,
  nextDeadline,
  primaryGroupLabel,
  todayIso,
  type DeadlineDisplay,
} from "../view-model";
import { browseOrder } from "./explore";
import { upcomingDeadlines, type DeadlineRow } from "./deadlines";
import { windowSpan } from "./program";

/**
 * Landing page (/): the "Dusk to Day" design. One lit tile opens the page on near-black (a WebGL
 * shader in landing.js, a CSS gradient tile without it), its light warms the ground to taupe for
 * the five doors, paper carries the reading, and night returns for the close.
 *
 * Every number and program on this page comes from the registry: door counts, the countdown, the
 * program card and the closing-soon list. Nothing is invented here; sample records say so.
 * Accessibility rules from the design: content is visible at rest, reduced motion stops all
 * motion, a "Pause motion" button does the same on demand, and decorative layers are hidden from
 * assistive technology.
 */

export interface LandingModel {
  readonly cards: readonly ProgramCard[];
  readonly now: number;
}

interface Door {
  readonly group: OpportunityGroup;
  readonly blurb: string;
}

/** The five doors, in the design's order; `data-tint` indexes landing.js's tint table. */
const DOORS: readonly Door[] = [
  { group: "internships", blurb: "Paid roles built for first- and second-years, at companies, labs, museums and agencies." },
  { group: "fellowships", blurb: "Cohorts with mentors, stipends and a network that lasts past the summer." },
  { group: "research", blurb: "Paid summers in real labs. Many sites take students after their first or second year." },
  { group: "apprenticeships_training", blurb: "Earn while you learn, with a mentor and a paycheck from the first day." },
  { group: "scholarships", blurb: "Named awards, with campus nomination deadlines shown before the national ones." },
];

export const CLOSING_SOON_COUNT = 4;

export function landingPageMeta(site: SiteContext): PageMeta {
  return {
    title: "Novus: internships, fellowships, research and scholarships for first- and second-years",
    description: metaDescription(
      "One map of internships, fellowships, research, apprenticeships and scholarships for first- and second-year students. Every deadline checked by a person against the official page.",
    ),
    path: "/",
    indexable: true,
    jsonLd: [organizationJsonLd(site.origin), websiteJsonLd(site.origin)],
  };
}

/** "Fall 2026": the season label the hero shows before landing.js updates it on the viewer's clock. */
export function seasonLabel(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const season = month >= 9 && month <= 11 ? "Fall" : month === 12 || month <= 2 ? "Winter" : month <= 5 ? "Spring" : "Summer";
  return `${season} ${year}`;
}

/**
 * The program the "Inside Novus" card shows: the first open program in browse order with a
 * verified rule set, preferring one that has a private question (so the card shows the lock).
 * Programs for a sensitive audience are never featured.
 */
export function featuredProgram(cards: readonly ProgramCard[], now: number): ProgramCard | null {
  const candidates = browseOrder(cards, now).filter(
    (c) => (c.status === "open" || c.status === "relaunched") && c.rules !== null && !c.flags.sensitiveAudience,
  );
  return candidates.find((c) => c.rules?.rules.some((r) => r.sensitive)) ?? candidates[0] ?? null;
}

/** Up to three rules for the card: the plain ones first, then one private question. */
export function featuredRules(card: ProgramCard): EligibilityRule[] {
  const rules = card.rules?.rules ?? [];
  const plain = rules.filter((r) => !r.sensitive).slice(0, 2);
  const priv = rules.find((r) => r.sensitive);
  return priv ? [...plain, priv].slice(0, 3) : rules.slice(0, 3);
}

export function LandingPage(props: { model: LandingModel; site: SiteContext }) {
  const { model, site } = props;
  const { cards, now } = model;
  const counts = countByGroup(cards);
  const soon = upcomingDeadlines(cards, now, 90).slice(0, CLOSING_SOON_COUNT);
  const featured = featuredProgram(cards, now);
  const today = todayIso(now);
  const sample = cards.some((c) => c.isSample);
  return (
    <html lang="en">
      <Head meta={landingPageMeta(site)} site={site} styles={[assetPath("landing.css")]} scripts={[assetPath("landing.js"), assetPath("page.js")]} />
      <body>
        <a class="skip" href="#main">
          Skip to content
        </a>
        <NoticeBanner site={site} />
        <IconSprite />
        <canvas id="sky" aria-hidden="true" />
        <span class="mark" id="mark" aria-hidden="true">
          novus
        </span>
        <header class="corners">
          <a class="word" href="/" aria-label="Novus home">
            novus
          </a>
          <nav class="label" aria-label="Main">
            <a href="/explore">Explore</a>
            <a class="opt" href="/deadlines">
              Deadlines
            </a>
            <a class="opt" href="/methods">
              How we verify
            </a>
            <a href="/app">Sign in</a>
          </nav>
        </header>
        <main id="main">
          <Hero today={today} />
          <section class="statement" id="map" aria-labelledby="mapT">
            <div class="wrap">
              <span class="label kick fade rv">The map</span>
              <h2 id="mapT" class="rv">
                <span class="ln">
                  <span>Internships are one door.</span>
                </span>
                <span class="ln">
                  <span>
                    We map <em>all</em> of them.
                  </span>
                </span>
              </h2>
              <p class="fade rv">
                Fellowships, research, apprenticeships, scholarships, insight weeks, sprints and conferences. Each one checked by a person, with
                a link to the official page it was read from.
              </p>
            </div>
          </section>
          <Doors counts={counts} sample={sample} />
          <Inside cards={cards} featured={featured} now={now} today={today} />
          <HowAndSoon soon={soon} now={now} />
          <Night site={site} sample={sample} />
        </main>
      </body>
    </html>
  );
}

function Hero(props: { today: string }) {
  return (
    <section class="hero" id="top" aria-labelledby="heroT">
      <div class="slot" id="slotA" aria-hidden="true">
        <svg class="trace" viewBox="0 0 400 500" preserveAspectRatio="none">
          <rect x=".5" y=".5" width="399" height="499" rx="148" ry="150" pathLength="1" />
        </svg>
        <div class="css-tile">
          <span>novus</span>
        </div>
      </div>
      <h1 id="heroT" class="intro d1">
        Find the doors that open <em>early</em>.
      </h1>
      <div class="wrap hero-foot">
        <span class="label l intro d2">[ Internships · Fellowships · Research · Apprenticeships · Scholarships ]</span>
        <a class="pill intro d3" href="/explore">
          Explore programs
        </a>
        <span class="label r intro d2" id="clock">
          {seasonLabel(props.today)}
        </span>
      </div>
    </section>
  );
}

function doorCountText(n: number): string {
  return n > 0 ? plural(n, "program") : "Coming soon";
}

function Doors(props: { counts: ReadonlyMap<OpportunityGroup, number>; sample: boolean }) {
  const first = DOORS[0] as Door;
  const firstCap = `${OPPORTUNITY_GROUP_LABELS[first.group]} · ${doorCountText(props.counts.get(first.group) ?? 0)}`;
  return (
    <section class="doors" id="doors" aria-labelledby="doorsT">
      <div class="wrap">
        <div class="doors-art">
          <div class="slot" id="slotB" aria-hidden="true">
            <div class="css-tile">
              <span>novus</span>
            </div>
          </div>
          <span class="label door-cap" id="doorCap" aria-hidden="true">
            {firstCap}
          </span>
        </div>
        <div class="doors-copy">
          <span class="label kick">Five doors</span>
          <h2 id="doorsT" class="rv">
            <span class="ln">
              <span>Pick a door.</span>
            </span>
            <span class="ln">
              <span>
                The light <em>follows</em> you.
              </span>
            </span>
          </h2>
          <ol class="door-list">
            {DOORS.map((door, i) => {
              const label = OPPORTUNITY_GROUP_LABELS[door.group];
              const count = doorCountText(props.counts.get(door.group) ?? 0);
              return (
                <li class={i === 0 ? "door on" : "door"} data-tint={String(i)} data-cap={`${label} · ${count}`}>
                  <span class="n" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <h3>
                    <a href={`/explore?group=${door.group}`}>{label}</a>
                  </h3>
                  <span class="c">{count}</span>
                  <p>{door.blurb}</p>
                </li>
              );
            })}
          </ol>
          <p class="also">
            Also on the map: <a href="/explore?group=early_career">insight weeks and sprints</a>, and{" "}
            <a href="/explore?group=events_competitions">conferences and competitions</a>.
            {props.sample ? " Counts include invented sample records." : ""}
          </p>
        </div>
      </div>
    </section>
  );
}

/** Soonest card deadline, for the countdown card. */
function soonestDeadline(cards: readonly ProgramCard[], now: number): { card: ProgramCard; d: DeadlineDisplay } | null {
  const rows = upcomingDeadlines(cards, now, 365).filter((r) => r.d.daysLeft !== null);
  const first = rows[0];
  return first ? { card: first.card, d: first.d } : null;
}

function Inside(props: { cards: readonly ProgramCard[]; featured: ProgramCard | null; now: number; today: string }) {
  const { cards, now, today } = props;
  const countdown = soonestDeadline(cards, now);
  const verified = cards.filter((c) => c.verification.state === "verified").length;
  const open = cards.filter((c) => c.status === "open" || c.status === "relaunched").length;
  const due30 = upcomingDeadlines(cards, now, 30).length;
  const litDots = cards.length ? Math.round((open / cards.length) * 16) : 0;
  return (
    <section class="inside" id="inside" aria-labelledby="inT">
      <div class="wrap">
        <div class="head">
          <span class="label kick">Inside Novus</span>
          <h2 id="inT" class="rv">
            <span class="ln">
              <span>Everything you need before a deadline.</span>
            </span>
            <span class="ln">
              <span class="dim">Nothing you don't.</span>
            </span>
          </h2>
        </div>
        <div class="cards">
          {countdown ? <CountdownCard row={countdown} now={now} /> : <EmptyCountdown />}
          <article class="card stats" aria-label="The registry today">
            <Stat icon="track" label={["Programs", "listed"]} value={cards.length} chart="bars" />
            <Stat icon="clock" label={["Due in", "30 days"]} value={due30} chart="wave" />
            <Stat icon="check" label={["Verified by", "a person"]} value={verified} small={`of ${cards.length}`} chart="steps" />
            <div class="stat deep">
              <div class="st-top">
                <span class="ring">
                  <Icon name="compass" />
                </span>
                <span>
                  Open
                  <br />
                  now
                </span>
              </div>
              <div class="st-bot">
                <span class="st-num">
                  {open}
                  <small>of {cards.length}</small>
                </span>
                <span class="dg" aria-hidden="true">
                  {Array.from({ length: 16 }, (_, i) => (
                    <i class={i < litDots ? "on" : undefined} />
                  ))}
                </span>
              </div>
            </div>
          </article>
          {props.featured ? <FeaturedCard card={props.featured} now={now} today={today} /> : null}
        </div>
      </div>
    </section>
  );
}

const MINI_CHARTS: Readonly<Record<"bars" | "wave" | "steps", string>> = {
  bars: "M4 22v-8M11 22V10M18 22v-6M25 22V5M32 22v-9M39 22V8M46 22v-5M53 22V11",
  wave: "M2 18c7 0 9-12 16-12s8 13 15 13 9-15 16-15 7 8 7 8",
  steps: "M2 20h10v-6h10v6h10V11h10v9h10V5",
};

function Stat(props: { icon: string; label: [string, string]; value: number; small?: string; chart: keyof typeof MINI_CHARTS }) {
  return (
    <div class="stat">
      <div class="st-top">
        <span class="ring">
          <Icon name={props.icon} />
        </span>
        <span>
          {props.label[0]}
          <br />
          {props.label[1]}
        </span>
      </div>
      <div class="st-bot">
        <span class="st-num">
          {props.value}
          {props.small ? <small>{props.small}</small> : null}
        </span>
        <svg class="mc" viewBox="0 0 58 24" aria-hidden="true">
          <path d={MINI_CHARTS[props.chart]} />
        </svg>
      </div>
    </div>
  );
}

function CountdownCard(props: { row: DeadlineRow; now: number }) {
  const { card, d } = props.row;
  const span = windowSpan(card.opensOn, d.listDate, props.now);
  return (
    <article class="card count" aria-labelledby="cd-h">
      {card.isSample ? <span class="tagS">Sample</span> : null}
      <p class="eyebrow" id="cd-h">
        <a href={`/programs/${card.slug}`}>{card.name}</a> closes in
      </p>
      <div class="num">
        <DaysLeft d={d} />
        <p class="sub">
          <DeadlineWhen d={d} />
        </p>
      </div>
      {span && card.opensOn && d.listDate ? (
        <>
          <WindowRuler fraction={span.fraction} label={`Day ${span.day} of a ${span.total}-day application window`} />
          <div class="ends">
            <span>Opened {formatDate(card.opensOn, { weekday: false, year: false })}</span>
            <span>Due {formatDate(d.listDate, { weekday: false, year: false })}</span>
          </div>
        </>
      ) : null}
    </article>
  );
}

function EmptyCountdown() {
  return (
    <article class="card count" aria-label="Next deadline">
      <p class="eyebrow">Next deadline</p>
      <div class="num">
        <p class="sub">No dates are published yet. They appear here as soon as a person checks them.</p>
      </div>
    </article>
  );
}

function FeaturedCard(props: { card: ProgramCard; now: number; today: string }) {
  const { card, now } = props;
  const next = nextDeadline(card, now);
  const status = describeStatus(card.status, next);
  const verification = describeVerification(card.verification, props.today);
  const pay = compensationText(card.compensation);
  return (
    <article class="card prog" aria-labelledby="fp-h">
      {card.isSample ? <span class="tagS">Sample</span> : null}
      <div class="tags">
        <span class={status.tone === "warn" ? "tag warn" : "tag"}>
          <span class="led" aria-hidden="true" />
          {status.label}
        </span>
        <span class="tag">{primaryGroupLabel(card.opportunityTypes)}</span>
      </div>
      <h3 id="fp-h">
        <a href={`/programs/${card.slug}`}>{card.name}</a>
      </h3>
      <p class="ver">
        <Icon name={verification.tone === "good" ? "check" : "info"} />
        {verification.label}
      </p>
      <p class="ver">
        {classYearText(card.classYears)}
        {pay ? ` · ${pay}` : ""}
      </p>
      <ul class="rules" aria-label="Eligibility rules">
        {featuredRules(card).map((rule) => (
          <li>
            <span class={rule.sensitive ? "mk q" : "mk"} aria-hidden="true">
              {rule.sensitive ? <Icon name="lock" /> : "?"}
            </span>
            <span>
              {rule.officialText}
              {rule.sensitive ? (
                <>
                  <br />
                  <a class="mini" href={`/programs/${card.slug}#eligibility`}>
                    <Icon name="lock" />
                    Answer privately
                  </a>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <a class="apply" href={`/programs/${card.slug}`}>
        <span>See dates, rules and the official link</span>
        <Icon name="out" />
      </a>
    </article>
  );
}

const STEPS = [
  {
    tile: "t-ember",
    icon: "compass",
    title: "Find",
    text: "Search one map of internships, fellowships, research, apprenticeships and scholarships. Filter by kind, status and pay.",
  },
  {
    tile: "t-sky",
    icon: "lock",
    title: "Check privately",
    text: "Answer eligibility questions in your browser. Sensitive answers never leave your device.",
  },
  {
    tile: "t-honey",
    icon: "leaf",
    title: "Plan by season",
    text: "Programs come back every year. Last cycle's dates tell you when to ask for letters.",
  },
] as const;

function HowAndSoon(props: { soon: readonly DeadlineRow[]; now: number }) {
  const sample = props.soon.some((r) => r.card.isSample);
  return (
    <section class="day" id="how" aria-labelledby="howT">
      <div class="wrap">
        <div class="head">
          <span class="label kick">How it works</span>
          <h2 id="howT" class="rv">
            <span class="ln">
              <span>
                Three steps, <em>every</em> season.
              </span>
            </span>
          </h2>
        </div>
        <ol class="steps">
          {STEPS.map((step, i) => (
            <li class="fade rv">
              <span class="n" aria-hidden="true">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span class={`mini-tile ${step.tile}`} aria-hidden="true">
                <Icon name={step.icon} />
              </span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
        <div class="head spaced">
          <span class="label kick">Closing soon</span>
          <h2 id="soonT" class="rv">
            <span class="ln">
              <span>The next doors to close.</span>
            </span>
          </h2>
        </div>
        {props.soon.length === 0 ? (
          <p>Nothing closes in the next 90 days.</p>
        ) : (
          <ul class="soon-list" aria-labelledby="soonT">
            {props.soon.map(({ card, d }) => (
              <li class={d.daysLeft !== null && d.daysLeft <= 14 ? "urgent" : undefined}>
                {d.daysLeft !== null ? (
                  <DaysLeft d={d} />
                ) : (
                  <span class="dot" aria-hidden="true">
                    ~
                  </span>
                )}
                <span>
                  <b>
                    <a href={`/programs/${card.slug}`}>{card.name}</a>
                  </b>
                  <span class="org">{card.organizationName}</span>
                </span>
                <span class="when">
                  <DeadlineWhen d={d} />
                </span>
                <span class="ty">
                  {primaryGroupLabel(card.opportunityTypes)}
                  {card.isSample ? " · Sample" : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
        {sample ? <p class="sample-note">Rows marked Sample are invented records, with dates counted from today. They are not real programs.</p> : null}
        <a class="more" href="/deadlines">
          Every upcoming deadline <Icon name="out" />
        </a>
      </div>
    </section>
  );
}

function Night(props: { site: SiteContext; sample: boolean }) {
  return (
    <section class="night" id="join" aria-labelledby="joinT">
      <div class="wrap">
        <div class="slot" id="slotC" aria-hidden="true">
          <div class="css-tile">
            <span>novus</span>
          </div>
        </div>
        <h2 id="joinT" class="rv">
          <span class="ln">
            <span>
              Start with your <em>season</em>.
            </span>
          </span>
        </h2>
        <div class="ctas">
          <a class="pill solid" href="/explore?status=open">
            See what is open now
          </a>
          <a class="pill" href="/app">
            Sign in to track deadlines
          </a>
        </div>
        <p class="note">
          Free for students. Novus never sells student data and never shows a single score about you. <a href="/pledge">Read our pledge</a>.
        </p>
        <footer class="foot label">
          <nav aria-label="Footer">
            <a href="/explore">Explore</a>
            <a href="/deadlines">Deadlines</a>
            <a href="/methods">How we verify</a>
            <a href="/pledge">Our pledge</a>
            <a href="/methods#corrections">Report an error</a>
          </nav>
          <span>
            © {props.site.year} Novus{props.sample ? " · includes sample data" : ""}
          </span>
          <button type="button" id="motionBtn" aria-pressed="false" hidden>
            Pause motion
          </button>
        </footer>
      </div>
    </section>
  );
}
