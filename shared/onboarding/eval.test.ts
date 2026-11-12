import { describe, expect, it } from "vitest";
import { effectiveDeadline } from "./feasibility";
import { QUIZ, estimateSeconds } from "./quiz";
import { findMatches } from "./match";
import { pickFirstDoor } from "./first-door";
import { SAMPLE_PERSONAS, buildSamplePrograms, runPersona, type SamplePersona } from "./sample";
import type { OnboardingProgram, StudentPreferences } from "./types";
import { categoriesForTypes } from "./vocab";

/**
 * Offline evaluation (SAMPLE DATA): eight synthetic personas against 31 sample programs.
 * Metric: recall of the persona's expected program in the top five matches, plus whether that
 * program is offered as a first door. The expected programs were chosen from each persona's
 * story; this is a regression check of the pipeline, not evidence about real students.
 *
 * Two comparisons travel with it, because recall@5 alone cannot separate methods on a catalogue
 * this small: plan 06's deadline-sort baseline (soonest deadline first among open programs of
 * the asked-for kinds that the student's year allows), scored by recall@1 and mean reciprocal
 * rank; and a no-resume ablation of the same personas, scored by the expected program's tier.
 */

const NOW = "2026-11-11T15:00:00Z";
const programs = buildSamplePrograms(NOW);

/** Plan 06's baseline: open (or opening within 30 days), not passed, asked-for kinds, year allowed; soonest deadline first. */
function deadlineBaseline(prefs: StudentPreferences, catalogue: readonly OnboardingProgram[]): string[] {
  const nowMs = Date.parse(NOW);
  const today = NOW.slice(0, 10);
  const soon = new Date(nowMs + 30 * 86_400_000).toISOString().slice(0, 10);
  const asked = new Set(prefs.categories);
  return catalogue
    .filter((p) => !p.flags.sensitiveAudience && (p.status === "open" || (p.status === "expected" && p.opensOn !== null && p.opensOn <= soon)))
    .filter((p) => asked.size === 0 || categoriesForTypes(p.opportunityTypes).some((c) => asked.has(c)))
    .filter((p) => prefs.classYear === null || p.classYears.length === 0 || p.classYears.includes(prefs.classYear))
    .map((p) => ({ p, ed: effectiveDeadline(p, nowMs, "America/New_York", today) }))
    .flatMap(({ p, ed }) => (ed === "passed" ? [] : [{ slug: p.slug, date: ed.date ?? "9999-12-31" }]))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.slug < b.slug ? -1 : 1))
    .map((x) => x.slug);
}

const rankOf = (slugs: readonly string[], slug: string): number => slugs.indexOf(slug) + 1;
const reciprocal = (rank: number): number => (rank > 0 ? 1 / rank : 0);
const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

function withoutResume(persona: SamplePersona): SamplePersona {
  return { ...persona, signals: null, resume: "none" };
}

const results = SAMPLE_PERSONAS.map((persona) => {
  const run = runPersona(persona, { now: NOW, programs });
  const set = findMatches({ preferences: run.preferences, signals: persona.signals, programs, now: NOW, k: 10 });
  const top5 = set.items.slice(0, 5).map((i) => i.slug);
  const door = pickFirstDoor(set, run.preferences, NOW);
  return {
    persona,
    run,
    set,
    rank: set.items.findIndex((i) => i.slug === persona.expectedSlug) + 1,
    hit: top5.includes(persona.expectedSlug),
    inDoor: door.options.some((o) => o.slug === persona.expectedSlug),
  };
});

describe("offline evaluation: eight sample personas, 31 sample programs", () => {
  for (const r of results) {
    it(`${r.persona.id}: expected program is in the top five (rank ${r.rank || "missing"})`, () => {
      expect(r.hit).toBe(true);
    });
  }

  it("reports recall@5 and first-door coverage", () => {
    const recall = results.filter((r) => r.hit).length / results.length;
    const door = results.filter((r) => r.inDoor).length / results.length;
    // Reported in the test output so the numbers travel with every run.
    console.info(`onboarding eval (sample data): recall@5 = ${recall.toFixed(3)} (${results.filter((r) => r.hit).length}/${results.length}), first-door coverage = ${door.toFixed(3)}`);
    expect(recall).toBeGreaterThanOrEqual(0.875);
    expect(door).toBeGreaterThanOrEqual(0.75);
  });

  it("puts each expected program in the strong tier", () => {
    for (const r of results) expect(r.set.items.find((i) => i.slug === r.persona.expectedSlug)?.tier).toBe("strong");
  });

  it("keeps every persona's quiz within 15 questions and five minutes", () => {
    for (const r of results) {
      expect(r.run.asked.length).toBeLessThanOrEqual(15);
      expect(estimateSeconds(r.run.state, r.run.asked)).toBeLessThanOrEqual(QUIZ.budgetSeconds);
    }
  });

  it("labels every shown program as sample data", () => {
    for (const r of results) {
      expect(r.set.containsSample).toBe(true);
      for (const item of r.set.items) {
        expect(item.isSample).toBe(true);
        expect(item.name.startsWith("Sample:")).toBe(true);
      }
    }
  });

  it("beats plan 06's deadline-sort baseline on recall@1 and mean reciprocal rank", () => {
    const pipelineRanks = results.map((r) => r.rank);
    const baselineRanks = results.map((r) => rankOf(deadlineBaseline(r.run.preferences, programs), r.persona.expectedSlug));
    const at1 = (ranks: readonly number[]) => ranks.filter((x) => x === 1).length;
    const mrr = (ranks: readonly number[]) => mean(ranks.map(reciprocal));
    console.info(
      `onboarding eval vs deadline baseline (sample data): recall@1 ${at1(pipelineRanks)}/8 vs ${at1(baselineRanks)}/8, MRR ${mrr(pipelineRanks).toFixed(3)} vs ${mrr(baselineRanks).toFixed(3)}`,
    );
    expect(at1(pipelineRanks)).toBeGreaterThan(at1(baselineRanks));
    expect(mrr(pipelineRanks)).toBeGreaterThan(mrr(baselineRanks));
  });

  it("still finds every expected program without a resume; the resume is what earns 'strong'", () => {
    const withResume = results.filter((r) => r.persona.signals !== null);
    const ablated = withResume.map((r) => {
      const run = runPersona(withoutResume(r.persona), { now: NOW, programs });
      const set = findMatches({ preferences: run.preferences, signals: null, programs, now: NOW });
      return { rank: rankOf(set.items.map((i) => i.slug), r.persona.expectedSlug), tier: set.items.find((i) => i.slug === r.persona.expectedSlug)?.tier, asked: run.asked.length };
    });
    const strongWith = withResume.filter((r) => r.set.items.find((i) => i.slug === r.persona.expectedSlug)?.tier === "strong").length;
    const strongWithout = ablated.filter((a) => a.tier === "strong").length;
    console.info(
      `onboarding eval resume ablation (sample data, ${withResume.length} personas with a resume): recall@5 ${withResume.filter((r) => r.hit).length} vs ${ablated.filter((a) => a.rank > 0 && a.rank <= 5).length} without, expected program strong ${strongWith} vs ${strongWithout} without`,
    );
    for (const a of ablated) {
      expect(a.rank).toBeGreaterThan(0);
      expect(a.rank).toBeLessThanOrEqual(5);
      expect(a.asked).toBeLessThanOrEqual(15);
    }
    expect(strongWith).toBeGreaterThan(strongWithout);
  });
});
