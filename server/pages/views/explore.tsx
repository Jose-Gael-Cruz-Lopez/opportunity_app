/** @jsxImportSource hono/jsx */
import type { ProgramCard } from "@shared/contracts";
import { buildIndex, filterCards, search, type SearchFilters } from "@shared/matching";
import { OPPORTUNITY_GROUP_LABELS, OPPORTUNITY_GROUPS, type CycleStatus, type OpportunityGroup } from "@shared/taxonomy";
import { plural } from "../format";
import { Page, type SiteContext } from "../components/layout";
import { ProgramCardView } from "../components/ui";
import { metaDescription, programListJsonLd, type PageMeta } from "../seo";
import { nextDeadline, todayIso } from "../view-model";

/**
 * Explore (/explore): every published program, filterable with a plain GET form so it works
 * without JavaScript. The client island (the same component the SPA uses at /app/explore) can
 * take over the list; the server render is the baseline. Ordering is the same for everyone:
 * open first, then the soonest deadline, then name. Nothing here knows who is looking.
 */

export interface ExploreQuery {
  readonly q: string;
  readonly group: OpportunityGroup | null;
  readonly status: "open" | "upcoming" | "all";
  readonly paid: boolean;
  readonly free: boolean;
}

export const EXPLORE_PAGE_SIZE = 60;

const GROUP_SET: ReadonlySet<string> = new Set(OPPORTUNITY_GROUPS);

/** Parses and clamps query parameters; anything unknown falls back to the default. */
export function parseExploreQuery(params: URLSearchParams): ExploreQuery {
  const group = params.get("group");
  const status = params.get("status");
  return {
    q: (params.get("q") ?? "").trim().slice(0, 120),
    group: group && GROUP_SET.has(group) ? (group as OpportunityGroup) : null,
    status: status === "open" || status === "upcoming" ? status : "all",
    paid: params.get("paid") === "1",
    free: params.get("free") === "1",
  };
}

export function isDefaultQuery(q: ExploreQuery): boolean {
  return !q.q && !q.group && q.status === "all" && !q.paid && !q.free;
}

const STATUS_FILTERS: Readonly<Record<ExploreQuery["status"], readonly CycleStatus[] | undefined>> = {
  all: undefined,
  open: ["open", "relaunched"],
  upcoming: ["open", "relaunched", "expected"],
};

const STATUS_ORDER: Readonly<Record<CycleStatus, number>> = { open: 0, relaunched: 0, expected: 1, paused: 2, closed: 3, ended: 4 };

/** Browse order: open first, soonest next deadline, then name (stable for everyone). */
export function browseOrder(cards: readonly ProgramCard[], now: number): ProgramCard[] {
  const keyed = cards.map((card) => {
    const next = nextDeadline(card, now);
    const when = next && !next.passed && next.listDate ? next.listDate : "9999-12-31";
    return { card, rank: STATUS_ORDER[card.status], when };
  });
  keyed.sort((a, b) => a.rank - b.rank || a.when.localeCompare(b.when) || a.card.name.localeCompare(b.card.name));
  return keyed.map((k) => k.card);
}

export function applyExploreQuery(cards: readonly ProgramCard[], query: ExploreQuery, now: number): ProgramCard[] {
  const filters: SearchFilters = {
    groups: query.group ? [query.group] : undefined,
    statuses: STATUS_FILTERS[query.status],
    paid: query.paid || undefined,
    noCostToApply: query.free || undefined,
  };
  if (query.q) {
    return search(buildIndex(cards), query.q, { filters, now, limit: 100 }).map((r) => r.card);
  }
  return browseOrder(filterCards(cards, filters, { now }), now);
}

export interface ExploreModel {
  readonly cards: readonly ProgramCard[];
  readonly query: ExploreQuery;
  readonly now: number;
}

