import { foldForMatch } from "../text";
import type { ParsedResume } from "../types";
import type { ExpectedResume } from "./resumes.sample";

/**
 * Field-level scoring for the SAMPLE suite. Scalars are exact matches after normalization
 * (case, accents, whitespace, edge punctuation). Entries are paired greedily by token-set
 * similarity of title plus organization; an unpaired entry counts all its fields as misses
 * (or as false positives when the parser invented it). Lists (skills, coursework, awards,
 * project names) are scored as sets.
 */

export interface Tally {
  tp: number;
  fp: number;
  fn: number;
}

export type Scores = Record<string, Tally>;

export const precision = (t: Tally): number => (t.tp + t.fp === 0 ? 1 : t.tp / (t.tp + t.fp));
export const recall = (t: Tally): number => (t.tp + t.fn === 0 ? 1 : t.tp / (t.tp + t.fn));
export const f1 = (t: Tally): number => {
  const p = precision(t);
  const r = recall(t);
  return p + r === 0 ? 0 : (2 * p * r) / (p + r);
};

export function norm(v: string | null | undefined): string {
  return foldForMatch(v ?? "")
    .replace(/[\s ]+/g, " ")
    .replace(/^[\s,.;:|*-]+|[\s,.;:|*-]+$/g, "")
    .trim();
}

function tally(scores: Scores, field: string): Tally {
  scores[field] ??= { tp: 0, fp: 0, fn: 0 };
  return scores[field] as Tally;
}

function scalar(scores: Scores, field: string, expected: string | null | undefined, actual: string | null | undefined): void {
  const t = tally(scores, field);
  const e = norm(expected);
  const a = norm(actual);
  if (e && a === e) t.tp++;
  else {
    if (e) t.fn++;
    if (a) t.fp++;
  }
}

function set(scores: Scores, field: string, expected: readonly string[], actual: readonly string[]): void {
  const t = tally(scores, field);
  const e = new Set(expected.map(norm).filter(Boolean));
  const a = new Set(actual.map(norm).filter(Boolean));
  for (const x of a) {
    if (e.has(x)) t.tp++;
    else t.fp++;
  }
  for (const x of e) if (!a.has(x)) t.fn++;
}

function tokens(s: string): Set<string> {
  return new Set(norm(s).split(/[^a-z0-9+#]+/).filter(Boolean));
}

export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 && y.size === 0) return 1;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

/** Greedy pairing by similarity, best pairs first; returns [expectedIndex, actualIndex] pairs. */
function pair<E, A>(expected: readonly E[], actual: readonly A[], key: (x: E | A) => string, min: number): Array<[number, number]> {
  const candidates: Array<{ i: number; j: number; s: number }> = [];
  expected.forEach((e, i) => actual.forEach((a, j) => candidates.push({ i, j, s: similarity(key(e), key(a)) })));
  candidates.sort((p, q) => q.s - p.s);
  const usedE = new Set<number>();
  const usedA = new Set<number>();
  const pairs: Array<[number, number]> = [];
  for (const c of candidates) {
    if (c.s < min || usedE.has(c.i) || usedA.has(c.j)) continue;
    usedE.add(c.i);
    usedA.add(c.j);
    pairs.push([c.i, c.j]);
  }
  return pairs;
}

export function scoreResume(expected: ExpectedResume, parsed: ParsedResume, scores: Scores = {}): Scores {
  scalar(scores, "contact.name", expected.contact.name, parsed.contact.name);
  scalar(scores, "contact.email", expected.contact.email, parsed.contact.email);
  scalar(scores, "contact.phone", expected.contact.phone, parsed.contact.phone);
  scalar(scores, "contact.location", expected.contact.location, parsed.contact.location);

  const eduKey = (x: { institution: string | null; area: string | null }): string => `${x.institution ?? ""} ${x.area ?? ""}`;
  const eduPairs = pair(expected.education, parsed.education, eduKey, 0.3);
  const eduFields = ["institution", "area", "degreeLevel", "endDate", "startDate", "score"] as const;
  for (const [i, j] of eduPairs) {
    const e = expected.education[i]!;
    const a = parsed.education[j]!;
    for (const f of eduFields) {
      if (f === "startDate" && e.startDate === undefined) continue;
      if (f === "score" && e.score === undefined) continue;
      scalar(scores, `education.${f}`, (e as unknown as Record<string, string | null | undefined>)[f], (a as unknown as Record<string, string | null>)[f]);
    }
  }
  expected.education.forEach((e, i) => {
    if (eduPairs.some(([x]) => x === i)) return;
    for (const f of eduFields) if ((e as unknown as Record<string, unknown>)[f]) tally(scores, `education.${f}`).fn++;
  });
  parsed.education.forEach((a, j) => {
    if (eduPairs.some(([, y]) => y === j)) return;
    for (const f of eduFields) if ((a as unknown as Record<string, unknown>)[f]) tally(scores, `education.${f}`).fp++;
  });

  const expKey = (x: { position: string | null; organization: string | null }): string => `${x.position ?? ""} ${x.organization ?? ""}`;
  const expPairs = pair(expected.experience, parsed.experience, expKey, 0.5);
  const expFields = ["position", "organization", "kind", "startDate", "endDate"] as const;
  for (const [i, j] of expPairs) {
    const e = expected.experience[i]!;
    const a = parsed.experience[j]!;
    for (const f of expFields) scalar(scores, `experience.${f}`, e[f], a[f]);
  }
  expected.experience.forEach((e, i) => {
    if (expPairs.some(([x]) => x === i)) return;
    for (const f of expFields) if (e[f]) tally(scores, `experience.${f}`).fn++;
  });
  parsed.experience.forEach((a, j) => {
    if (expPairs.some(([, y]) => y === j)) return;
    for (const f of expFields) if (a[f]) tally(scores, `experience.${f}`).fp++;
  });

  set(
    scores,
    "projects.name",
    expected.projects,
    parsed.projects.map((p) => p.name ?? "").filter(Boolean),
  );
  set(scores, "skills", expected.skills, parsed.skills);
  set(scores, "coursework", expected.coursework, parsed.coursework);
  set(scores, "awards", expected.awards, parsed.awards);
  return scores;
}

/** Sums tallies whose field name starts with a prefix ("education.", "contact."). */
export function group(scores: Scores, prefix: string): Tally {
  const out: Tally = { tp: 0, fp: 0, fn: 0 };
  for (const [k, t] of Object.entries(scores)) {
    if (!k.startsWith(prefix)) continue;
    out.tp += t.tp;
    out.fp += t.fp;
    out.fn += t.fn;
  }
  return out;
}
