import type { DeadlineView } from "../contracts/registry";
import type { RoadmapItem } from "../contracts/roadmap";
import { CLASS_YEAR_LABELS, MAJOR_FAMILY_LABELS, type RequirementKind } from "../taxonomy";
import { addDays } from "../time/iso";
import { termKeyForDate } from "../time/terms";
import { daysFrom, earlierDate, laterDate, resolveZone, todayIn, toEpochMs, type NowInput } from "./dates";
import { effectiveDeadline, ROLLING_TARGET_DAYS, formatHours, type EffectiveDeadline } from "./feasibility";
import { DEFAULT_PREP_MODEL, latestStart, summarizeRequirements, SUBMIT_BUFFER_DAYS, type PrepModel, type RequirementLike } from "./schedule";
import { courseworkSkills, toMatchSignals } from "./signals";
import { normalizeSkillRefs, programSkills, skillLabel, skillPhrase } from "./skills";
import { isIsoDate } from "../time/iso";
import { compareStrings, joinLabels } from "./text";
import type {
  EligibilityCheck,
  FirstApplicationPlan,
  FirstDoorChoice,
  FirstDoorOption,
  MatchItem,
  MatchSet,
  MatchSignals,
  PlanStep,
  PlanStepKind,
  ProgramExtras,
  ServerPreferences,
  SignalsInput,
  StudentPreferences,
} from "./types";
import { interestTopic } from "./vocab";

/**
 * The "first door": onboarding ends with the student choosing one opportunity and finishing
 * its first small steps, the way Duolingo's first lesson happens inside onboarding.
 *
 * pickFirstDoor offers up to three feasible programs with one-line rationales and never picks
 * for the student (choosing is the commitment). planFirstApplication turns the chosen program's
 * Requirements into micro-steps doable now plus dated steps scheduled backward from the
 * deadline, so the student leaves with real progress ("2 of 7 done") and a next date.
 */

// ---------------------------------------------------------------------------------------------
// pickFirstDoor
// ---------------------------------------------------------------------------------------------

const FIRST_DOOR_WINDOW = { minDays: 14, maxDays: 60 } as const;

function stillOpen(item: MatchItem, today: string): boolean {
  const f = item.feasibility;
  return f.deadline === null || f.deadline >= today;
}

/** Deadline 14-60 days out, or rolling: urgency without panic. */
function inWindow(item: MatchItem): boolean {
  const f = item.feasibility;
  if (f.deadline === null) return f.basis === "rolling";
  return f.daysLeft >= FIRST_DOOR_WINDOW.minDays && f.daysLeft <= FIRST_DOOR_WINDOW.maxDays;
}

/** Hours of work in all; when only lead days are known, those stand in (more lead means slower to start). */
function effort(item: MatchItem): number {
  if (item.prep.hours !== null) return item.prep.hours;
  if (item.feasibility.prepDays !== null) return item.feasibility.prepDays;
  return Number.POSITIVE_INFINITY;
}

export function firstStepFor(item: Pick<MatchItem, "prep" | "audience">): FirstDoorOption["firstStep"] {
  if (item.audience.nominationRequired) return { title: "Email your fellowship office about the campus deadline", minutes: 5 };
  if ((item.prep.letters ?? 0) > 0) return { title: "Choose who to ask for a letter", minutes: 3 };
  if ((item.prep.essays ?? 0) > 0) return { title: "Draft the first two sentences of your answer", minutes: 5 };
  return { title: "Open the application and look at the questions", minutes: 5 };
}

/**
 * "Best match for ..." names the strongest evidence the card actually has, so the line is never
 * a claim the reasons do not back (a student who skipped the interest question is not told a
 * program is the best match for their interests).
 */
