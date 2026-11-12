import { useMemo, useState } from "react";
import type { ProgramBundle } from "./catalog";
import { applyFilters, categoriesPresent, tierCounts, toggleIn, visibleMatches, type MatchFacts } from "./filters";
import { TIERS, TIER_LABELS, type MatchView } from "./normalize";
import type { SavedFilters } from "./storage";
import { OPPORTUNITY_CATEGORY_LABELS, compensationLabel, feasibilityLine, requirementsLine } from "./wording";
import { Chip, Glass, Kicker, Note, SampleBadge, TierTag } from "./ui";
import { WayForward } from "./way-forward";

/**
 * Screen 4: the reveal. Tiers and plain reasons only; no percentages, bars or scores
 * (rule 4). Filters narrow the list without re-ranking it.
 */
export function MatchesStep({
  matches,
  bundles,
  sample,
  sampleSource = "fixtures",
  filters,
  setFilters,
  hadResume,
  onNext,
  onBack,
  onWiden,
}: {
  matches: MatchView[];
  bundles: ReadonlyMap<string, ProgramBundle>;
  sample: boolean;
  /** Live API with sample-seeded programs, or on-device fixtures because the API was unreachable. */
  sampleSource?: "live" | "fixtures";
  filters: SavedFilters;
  setFilters: (f: SavedFilters) => void;
  hadResume: boolean;
  onNext: () => void;
  /** Reopens the last question (the page takes that answer back first). */
  onBack: () => void;
  /** Drops paid-only, remote, timing and location answers and the filters. */
  onWiden: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const facts = useMemo(
    () =>
      (id: string): MatchFacts | undefined => {
        const b = bundles.get(id);
        return b ? { types: b.card.opportunityTypes, paid: b.card.flags.paid, remote: b.meta.remote } : undefined;
      },
    [bundles],
  );
  const shown = applyFilters(matches, filters, facts);
  const counts = tierCounts(matches);
  const cats = categoriesPresent(matches, facts);
  const visible = visibleMatches(shown, expanded);

  return (
    <div className="st-stack">
      <Glass className="st-enter" aria-labelledby="st-matches-title">
        <Kicker>Your matches{sample ? " · sample programs" : ""}</Kicker>
        <h2 id="st-matches-title" className="st-h2">
          {matches.length ? "Here's where you fit best right now" : "No open matches yet"}
        </h2>
        {matches.length > 0 && (
          <p className="st-row" style={{ marginTop: 12 }} aria-label="Matches by tier">
            {TIERS.filter((t) => counts[t] > 0).map((t) => (
              <span key={t} className="st-row" style={{ gap: 8 }}>
                <span className="st-dot st-num" style={{ fontSize: 34 }}>
                  {counts[t]}
                </span>
                <span className="st-small st-muted">{TIER_LABELS[t].split(":")[0].toLowerCase()}</span>
              </span>
            ))}
          </p>
        )}
        <p className="st-lede st-small">
          Ranked from your answers{hadResume ? " and your resume" : ""}, with time to prepare counted in. Every card says why it's here.
        </p>
        {sample && (
          <div style={{ marginTop: 12 }}>
            <Note>
              <strong>These are sample programs.</strong>{" "}
              {sampleSource === "live"
                ? "Novus's catalogue holds labelled examples while real programs are being verified, so these are not real programs. The steps you take work the same way."
                : "The live catalogue isn't reachable from here right now, so you're seeing labelled examples. The steps you take still work the same way."}
            </Note>
          </div>
        )}

        <div className="st-stack" style={{ marginTop: 16 }} role="group" aria-label="Filter matches">
          <div className="st-chips">
            {TIERS.map((t) => (
              <Chip key={t} pressed={filters.tiers.includes(t)} onClick={() => setFilters({ ...filters, tiers: toggleIn(filters.tiers, t) })}>
                {TIER_LABELS[t].split(":")[0]}
              </Chip>
            ))}
            <Chip pressed={filters.paidOnly} onClick={() => setFilters({ ...filters, paidOnly: !filters.paidOnly })}>
              Paid only
            </Chip>
            <Chip pressed={filters.remoteOnly} onClick={() => setFilters({ ...filters, remoteOnly: !filters.remoteOnly })}>
              Remote OK
            </Chip>
          </div>
          {cats.length > 1 && (
            <div className="st-chips">
              {cats.map((c) => (
                <Chip key={c} pressed={filters.types.includes(c)} onClick={() => setFilters({ ...filters, types: toggleIn(filters.types, c) })}>
                  {OPPORTUNITY_CATEGORY_LABELS[c]}
                </Chip>
              ))}
            </div>
          )}
        </div>
      </Glass>

      <div className="st-cards st-reveal" aria-live="polite">
        {visible.map((m) => (
          <MatchCard key={m.programId} match={m} bundle={bundles.get(m.programId)} />
        ))}
        {shown.length === 0 && matches.length > 0 && (
          <Glass>
            <p>Nothing matches those filters.</p>
            <button type="button" className="st-link" onClick={() => setFilters({ tiers: [], paidOnly: false, remoteOnly: false, types: [] })}>
              Clear filters
            </button>
          </Glass>
        )}
      </div>

      {matches.length === 0 && (
        <Glass>
          <p>
            Nothing open fits every answer right now. Widening your search drops paid-only, remote, timing and location limits; you can also change
            your answers or browse everything in Explore.
          </p>
          <WayForward onWiden={onWiden} onEditAnswers={onBack} />
        </Glass>
      )}

      {shown.length > visible.length && (
        <button type="button" className="st-btn" onClick={() => setExpanded(true)}>
          See {shown.length - visible.length} more
        </button>
      )}

      {matches.length > 0 && (
        <div className="st-actions">
          <button type="button" className="st-btn st-btn-go" onClick={onNext}>
            Pick your first door
          </button>
          <button type="button" className="st-btn st-btn-ghost" onClick={onBack}>
            Change my answers
          </button>
        </div>
      )}
    </div>
  );
}

export function MatchCard({ match, bundle, children, chosen }: { match: MatchView; bundle: ProgramBundle | undefined; children?: React.ReactNode; chosen?: boolean }) {
  const card = bundle?.card;
  const reqLine = requirementsLine(match.met, match.total);
  const name = card?.name ?? match.name ?? "Program";
  const org = card?.organizationName ?? match.organizationName;
  const why = match.evidence.length ? match.evidence : [];
  return (
    <Glass as="article" className="st-card" data-chosen={chosen ? "true" : undefined} aria-label={name}>
      <div className="st-row">
        <TierTag tier={match.tier} />
        {card?.isSample && <SampleBadge />}
      </div>
      <h3 className="st-h3">{name}</h3>
      {org && <p className="st-meta">{org}</p>}
      {match.reasons.length > 0 && (
        <ul className="st-reasons" aria-label="Why this is here">
          {match.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <div className="st-facts">
        <span className="st-meta">{match.feasibilityLabel ?? feasibilityLine(match)}</span>
        {card && compensationLabel(card) && <span className="st-meta">{compensationLabel(card)}</span>}
        {bundle?.meta.place && <span className="st-meta">{bundle.meta.place}</span>}
      </div>
      {reqLine && <p className="st-small" style={{ marginTop: 10 }}>{reqLine}</p>}
      {(match.missing.length > 0 || card?.summary || why.length > 0) && (
        <details className="st-details" style={{ marginTop: 10 }}>
          <summary>Why this?</summary>
          <div className="st-small st-muted" style={{ marginTop: 8 }}>
            {card?.summary && <p>{card.summary}</p>}
            {why.length > 0 && (
              <ul className="st-rows" style={{ marginTop: 6 }}>
                {why.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
            {match.missing.length > 0 && <p style={{ marginTop: 6 }}>What's missing: {match.missing.join(", ")}.</p>}
          </div>
        </details>
      )}
      {children}
    </Glass>
  );
}
