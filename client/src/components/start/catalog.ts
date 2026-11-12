import { ProgramCardSchema, ProgramDetailSchema, type ProgramCard, type ProgramDetail } from "@shared/contracts";
import { buildSamplePrograms, type SampleProgram } from "./fixtures";

/**
 * The programs onboarding matches against, loaded on the device. Matching itself runs in the
 * browser (the student's signals never leave it for matching), so this only fetches public
 * catalogue data: program cards, then lazily the detail (cycle, requirements) of the open ones.
 *
 * When the API is unreachable, returns too little, or answers with something that fails the
 * contracts, onboarding uses the labelled SAMPLE programs so the flow still works end to end.
 */

export type ProgramBundle = SampleProgram;

export interface Catalog {
  bundles: ProgramBundle[];
  /** True when any program shown is sample data (labelled on screen either way). */
  sample: boolean;
  /**
   * Where the programs came from: the live API (which may itself serve sample-seeded programs,
   * as every local and staging database does today), or the on-device fixtures because the API
   * was unreachable or answered too little.
   */
  source: "live" | "fixtures";
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Detail requests per onboarding; enough for a first match set without a long wait. */
export const MAX_DETAILS = 24;
export const MIN_LIVE_PROGRAMS = 3;
const TIMEOUT_MS = 6_000;

/** The national application date from a card, as YYYY-MM-DD, or null (rolling, TBD, window). */
export function applicationDate(card: ProgramCard): string | null {
  const d = card.deadlines.find((x) => x.kind === "application" && x.scope === "national" && (x.precision === "date_only" || x.precision === "exact"));
  return d?.localDate && /^\d{4}-\d{2}-\d{2}$/.test(d.localDate) ? d.localDate : null;
}

/** Joins a list card with its lazily loaded detail into the bundle the flow uses. */
export function bundleFrom(card: ProgramCard, detail: ProgramDetail): ProgramBundle | null {
  if (detail.program.id !== card.programId || detail.cycle.id !== card.programCycleId) return null;
  if (detail.program.sensitiveAudience) return null; // never linked to a student in onboarding without consent
  return {
    card,
    program: detail.program,
    cycle: detail.cycle,
    requirements: detail.requirements.filter((r) => r.programCycleId === detail.cycle.id),
    meta: { remote: false, place: "" },
  };
}

async function getJson(url: string, fetcher: FetchLike): Promise<unknown> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetcher(url, { headers: { accept: "application/json" }, signal: ctrl?.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    if (t) clearTimeout(t);
  }
}

export async function loadCatalog(now: Date, fetcher: FetchLike = (i, r) => fetch(i, r)): Promise<Catalog> {
  const samples: Catalog = { bundles: buildSamplePrograms(now), sample: true, source: "fixtures" };
  const list = await getJson("/api/v1/programs?status=open&classYear=first_year,second_year&limit=60", fetcher);
  const items = (list as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return samples;
  const cards = items
    .map((x) => ProgramCardSchema.safeParse(x))
    .filter((r) => r.success)
    .map((r) => r.data as ProgramCard)
    .filter((c) => c.status === "open" && !c.flags.sensitiveAudience)
    .slice(0, MAX_DETAILS);
  if (cards.length < MIN_LIVE_PROGRAMS) return samples;

  const details = await Promise.allSettled(
    cards.map(async (card) => {
      const raw = await getJson(`/api/v1/programs/${encodeURIComponent(card.slug)}`, fetcher);
      const parsed = ProgramDetailSchema.safeParse(raw);
      return parsed.success ? bundleFrom(card, parsed.data) : null;
    }),
  );
  const bundles = details
    .map((d) => (d.status === "fulfilled" ? d.value : null))
    .filter((b): b is ProgramBundle => b !== null);
  if (bundles.length < MIN_LIVE_PROGRAMS) return samples;
  return { bundles, sample: bundles.some((b) => b.card.isSample), source: "live" };
}