function bestMatchRationale(item: MatchItem, fundingGoal: boolean): string {
  if (fundingGoal) return "Best match for paying for school";
  const has = (code: string): boolean => item.reasonCodes.includes(code);
  if (has("EXPLORE")) return "A good one to try first";
  if (has("INTEREST_MATCH")) return "Best match for your interests";
  if (has("SKILL_MATCH")) return "Best match for your skills";
  if (has("MAJOR_MATCH")) return "Best match for your major";
  if (has("TYPE_MATCH") || has("LEANING_MATCH")) return "Best match for what you're looking for";
  return "A good one to try first";
}

/** The line for a further option, by what the card is: a pick to explore, a stretch, or another match. */
function againRationale(item: MatchItem): string {
  if (item.reasonCodes.includes("EXPLORE")) return "Another one to explore";
  if (item.tier === "stretch") return "A stretch worth trying";
  return item.tier === "strong" ? "Another strong match" : "Another good match";
}

function option(item: MatchItem, role: FirstDoorOption["role"], rationale: string): FirstDoorOption {
  return {
    programId: item.programId,
    programCycleId: item.programCycleId,
    slug: item.slug,
    name: item.name,
    tier: item.tier,
    role,
    rationale,
    firstStep: firstStepFor(item),
    feasibility: item.feasibility,
  };
}

/**
 * Up to three options:
 * - "named": the program the student typed, when the goal was something specific;
 * - "best_match": the highest-placed match, preferring a deadline 14-60 days out or rolling
 *   (for "help pay for school", the best scholarship or fellowship); its line names the
 *   strongest evidence the card has (interests, skills, major, kind), never more;
 * - "quickest": the least preparation in all, said only when it is true;
 * - "stretch": something from another category (or a stretch tier), so the choice is a real one;
 *   when nothing else differs, the slot is filled as "Another good match" instead.
 * Every option has enough time. Programs that serve a specific community are offered only when
 * nothing else is, because saving them needs a private consent step that does not belong in a
 * first session. Picks are made best-first, then shown in the order the student's goal favours
 * ("get my first yes" shows the quickest first).
 */
