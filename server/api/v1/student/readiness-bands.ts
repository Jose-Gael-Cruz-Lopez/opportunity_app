import { EMPTY_STUDENT_PROFILE, type EligibilityResult, type StageOdds, type StudentProfile } from "@shared/contracts";
import { DISCLOSURE, release } from "@shared/disclosure";
import { assessReadinessDetailed, currentStageFor, transitionForStudent, type BandModel, type ReadinessDetail } from "@shared/readiness";
import { decideProgramBand, type BandReadFailure } from "@shared/readiness/bands-store";
import type { CountStage } from "@shared/taxonomy";
import { localDateIn } from "@shared/time";
import type { Db } from "@server/db/client";
import { readProgramBandFacts, type ProgramBandFacts } from "@server/db/repos/bands";
import type { ReadinessSource, StudentStore } from "./ports";
import { evaluateServerEligibility, otherWorkloads, studentTimeZone, type ReadinessRequest } from "./readiness";

/**
 * Stored band models wired into readiness (plan 7.5.5; BUILD_REPORT section 5).
 *
 * On every readiness read the route gathers the program's band facts (live `band_models` rows,
 * live founder approvals, held cycles, the counted report total), decides at read time whether a
 * stored model may be used (shared/readiness/bands-store `decideProgramBand`), and hands
 * shared/readiness either that model or nothing:
 *
 * - every gate passes: `bandModel` is the stored model, so competitiveness may show a band word;
 * - anything else: `bandModel` is null, so competitiveness shows the official base rate only.
 *
 * `reportsBanded` is the program's counted report total released through shared/disclosure
 * (`public`: below 5 reads "fewer than 5", then bands and rounding), with today's reports
 * waiting for tomorrow and held cycles left out. Status-defined programs get neither.
 *
 * Privacy: band features come only from the profile allowlist inside shared/readiness
 * (class year, GPA band, prior-program answer). Nothing here logs, stores or returns the
 * failure reasons to the student; they exist for tests and the console.
 */

export type { ProgramBandFacts } from "@server/db/repos/bands";

export const NO_BAND_FACTS: ProgramBandFacts = { rows: [], opportunityTypes: [], approvedModelKeys: [], heldCycleIds: [], countedReports: 0 };

/** Where readiness reads band facts; the D1 binding is `createD1ReadinessBandsSource`. */
export interface ReadinessBandsSource {
  programBandFacts(programId: string, nowMs: number): Promise<ProgramBandFacts>;
}

export function createD1ReadinessBandsSource(db: Db): ReadinessBandsSource {
  return { programBandFacts: (programId, nowMs) => readProgramBandFacts(db, programId, nowMs) };
}

/** No stored models anywhere: every program reads the official base rate. */
export const NO_READINESS_BANDS: ReadinessBandsSource = {
  async programBandFacts() {
    return NO_BAND_FACTS;
  },
};

export interface ResolvedReadinessBands {
  readonly bandModel: BandModel | null;
  readonly reportsBanded: string | null;
  /** The key of the model in use, or null. */
  readonly modelKey: string | null;
  /** Why no model is used (empty when one is). Never sent to the student. */
  readonly failures: readonly BandReadFailure[];
}

/** The disclosure period name for a program's all-cycles total. */
const ALL_CYCLES = "all_cycles";

/** A counted report total as the public may see it, or null when there is nothing to say. */
export function reportsBandedLabel(counted: number): string | null {
  if (!Number.isInteger(counted) || counted <= 0) return null;
  const [table] = release([{ period: ALL_CYCLES, grain: "cycle", cycleKey: ALL_CYCLES, categories: {}, n: counted }], { audience: "public", grain: "cycle", dims: [] });
  if (!table) return null;
  if (table.suppressed) return `fewer than ${DISCLOSURE.audiences.public.minTotal} verified reports`;
  return `${table.total} verified reports`;
}

/** The same nomination rule shared/readiness applies (rule set or evaluator nomination, or a campus step). */
export function nominationGatedFor(source: ReadinessSource, eligibility: EligibilityResult | null): boolean {
  const nomination = source.ruleSet?.nomination ?? eligibility?.nomination ?? null;
  return nomination !== null || source.requirements.some((r) => r.kind === "campus_nomination");
}

function usableOdds(stageOdds: readonly StageOdds[]): StageOdds[] {
  return stageOdds.filter((o) => o.denominator > 0 && o.numerator >= 0 && o.numerator <= o.denominator);
}

/** UTC day of an instant (model freshness is counted in server days, not the student's zone). */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export interface BandResolveContext {
  readonly source: ReadinessSource;
  readonly nominationGated: boolean;
  readonly nowMs: number;
  /** The stage the student has reached, when known (the server does not know it yet). */
  readonly studentStage?: CountStage | null;
}

