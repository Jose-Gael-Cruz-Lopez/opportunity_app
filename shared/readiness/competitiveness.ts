import { bandForStudent, type BandLevels, type BandModel } from "./bands";
import { buildFunnel, currentStageFor, naturalFrequency, stageNoun, stageOddsSentence, transitionForStudent } from "./odds";
import type { Competitiveness, CompetitivenessBand, CompetitivenessBasis } from "../contracts/readiness";
import type { StageOdds } from "../contracts/registry";
import type { CountStage } from "../taxonomy";

/**
 * Part 3: competitiveness. Official counts first; a personal band only when an approved band
 * model passes every gate for this program and stage; otherwise the official base rate only.
 * No percentage, score or probability about the student ever leaves this function: a band is
 * one of four words, and every number in the basis is a program-level official count.
 */

export interface CompetitivenessInput {
  /** Official stage odds (official_publication rows only), any years. */
  readonly stageOdds: readonly StageOdds[];
  readonly nominationGated: boolean;
  /** The stage the student has reached (from their tracker or outcome), else the entry stage. */
  readonly studentStage?: CountStage | null;
  /** Programs open only to a status-defined group show official counts only (s09 N3). */
  readonly sensitiveAudience: boolean;
  /** Banded verified-report count from shared/disclosure's release(), e.g. "10-19". */
  readonly reportsBanded?: string | null;
  readonly newProgram?: boolean;
  /** Programs that do not select (first come, first served) have no competitiveness. */
  readonly nonCompetitive?: boolean;
  /** The approved band model for this type and stage (Phase 4), with the student's feature levels. */
  readonly band?: { readonly model: BandModel; readonly programId: string; readonly levels: BandLevels } | null;
  readonly methodologyUrl?: string | null;
}

export const BAND_LABELS: Record<CompetitivenessBand, string> = {
  above_typical: "Above typical",
  typical: "Typical",
  below_typical: "Below typical",
  same_for_everyone: "Same for everyone at this stage",
};

const MAX_SUMMARY = 400;

/** Joins sentences, dropping trailing ones that would push past the contract's 400 characters. */
function joinSentences(parts: readonly string[]): string {
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    const next = out ? `${out} ${part}` : part;
    if (next.length > MAX_SUMMARY) break;
    out = next;
  }
  return out || parts[0]!.slice(0, MAX_SUMMARY);
}

function sortedOdds(stageOdds: readonly StageOdds[]): StageOdds[] {
  return stageOdds
    .filter((o) => o.denominator > 0 && o.numerator >= 0 && o.numerator <= o.denominator)
    .slice()
    .sort((a, b) => b.cycleYear - a.cycleYear || a.fromStage.localeCompare(b.fromStage));
}

function cyclesOf(stageOdds: readonly StageOdds[]): number[] {
  return [...new Set(stageOdds.map((o) => o.cycleYear))].sort((a, b) => b - a).slice(0, 10);
}

function basisBase(input: CompetitivenessInput, stageOdds: StageOdds[], currentStage: CountStage): Omit<CompetitivenessBasis, "kind" | "summary"> {
  return {
    stageOdds,
    currentStage,
    factors: [],
    reportsBanded: input.sensitiveAudience ? null : (input.reportsBanded ?? null)?.slice(0, 80) ?? null,
    nEff: null,
    cycles: cyclesOf(stageOdds),
    modelVersion: null,
    methodologyUrl: input.methodologyUrl ?? null,
  };
}

/** Sentences describing the official odds that apply to the student's stage. */
function officialSentences(input: CompetitivenessInput, stageOdds: StageOdds[], currentStage: CountStage): string[] {
  const parts: string[] = [];
  const transition = transitionForStudent(stageOdds, currentStage, { nominationGated: input.nominationGated });
  if (transition) {
    const sentence = stageOddsSentence(transition.odds);
    parts.push(transition.conditional && input.nominationGated ? `If you are nominated: ${sentence}` : sentence);
  }
  // Nomination is decided campus by campus (quotas and pools differ), so it is never estimated.
  if (input.nominationGated && currentStage === "campus_applicants") {
    parts.push("Your campus decides its own nominations; Novus does not estimate those odds.");
  }
  const funnel = buildFunnel(stageOdds, { nominationGated: input.nominationGated });
  if (funnel.overall && funnel.steps.length > 1) {
    parts.push(`Across the whole program, ${funnel.overall.frequency} ${stageNoun(funnel.steps[0]!.odds.fromStage)} won.`);
  }
  return parts;
}