export function pickFirstDoor(matches: MatchSet, preferences: StudentPreferences | ServerPreferences, now: NowInput): FirstDoorChoice {
  const today = todayIn(toEpochMs(now), resolveZone(preferences.timeZone));
  const order = new Map(matches.items.map((i, idx) => [i.programId, idx]));
  const live = matches.items.filter((i) => stillOpen(i, today) && i.feasibility.enoughTime);
  const general = live.filter((i) => !i.audience.identity);
  const candidates = general.length > 0 ? general : live;
  const primary = candidates.filter((i) => i.tier !== "stretch");
  const pool = primary.length >= 3 ? primary : candidates;

  const chosen: FirstDoorOption[] = [];
  const usedOrgs = new Set<string>();
  const usedCats = new Set<string>();
  const take = (item: MatchItem | undefined, role: FirstDoorOption["role"], rationale: string): void => {
    if (!item || chosen.length >= 3 || chosen.some((c) => c.programId === item.programId)) return;
    chosen.push(option(item, role, rationale));
    usedOrgs.add(item.organizationName);
    for (const c of item.categories) usedCats.add(c);
  };
  const free = (i: MatchItem): boolean => !chosen.some((c) => c.programId === i.programId) && !usedOrgs.has(i.organizationName);
  const byOrder = (a: MatchItem, b: MatchItem): number => (order.get(a.programId) ?? 0) - (order.get(b.programId) ?? 0);
  const cmp = (a: number, b: number): number => (a < b ? -1 : a > b ? 1 : 0);
  const tierRank = { strong: 0, good: 1, stretch: 2 } as const;

  if (preferences.goal === "specific") {
    take(candidates.find((i) => i.reasonCodes.includes("TARGET_MATCH")), "named", "The one you named");
  }

  const funding = pool.filter((i) => i.categories.some((c) => c === "scholarships" || c === "fellowships"));
  const fundingGoal = preferences.goal === "funding" && funding.length > 0;
  const best = (fundingGoal ? funding : pool)
    .filter(free)
    .sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || Number(inWindow(b)) - Number(inWindow(a)) || byOrder(a, b))[0];
  if (best) take(best, "best_match", bestMatchRationale(best, fundingGoal));

  // "Quickest" is said only when it is true against the options already chosen.
  const quick = primary.filter(free).sort((a, b) => cmp(effort(a), effort(b)) || Number(inWindow(b)) - Number(inWindow(a)) || byOrder(a, b))[0];
  if (quick) {
    const fastest = chosen.every((c) => {
      const other = matches.items.find((i) => i.programId === c.programId);
      return other === undefined || effort(quick) < effort(other);
    });
    if (fastest && Number.isFinite(effort(quick))) {
      take(quick, "quickest", quick.prep.hours !== null ? `Quickest to start: about ${formatHours(quick.prep.hours)} of prep in all` : "Quickest to start");
    } else {
      take(quick, "best_match", againRationale(quick));
    }
  }

  // A different direction: a category not offered yet (stretches with enough time count),
  // then the higher tier, then match order.
  const different = candidates
    .filter(free)
    .map((i) => ({ i, newCat: i.categories.some((c) => !usedCats.has(c)) }))
    .sort((a, b) => Number(b.newCat) - Number(a.newCat) || tierRank[a.i.tier] - tierRank[b.i.tier] || byOrder(a.i, b.i))[0];
  if (different) {
    // "A different direction" only when it really is another kind of opportunity.
    const { i, newCat } = different;
    if (i.tier === "stretch") take(i, "stretch", againRationale(i));
    else if (newCat) take(i, "stretch", "A different direction worth a look");
    else take(i, "best_match", againRationale(i));
  }

  // Fill any empty slot in match order; organizations may repeat only when nothing else is left.
  for (const i of [...candidates].sort(byOrder)) {
    if (chosen.length >= 3) break;
    take(i, i.tier === "stretch" ? "stretch" : "best_match", againRationale(i));
  }

  const display: Record<FirstDoorOption["role"], number> =
    preferences.goal === "first_yes"
      ? { named: 0, quickest: 1, best_match: 2, stretch: 3 }
      : { named: 0, best_match: 1, quickest: 2, stretch: 3 };
  const options = chosen
    .map((o, i) => ({ o, i }))
    .sort((a, b) => display[a.o.role] - display[b.o.role] || a.i - b.i)
    .map(({ o }) => o);

  return {
    options,
    prompt: options.length > 1 ? "Pick one to start now. You can change it later." : "Start here. You can change it later.",
    fallback: options.length < 3 || primary.length < 3,
  };
}

// ---------------------------------------------------------------------------------------------
// planFirstApplication
// ---------------------------------------------------------------------------------------------

/** A Program (detail) or a ProgramCard: only these fields are read. */
export interface PlanProgram {
  readonly id?: string;
  readonly programId?: string;
  readonly slug: string;
  readonly name: string;
  readonly officialUrl: string;
  readonly organizationName?: string;
  readonly summary?: string | null;
  readonly aliases?: readonly string[];
  readonly interestTags?: readonly string[];
  readonly sensitiveAudience?: boolean;
  readonly identityAudience?: readonly string[];
  readonly flags?: { readonly sensitiveAudience?: boolean; readonly identityAudience?: boolean; readonly nominationRequired?: boolean };
  readonly deadlines?: readonly DeadlineView[];
  readonly programCycleId?: string;
  readonly cycleKey?: string;
  readonly applicationUrl?: string | null;
  readonly status?: string;
  readonly opensOn?: string | null;
  readonly isSample?: boolean;
  readonly extras?: ProgramExtras;
}

/** A ProgramCycle: only these fields are read. */
export interface PlanCycle {
  readonly id: string;
  readonly cycleKey: string;
  readonly status: string;
  readonly applicationUrl: string | null;
  readonly opensOn: string | null;
}

export type PlanPreferences = Pick<ServerPreferences, "timeZone" | "skills" | "interests" | "majorFamily" | "classYear">;