/** Decides, at read time, which stored model (if any) readiness may use, plus the report label. */
export function resolveReadinessBands(facts: ProgramBandFacts, ctx: BandResolveContext): ResolvedReadinessBands {
  const { program } = ctx.source;
  if (program.sensitiveAudience) return { bandModel: null, reportsBanded: null, modelKey: null, failures: ["sensitive_program"] };
  const reportsBanded = reportsBandedLabel(facts.countedReports);
  const stage = currentStageFor(ctx.studentStage ?? null, ctx.nominationGated);
  const transition = transitionForStudent(usableOdds(ctx.source.stageOdds), stage, { nominationGated: ctx.nominationGated });
  const decision = decideProgramBand<BandModel>(facts.rows, {
    programId: program.id,
    opportunityTypes: facts.opportunityTypes,
    sensitiveAudience: program.sensitiveAudience,
    transition: transition ? { fromStage: transition.odds.fromStage, toStage: transition.odds.toStage } : null,
    today: utcDay(ctx.nowMs),
    approvedModelKeys: facts.approvedModelKeys,
    heldCycleIds: facts.heldCycleIds,
  });
  return decision.live
    ? { bandModel: decision.model, reportsBanded, modelKey: decision.modelKey, failures: [] }
    : { bandModel: null, reportsBanded, modelKey: null, failures: decision.failures };
}

export interface BandedReadiness {
  readonly detail: ReadinessDetail;
  readonly bands: ResolvedReadinessBands;
}

/**
 * computeReadiness (./readiness.ts) plus the stored band model and the released report count.
 * With NO_BAND_FACTS the report is identical to computeReadiness's (readiness-bands.test.ts).
 */
export function computeReadinessWithBands(req: ReadinessRequest, facts: ProgramBandFacts): BandedReadiness {
  const zone = studentTimeZone(req.profile, req.browserTimeZone);
  const asOf = localDateIn(req.now, zone);
  const eligibility = evaluateServerEligibility(req, asOf);
  const { source } = req;
  const bands = resolveReadinessBands(facts, { source, nominationGated: nominationGatedFor(source, eligibility), nowMs: req.now });
  const detail = assessReadinessDetailed({
    program: {
      id: source.program.id,
      slug: source.program.slug,
      sensitiveAudience: source.program.sensitiveAudience,
      newProgram: source.program.newProgram,
    },
    cycle: {
      id: source.cycle.id,
      cycleKey: source.cycle.cycleKey,
      opensOn: source.cycle.opensOn,
      predictedOpensOn: source.cycle.predictedOpensOn,
    },
    deadlines: source.deadlines,
    requirements: source.requirements,
    requirementsChecked: source.requirementsChecked,
    eligibility,
    nomination: source.ruleSet?.nomination ?? null,
    profile: req.profile,
    ownCampusDeadline: req.trackerItem?.ownCampusDeadline ?? null,
    progress: req.progress,
    stageOdds: source.stageOdds,
    reportsBanded: bands.reportsBanded,
    bandModel: bands.bandModel,
    otherTracked: otherWorkloads(req.tracked, source.cycle.id),
    now: req.now,
    browserTimeZone: req.browserTimeZone,
    options: { methodologyUrl: req.methodologyUrl },
  });
  return { detail, bands };
}

export interface LoadedBandedReadiness extends BandedReadiness {
  readonly source: ReadinessSource;
  readonly profile: StudentProfile;
}

/**
 * Drop-in for routes.ts `loadReadiness`: loads the cycle and the student's own records, reads
 * the program's band facts, then computes the four parts. Null means 404 (unknown cycle or a
 * status-defined program, for which no band fact is even read).
 */
export async function loadBandedReadiness(
  store: StudentStore,
  bandsSource: ReadinessBandsSource | null | undefined,
  userId: string,
  programCycleId: string,
  opts: { now: number; browserTimeZone: string | null; methodologyUrl: string },
): Promise<LoadedBandedReadiness | null> {
  const source = await store.readinessSource(programCycleId);
  if (!source || source.program.sensitiveAudience) return null;
  const [stored, tracked, progress, facts] = await Promise.all([
    store.getProfile(userId),
    store.trackedCycles(userId),
    store.listRequirementProgress(userId),
    (bandsSource ?? NO_READINESS_BANDS).programBandFacts(source.program.id, opts.now),
  ]);
  const profile = stored ?? EMPTY_STUDENT_PROFILE;
  const institution = profile.institutionId ? await store.institution(profile.institutionId) : null;
  const participates = institution ? await store.participates(source.program.id, institution.id) : false;
  const banded = computeReadinessWithBands(
    {
      source,
      profile,
      trackerItem: tracked.find((t) => t.cycle.id === source.cycle.id)?.item ?? null,
      progress,
      tracked,
      institution,
      participates,
      now: opts.now,
      browserTimeZone: opts.browserTimeZone,
      methodologyUrl: opts.methodologyUrl,
    },
    facts,
  );
  return { source, profile, ...banded };
}