function noDataSummary(input: CompetitivenessInput): { reason: NonNullable<Competitiveness["reason"]>; summary: string } {
  if (input.sensitiveAudience) {
    return { reason: "sensitive_program", summary: "Novus shows only official counts for this program, and it has not published any." };
  }
  if (input.newProgram) return { reason: "new_program", summary: "This program is new, so there are no past counts yet." };
  return { reason: "no_official_counts", summary: "The program has not published applicant counts, so Novus shows no odds for it." };
}

/**
 * n_eff as displayed: rounded down to a multiple of 5, so a monthly refit that adds or deletes one
 * report does not show up as a changed number (differencing), and the size is never overstated.
 */
export function displayedNEff(nEff: number): number {
  return Number.isFinite(nEff) && nEff > 0 ? Math.floor(nEff / 5) * 5 : 0;
}

/**
 * The sentence that anchors every band to the stage's official rate: "Typical here means about
 * 3 in 10 nominees win; most applicants at this stage are not selected." The second clause is
 * added only when it is true of the official rate.
 */
function typicalMeansSentence(odds: StageOdds, frequency: string, stage: string): string {
  const verb = odds.toStage === "awards" ? "win" : "move on";
  const rate = odds.numerator / odds.denominator;
  const most = rate < 0.5 ? "; most applicants at this stage are not selected" : "";
  return `Typical here means ${frequency} ${stage} ${verb}${most}.`;
}

export function assessCompetitiveness(input: CompetitivenessInput): Competitiveness {
  const stageOdds = sortedOdds(input.stageOdds);
  const currentStage = currentStageFor(input.studentStage, input.nominationGated);
  const base = basisBase(input, stageOdds, currentStage);

  if (input.nonCompetitive) {
    return {
      status: "not_applicable",
      band: null,
      reason: null,
      basis: { ...base, stageOdds: [], cycles: [], reportsBanded: null, kind: "none", summary: "This program does not select among applicants, so there are no odds to show." },
    };
  }
  if (stageOdds.length === 0) {
    const { reason, summary } = noDataSummary(input);
    return { status: "insufficient_data", band: null, reason, basis: { ...base, kind: "none", summary } };
  }

  const official = officialSentences(input, stageOdds, currentStage);
  const officialOnly = (reason: Competitiveness["reason"], extra: string | null): Competitiveness => ({
    status: "official_odds_only",
    band: null,
    reason,
    basis: { ...base, kind: "official_counts", summary: joinSentences([...official, extra ?? ""]) },
  });

  if (input.sensitiveAudience) return officialOnly(null, null);
  if (!input.band) return officialOnly(null, "Personal bands need about 30 verified reports for this stage.");

  const outcome = bandForStudent(input.band.model, input.band.programId, input.band.levels);
  if (outcome.kind === "official_odds_only") return officialOnly(null, null);
  if (outcome.kind === "insufficient_data") {
    return officialOnly(
      outcome.reason,
      outcome.reason === "profile_incomplete"
        ? "Add your class year, GPA band and earlier-program answer to your profile to see a band."
        : "Not enough verified reports yet: bands need about 30 for this stage.",
    );
  }

  const transition = transitionForStudent(stageOdds, currentStage, { nominationGated: input.nominationGated });
  const stage = transition ? stageNoun(transition.odds.fromStage) : stageNoun(currentStage);
  const frequency = transition ? naturalFrequency(transition.odds.numerator, transition.odds.denominator, transition.odds.denominatorKind) : null;
  const model = input.band.model;
  const bandBasis = {
    ...base,
    kind: "outcome_model" as const,
    nEff: displayedNEff(outcome.nEff),
    cycles: [...model.cycles].sort((a, b) => b - a).slice(0, 10),
    modelVersion: model.modelVersion,
    methodologyUrl: model.methodologyUrl ?? base.methodologyUrl,
  };
  const ifNominated = transition?.conditional && input.nominationGated ? " if you are nominated" : "";
  const typicalMeans = transition && frequency ? typicalMeansSentence(transition.odds, frequency, stage) : "";
  if (outcome.kind === "same_for_everyone") {
    return {
      status: "available",
      band: "same_for_everyone",
      reason: null,
      basis: { ...bandBasis, summary: joinSentences([`Verified reports show no difference between applicants at this stage${ifNominated}.`, ...official]) },
    };
  }
  const label = `${BAND_LABELS[outcome.band]} for ${stage}${ifNominated}.`;
  const caution = "A band compares you with other applicants at this stage; it is not a prediction.";
  const spread = outcome.band === "below_typical" ? "Many students apply to several programs." : "";
  return {
    status: "available",
    band: outcome.band,
    reason: null,
    basis: { ...bandBasis, factors: [...outcome.factors].slice(0, 10), summary: joinSentences([label, typicalMeans, caution, spread, ...official]) },
  };
}