export interface FirstApplicationInput {
  /** A ProgramCard, or the contract's Program (which carries no flags or deadlines of its own). */
  readonly program: PlanProgram;
  readonly cycle?: PlanCycle | null;
  /** The cycle's Requirements (Program detail), or compact ones; empty means "not checked yet". */
  readonly requirements: readonly RequirementLike[];
  readonly signals?: SignalsInput | MatchSignals | null;
  readonly now: NowInput;
  /** Deadline rows (Program detail's Deadlines or a card's DeadlineViews); default: the card's rows. */
  readonly deadlines?: readonly DeadlineView[];
  /**
   * An effective deadline someone already resolved (YYYY-MM-DD in the student's zone), for
   * callers holding no deadline rows, such as the server's catalogue entries. Used only when no
   * rows are given; never shifted again for campus nomination.
   */
  readonly resolvedDeadline?: { readonly on: string; readonly basis?: "official" | "estimated" | "campus_estimate" } | null;
  /** Nomination-gated cycle (the card's flag, or the rule set's nomination block on the server). */
  readonly nominationRequired?: boolean;
  readonly preferences?: PlanPreferences | null;
  /** "Eligible if ..." checks from the match (evaluated on the device). */
  readonly checks?: readonly EligibilityCheck[];
  /** AI drafting help: available only with GEMINI_API_KEY on the server, used only with consent. */
  readonly ai?: { readonly available: boolean; readonly consented?: boolean } | null;
  /** Same as findMatches's prepModel (shared/readiness's table at integration), so dates agree. */
  readonly prepModel?: PrepModel;
}

export class FirstDoorClosedError extends Error {
  constructor() {
    super("every application deadline for this program has passed");
    this.name = "FirstDoorClosedError";
  }
}

interface DatedStepDef {
  readonly kind: PlanStepKind;
  readonly title: (qty: number) => string;
  readonly detail?: string;
}

const DATED_STEPS: Partial<Record<RequirementKind, DatedStepDef>> = {
  recommendation: { kind: "letters", title: (n) => (n === 1 ? "Ask for your letter" : `Ask for your ${n} letters`), detail: "Send each person your resume, the program link and the deadline." },
  resume: { kind: "resume", title: () => "Tailor your resume" },
  essay: { kind: "essay", title: (n) => (n === 1 ? "Write your essay" : `Write your ${n} essays`), detail: "Start from the two sentences you drafted today." },
  transcript: { kind: "transcript", title: () => "Request your transcript", detail: "An unofficial copy is often enough; check the official page." },
  test_score: { kind: "test", title: () => "Send your test scores" },
  portfolio: { kind: "portfolio", title: () => "Put your portfolio together" },
  interview: { kind: "interview", title: () => "Prepare for the interview" },
  fee: { kind: "fee", title: () => "Pay the fee or ask about a waiver" },
  other: { kind: "other", title: () => "Finish the other listed items" },
};

/** The next step in the student's own words, for the if-then plan ("I'll ask for my letters"). */
const FIRST_PERSON: Readonly<Record<string, string>> = {
  letters: "ask for my letters",
  resume: "tailor my resume",
  essay: "write my essay",
  transcript: "request my transcript",
  test: "send my test scores",
  portfolio: "put my portfolio together",
  interview: "prepare for the interview",
  fee: "sort out the fee",
  other: "finish the other listed items",
  list_requirements: "list what the application asks for",
  submit: "submit my application",
};

const KIND_ORDER: readonly RequirementKind[] = ["recommendation", "transcript", "test_score", "resume", "portfolio", "essay", "fee", "interview", "other"];

function minutesFor(hours: number | null): number {
  if (hours === null) return 30;
  return Math.max(5, Math.min(600, Math.round(hours * 60)));
}

function programIdOf(p: PlanProgram): string {
  return p.programId ?? p.id ?? p.slug;
}