export function explorePageMeta(model: ExploreModel, site: SiteContext, results: readonly ProgramCard[]): PageMeta {
  const real = results.filter((c) => !c.isSample).slice(0, 30);
  return {
    title: "Explore internships, fellowships, research and scholarships | Novus",
    description: metaDescription(
      "Every program on Novus, checked by a person against the official page: internships, fellowships, research, apprenticeships, scholarships, insight weeks and conferences for first- and second-year students.",
    ),
    path: "/explore",
    // Filtered views canonicalise to /explore and are not indexed on their own.
    indexable: isDefaultQuery(model.query),
    jsonLd: isDefaultQuery(model.query) && real.length ? [programListJsonLd(site.origin, real)] : [],
  };
}

export function ExplorePage(props: { model: ExploreModel; site: SiteContext }) {
  const { model, site } = props;
  const results = applyExploreQuery(model.cards, model.query, model.now);
  const shown = results.slice(0, EXPLORE_PAGE_SIZE);
  const today = todayIso(model.now);
  const sampleShown = shown.some((c) => c.isSample);
  return (
    <Page meta={explorePageMeta(model, site, results)} site={site} nav="explore">
      <section class="dusk" aria-labelledby="explore-h">
        <div class="wrap">
          <span class="label kick">Explore</span>
          <h1 id="explore-h">
            Every door, <em>checked</em> by a person.
          </h1>
          <p class="lede">
            Internships, fellowships, research, apprenticeships, scholarships, insight weeks and conferences. Each listing links to the
            official page it was read from.
          </p>
          <ExploreFilters query={model.query} />
        </div>
      </section>
      <div class="day">
        <div class="wrap" data-island="explore">
          <div class="result-meta">
            <p aria-live="polite">
              <strong>{plural(results.length, "program")}</strong>
              {results.length > shown.length ? ` · showing the first ${shown.length}` : ""}
              {model.query.q ? ` for “${model.query.q}”` : ""}
            </p>
            {!isDefaultQuery(model.query) ? (
              <a class="linkish" href="/explore">
                Clear filters
              </a>
            ) : null}
          </div>
          {sampleShown ? (
            <p class="callout" role="note">
              Records marked <strong>Sample</strong> are invented for this preview. They are not real programs.
            </p>
          ) : null}
          {shown.length === 0 ? (
            <p class="empty">
              Nothing matches yet. Try fewer filters, or <a href="/deadlines">see what closes soon</a>.
            </p>
          ) : (
            <ul class="grid">
              {shown.map((card) => (
                <ProgramCardView card={card} now={model.now} todayIso={today} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Page>
  );
}

const FILTER_GROUPS: readonly OpportunityGroup[] = [
  "internships",
  "early_career",
  "research",
  "fellowships",
  "scholarships",
  "apprenticeships_training",
  "service_government",
  "events_competitions",
  "community_resources",
];

function ExploreFilters(props: { query: ExploreQuery }) {
  const { query } = props;
  return (
    <form class="filters" method="get" action="/explore" role="search" aria-label="Filter programs">
      <div class="field">
        <label class="label" for="f-q">
          Search
        </label>
        <input class="input" id="f-q" name="q" type="search" value={query.q} placeholder="Research, design, finance…" autocomplete="off" maxlength={120} />
      </div>
      <div class="field">
        <label class="label" for="f-group">
          Kind
        </label>
        <select class="select" id="f-group" name="group">
          <option value="">All kinds</option>
          {FILTER_GROUPS.map((g) => (
            <option value={g} selected={query.group === g}>
              {OPPORTUNITY_GROUP_LABELS[g]}
            </option>
          ))}
        </select>
      </div>
      <div class="field">
        <label class="label" for="f-status">
          Status
        </label>
        <select class="select" id="f-status" name="status">
          <option value="all" selected={query.status === "all"}>
            Any status
          </option>
          <option value="open" selected={query.status === "open"}>
            Open now
          </option>
          <option value="upcoming" selected={query.status === "upcoming"}>
            Open or opening soon
          </option>
        </select>
      </div>
      <div class="field">
        <span class="lab label">Only</span>
        <div class="checks">
          <label>
            <input type="checkbox" name="paid" value="1" checked={query.paid} /> Paid
          </label>
          <label>
            <input type="checkbox" name="free" value="1" checked={query.free} /> Free to apply
          </label>
          <button class="pill solid" type="submit">
            Show
          </button>
        </div>
      </div>
    </form>
  );
}