function isCommunityProgram(p: PlanProgram): boolean {
  return Boolean(p.sensitiveAudience || p.flags?.sensitiveAudience || p.flags?.identityAudience || (p.identityAudience && p.identityAudience.length > 0));
}

/**
 * The deadline the plan works to. Deadline rows win (a card's or Program detail's); a deadline
 * the caller already resolved is used only when there are no rows; neither means "not announced".
 */
function planDeadline(input: FirstApplicationInput, nominationRequired: boolean, nowMs: number, tz: string, today: string): EffectiveDeadline | "passed" {
  const rows = input.deadlines ?? input.program.deadlines ?? [];
  const given = input.resolvedDeadline;
  if (rows.length === 0 && given && isIsoDate(given.on)) {
    if (given.on < today) return "passed";
    return { date: given.on, basis: given.basis ?? "official", campusStep: null };
  }
  return effectiveDeadline({ deadlines: rows, flags: { nominationRequired } }, nowMs, tz, today);
}

function draftTemplate(p: PlanProgram, prefs: PlanPreferences | null, studentSkills: readonly string[], programSkills: readonly string[]): string {
  const year = prefs?.classYear ? CLASS_YEAR_LABELS[prefs.classYear].toLowerCase() : "[your year]";
  const major = prefs?.majorFamily && prefs.majorFamily !== "undeclared" ? `${MAJOR_FAMILY_LABELS[prefs.majorFamily].toLowerCase()} student` : "student";
  const topic = prefs?.interests[0] ? interestTopic(prefs.interests[0])?.phrase : undefined;
  const shared = studentSkills.filter((s) => programSkills.includes(s));
  const skills = (shared.length > 0 ? shared : studentSkills).slice(0, 2).map(skillPhrase);
  const first = `I'm a ${year} ${major} who wants to ${topic ? `work on ${topic}` : "[what you want to work on]"}, and ${p.name} is my next step because [one specific thing about this program].`;
  const second = `In [a class, club or job], I used ${skills.length > 0 ? joinLabels(skills) : "[a skill]"} to [what you did], and here I want to [what you hope to learn].`;
  return `${first} ${second}`;
}

/**
 * Builds the plan. Micro-steps (save, private eligibility check, recommenders, two-sentence
 * draft, reminder, open the application) can all be finished in onboarding; the rest are
 * scheduled backward from the effective deadline with the guidance table, and the submit step
 * sits two days before it. No due date is ever before today: a guidance date that already
 * passed becomes "today" with `late: true`.
 */
export function planFirstApplication(input: FirstApplicationInput): FirstApplicationPlan {
  const { program, cycle = null } = input;
  const prefs = input.preferences ?? null;
  const model = input.prepModel ?? DEFAULT_PREP_MODEL;
  const nowMs = toEpochMs(input.now);
  const tz = resolveZone(prefs?.timeZone ?? null);
  const today = todayIn(nowMs, tz);
  const reqs = input.requirements;
  // A campus nomination requirement means the cycle is nomination-gated even when the program
  // record carries no flag (the contract's Program has none).
  const nominationRequired = Boolean(program.flags?.nominationRequired || input.nominationRequired || reqs.some((r) => r.kind === "campus_nomination"));
  const ed = planDeadline(input, nominationRequired, nowMs, tz, today);
  if (ed === "passed") throw new FirstDoorClosedError();

  const opensOn = cycle?.opensOn ?? program.opensOn ?? null;
  const applyBy = ed.date ?? addDays(opensOn && opensOn > today ? opensOn : today, ROLLING_TARGET_DAYS);
  const summary = summarizeRequirements(reqs, model);
  // Same rule as findMatches's feasibility, so the card and the plan show one date. With a real
  // deadline a past start-by is information ("tight"); a suggested apply-by date only paces the
  // student, so its start-by is never before today, and is today when preparation is unknown.
  const startBy =
    ed.date === null
      ? summary.prepDays === null
        ? today
        : laterDate(addDays(applyBy, -summary.prepDays), today)
      : summary.prepDays === null
        ? applyBy
        : addDays(applyBy, -summary.prepDays);
  const status = cycle?.status ?? program.status ?? "open";
  const applicationUrl = cycle?.applicationUrl ?? program.applicationUrl ?? null;

  // Skills: what the student has versus what the program text and listed skills name.
  const signals = toMatchSignals(input.signals ?? null);
  const studentSkills = [...new Set([...normalizeSkillRefs(prefs?.skills ?? []), ...signals.skills, ...courseworkSkills(signals)])];
  const programText = [program.name, ...(program.aliases ?? []), ...(program.interestTags ?? []), program.summary ?? ""].join(" . ");
  const listed = programSkills(program.extras?.skills, programText);
  const missingKeywords = listed.filter((s) => !studentSkills.includes(s)).map(skillLabel).slice(0, 12);

  // Submit two days early; no preparation step may fall after it or before today.
  const submitGuidance = ed.date ? addDays(applyBy, -SUBMIT_BUFFER_DAYS) : applyBy;
  const submitDue = laterDate(submitGuidance, today);
  const clampDue = (d: string): string => earlierDate(laterDate(d, today), submitDue);

  // Dated steps from the Requirements, one per kind, scheduled backward.
  const dated: PlanStep[] = [];
  for (const kind of KIND_ORDER) {
    const def = DATED_STEPS[kind];
    const items = reqs.filter((r) => r.kind === kind);
    if (!def || items.length === 0) continue;
    const qty = items.reduce((n, r) => n + Math.max(1, Math.floor(r.quantity ?? 1)), 0);
    const starts = items.map((r) => latestStart(applyBy, r, model)).filter((d): d is string => d !== null).sort();
    let guidance = starts[0] ?? addDays(applyBy, -SUBMIT_BUFFER_DAYS);
    // A resume needs a short tailoring pass soon, not at the last possible date.
    if (kind === "resume") guidance = guidance < addDays(today, 3) ? guidance : addDays(today, 3);
    const hours = summarizeRequirements(items, model).hours;
    const detail = kind === "resume" && missingKeywords.length > 0 ? `Add these if you have them: ${joinLabels(missingKeywords.slice(0, 4))}.` : def.detail;
    dated.push({
      id: def.kind,
      title: def.title(qty),
      kind: def.kind,
      minutes: minutesFor(hours),
      due: clampDue(guidance),
      ...(guidance < today ? { late: true } : {}),
      ...(detail ? { detail } : {}),
    });
  }
  if (reqs.length === 0) {
    dated.push({
      id: "list_requirements",
      title: "List what the application asks for",
      kind: "other",
      minutes: 15,
      due: clampDue(addDays(today, 3)),
      detail: "Novus has not checked this program's requirements yet. The official page has the full list.",
    });
  }
  dated.sort((a, b) => compareStrings(a.due ?? "", b.due ?? ""));

  const submit: PlanStep = {
    id: "submit",
    title: nominationRequired ? "Submit your campus application (two days early)" : ed.date ? "Submit (two days early)" : "Submit your application",
    kind: "submit",
    minutes: 30,
    due: submitDue,
    ...(submitGuidance < today ? { late: true } : {}),
    ...(ed.date ? {} : { detail: ed.basis === "rolling" ? "Rolling admission: earlier is better." : "The deadline is not announced yet; this is a suggested date." }),
  };

  // Micro-steps for right now.
  const checks = input.checks ?? [];
  const firstPublic = checks.find((c) => !c.sensitive && c.resolver === "student");
  const privateCount = checks.filter((c) => c.sensitive).length;
  const letters = summary.letters;
  const aiOn = Boolean(input.ai?.available && input.ai.consented);
  const community = isCommunityProgram(program);
  const next = dated[0] ?? submit;
  // Quick steps fit the five-minute promise: about four minutes in all (save, one eligibility
  // check, two sentences). doneDuringOnboarding means "can be done before onboarding ends", never
  // "is done": completion comes only from the student's own completedStepIds. Each quick step but
  // save also has a due date, so a skipped one still becomes a roadmap item and a reminder.
  const quick: PlanStep[] = [
    {
      id: "save",
      title: "Save it to your Tracker",
      kind: "save",
      minutes: 1,
      doneDuringOnboarding: true,
      detail: community ? "Saved on this device only, unless you choose to add it to your account." : "You'll get a reminder before each date.",
    },
    {
      id: "eligibility",
      title: "Check the eligibility rules privately",
      kind: "eligibility",
      minutes: 1,
      due: clampDue(addDays(today, 2)),
      doneDuringOnboarding: true,
      detail:
        checks.length === 0
          ? "Read the official eligibility section once to be sure."
          : `${checks.length === 1 ? "One rule" : `${checks.length} rules`} to confirm on this device${privateCount > 0 ? " (your answers are never sent)" : ""}${firstPublic ? `, starting with: ${firstPublic.text}` : "."}`.slice(0, 400),
    },
    {
      id: "draft",
      // With no essay listed, the same two sentences answer "Why this program?" in a form or an interview.
      title: summary.essays > 0 ? "Draft the first two sentences of your essay" : "Draft two sentences on why you want this",
      kind: "draft",
      minutes: 2,
      due: clampDue(addDays(today, 3)),
      doneDuringOnboarding: true,
      detail: aiOn ? "Start from the template. AI suggestions are on for the text you choose to send." : "Start from the template. AI suggestions are off.",
    },
  ];
  // Short steps for the next few days. The student may do them now, but they are not part of
  // the five minutes, and each one is dated so it reaches the roadmap and reminders.
  const soon: PlanStep[] = [];
  if (nominationRequired) {
    soon.push({
      id: "nomination",
      title: "Email your fellowship office about the campus deadline",
      kind: "nomination",
      minutes: 5,
      due: clampDue(addDays(today, 2)),
      detail: "Campus deadlines often come weeks before the national one. Ask for the date and the process.",
    });
  }
  if (letters > 0) {
    soon.push({
      id: "recommenders",
      title: letters === 1 ? "Choose who to ask for a letter" : `Choose the ${letters} people to ask for letters`,
      kind: "recommenders",
      minutes: 3,
      due: clampDue(addDays(today, 3)),
      detail: "A professor, TA, coach or supervisor who has seen your work. You'll ask them later, on the date below.",
    });
  }
  soon.push(
    {
      id: "reminder",
      title: "Pick a time for your next step",
      kind: "reminder",
      minutes: 1,
      due: clampDue(addDays(today, 1)),
      detail: `Finish the sentence: "On [day] at [time], at [place], I'll ${FIRST_PERSON[next.id] ?? "work on the next step"}." We'll remind you then.`.slice(0, 400),
    },
    {
      id: "open_application",
      title: status === "open" ? "Open the official application" : "Bookmark the official page",
      kind: "open_application",
      minutes: 3,
      due: clampDue(addDays(today, 3)),
      url: status === "open" && applicationUrl ? applicationUrl : program.officialUrl,
      detail: status === "open" ? "Make your account and read the questions. Nothing to submit yet." : `Applications are not open yet${opensOn ? `; they open ${opensOn}` : ""}.`,
    },
  );
  const later = [...soon, ...dated].sort((a, b) => compareStrings(a.due ?? "", b.due ?? ""));

  const steps = [...quick, ...later, submit];
  const ai = input.ai;
  return {
    v: 1,
    asOf: today,
    programId: programIdOf(program),
    programCycleId: cycle?.id ?? program.programCycleId ?? null,
    slug: program.slug,
    name: program.name,
    cycleKey: cycle?.cycleKey ?? program.cycleKey ?? null,
    officialUrl: program.officialUrl,
    applicationUrl,
    deadline: ed.date,
    deadlineBasis: ed.basis,
    startBy,
    daysLeft: daysFrom(today, applyBy),
    steps,
    doableNow: quick.length,
    draft: {
      template: draftTemplate(program, prefs, studentSkills, listed),
      ai: aiOn ? "on" : "off",
      note: aiOn
        ? "AI suggestions see only the text you choose to send, after you review it."
        : ai?.available
          ? "Turn on AI suggestions if you want ideas. You'll see exactly what is sent first."
          : "AI suggestions are off. The template works without them.",
    },
    privacy: {
      deviceOnly: community,
      note: community
        ? "This program serves a specific community, so your plan stays on this device unless you choose to save it to your account."
        : "Saving creates a Tracker item and reminders in your account after you sign up.",
    },
    missingKeywords,
    isSample: Boolean(program.isSample),
  };
}

// ---------------------------------------------------------------------------------------------
// Hand-off to the Tracker and Roadmap (used by POST /onboarding/first-door)
// ---------------------------------------------------------------------------------------------

function confidence(basis: FirstApplicationPlan["deadlineBasis"]): RoadmapItem["dateConfidence"] {
  if (basis === "official") return "official";
  if (basis === "estimated" || basis === "campus_estimate") return "estimated";
  return "unknown";
}

/**
 * A plan step that should still reach the roadmap: every dated step, except a quick step the
 * student actually finished during onboarding. Completion comes only from `done`; the plan's
 * doneDuringOnboarding flag says a step can be done now, not that it was.
 */
function stillPlanned(s: PlanStep, done: ReadonlySet<string>): boolean {
  return s.due !== undefined && !(s.doneDuringOnboarding && done.has(s.id));
}

/**
 * RoadmapItems for the plan's dated steps (quick steps finished in onboarding are not roadmap
 * items; skipped ones are). The submit step becomes the pinned "apply" item; the others are
 * "prepare" items.
 */
export function planToRoadmapItems(plan: FirstApplicationPlan, opts: { doneStepIds?: readonly string[] } = {}): RoadmapItem[] {
  const done = new Set(opts.doneStepIds ?? []);
  return plan.steps
    .filter((s) => stillPlanned(s, done))
    .map((s) => {
      const isSubmit = s.kind === "submit";
      const key = isSubmit ? `apply:${plan.programId}${plan.cycleKey ? `:${plan.cycleKey}` : ""}` : `prep:${plan.programId}:${s.id}`;
      return {
        itemKey: key.slice(0, 115),
        kind: isSubmit ? "apply" : "prepare",
        term: termKeyForDate(s.due as string),
        title: s.title,
        detail: s.detail ?? null,
        programId: plan.programId,
        programSlug: plan.slug,
        programCycleId: plan.programCycleId,
        cycleKey: plan.cycleKey,
        dueOn: s.due as string,
        startBy: isSubmit ? plan.startBy : (s.due as string),
        dateConfidence: confidence(plan.deadlineBasis),
        state: done.has(s.id) ? "done" : "open",
        pinned: isSubmit,
        reasonCodes: isSubmit ? ["FIRST_DOOR", "START_BY"] : ["FIRST_DOOR"],
        source: "student",
      } satisfies RoadmapItem;
    });
}

export interface PlanReminder {
  readonly stepId: string;
  readonly title: string;
  /** Day to remind (the day before the step is due, never before today). */
  readonly on: string;
}

/** Reminders for the next open dated steps, at most five, the day before each is due. */
export function planReminders(plan: FirstApplicationPlan, max = 5, opts: { doneStepIds?: readonly string[] } = {}): PlanReminder[] {
  const done = new Set(opts.doneStepIds ?? []);
  return plan.steps
    .filter((s) => s.due !== undefined && !done.has(s.id))
    .slice(0, max)
    .map((s) => ({ stepId: s.id, title: s.title, on: laterDate(addDays(s.due as string, -1), plan.asOf) }));
}
