/**
 * View models for the onboarding UI, and tolerant readers that build them from the outputs of
 * @shared/onboarding. That module is being written in parallel to an agreed interface; the
 * readers accept the agreed field names first and a few obvious synonyms second, so a small
 * naming drift shows up as a test failure here rather than a blank screen. Nothing here reads
 * or produces a numeric fit score: tiers, reasons and counts only (rule 4).
 */

export type Tier = "strong" | "good" | "stretch";
export const TIERS: readonly Tier[] = ["strong", "good", "stretch"];

export const TIER_LABELS: Record<Tier, string> = {
  strong: "Strong fit",
  good: "Good fit",
  stretch: "Stretch: worth a try",
};

export type QuestionKind = "single" | "multi" | "text" | "pair" | "resume" | "slider";

export interface OptionView {
  value: string;
  label: string;
  hint?: string;
}

export interface QuestionView {
  id: string;
  prompt: string;
  help?: string;
  kind: QuestionKind;
  options: OptionView[];
  /** Upper bound for multi-select questions. */
  max?: number;
  optional: boolean;
  /** Held in memory only; never autosaved or sent. */
  private: boolean;
  /** A value the resume already suggested; shown as an "Is this right?" confirmation. */
  prefill?: unknown;
  /** An option that clears the others ("Not sure yet", "None yet"). */
  exclusive?: string;
  slider?: SliderView;
  placeholder?: string;
  maxLength?: number;
  /** The quiz's own count ("step 4 of 12"), when it provides one. */
  progress?: { step: number; of: number };
}

export interface SliderView {
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  unit: string;
  maxLabel?: string;
}

export interface MatchView {
  programId: string;
  tier: Tier;
  reasons: string[];
  startBy: string | null;
  daysLeft: number | null;
  enoughTime: boolean;
  met: number;
  total: number;
  missing: string[];
  /** The engine's own one-line feasibility copy, when it provides one. */
  feasibilityLabel: string | null;
  /** The full "Why this?" list. */
  evidence: string[];
  /** Display fallbacks when the program bundle is not on the device. */
  name: string | null;
  organizationName: string | null;
}

export interface DoorOptionView {
  programId: string;
  rationale: string;
}

export interface PlanStepView {
  id: string;
  title: string;
  kind: string;
  minutes: number;
  due: string | null;
  /** The planner's "can be done before onboarding ends"; never means the step is done. */
  doneDuringOnboarding: boolean;
  /** The planner's line under the title ("Applications are not open yet; they open ..."). */
  detail?: string;
  /** Where the step happens (the official application, or the official page before it opens). */
  url?: string;
  /** The guidance date had already passed, so the step is due today. */
  late?: boolean;
}

type Rec = Record<string, unknown>;

function asRec(v: unknown): Rec | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : null;
}

function str(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v;
  return undefined;
}

function num(...vals: unknown[]): number | undefined {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x : str(asRec(x)?.text, asRec(x)?.label, asRec(x)?.message)))
    .filter((x): x is string => !!x);
}

const KINDS: readonly QuestionKind[] = ["single", "multi", "text", "pair", "resume", "slider"];

function readKind(q: Rec, options: OptionView[]): QuestionKind {
  const raw = str(q.kind, q.type, q.input)?.toLowerCase();
  if (raw) {
    if ((KINDS as readonly string[]).includes(raw)) return raw as QuestionKind;
    if (/multi|chips|checkbox/.test(raw)) return "multi";
    if (/single|radio|select|choice|confirm/.test(raw)) return "single";
    if (/this.?or.?that|pair|binary/.test(raw)) return "pair";
    if (/resume|upload|file/.test(raw)) return "resume";
    if (/slider|range|scale|number/.test(raw)) return "slider";
    if (/text|typeahead|free/.test(raw)) return "text";
  }
  if (q.multiple === true || num(q.max, q.maxSelections) !== undefined) return "multi";
  return options.length > 0 ? "single" : "text";
}

function readOption(o: unknown): OptionView | null {
  if (typeof o === "string") return { value: o, label: o };
  const r = asRec(o);
  if (!r) return null;
  const value = str(r.value, r.id, r.key);
  if (!value) return null;
  return { value, label: str(r.label, r.title, r.text) ?? value, hint: str(r.hint, r.help, r.description) };
}

function readSlider(v: unknown): SliderView | undefined {
  const r = asRec(v);
  const min = num(r?.min);
  const max = num(r?.max);
  if (!r || min === undefined || max === undefined || max <= min) return undefined;
  const step = num(r.step) ?? 1;
  const def = num(r.defaultValue, r.default) ?? min;
  return { min, max, step: step > 0 ? step : 1, defaultValue: Math.min(max, Math.max(min, def)), unit: str(r.unit) ?? "", maxLabel: str(r.maxLabel) };
}

function readProgress(v: unknown): { step: number; of: number } | undefined {
  const r = asRec(v);
  const step = num(r?.step);
  const of = num(r?.of, r?.total);
  return step !== undefined && of !== undefined && of > 0 ? { step, of } : undefined;
}

/**
 * Builds a QuestionView from one QUIZ question or a nextQuestion() result. A nextQuestion
 * result wraps the question with `suggested` (the resume's prefill value), per-student
 * `options` and `progress`. On a bare QUIZ question, `prefill` names the source of a
 * suggestion ("skills"), not a value, so it is not read as one.
 */
export function normalizeQuestion(input: unknown): QuestionView | null {
  const outer = asRec(input);
  if (!outer) return null;
  const inner = asRec(outer.question);
  const wrapped = !!inner && !outer.id;
  const q = wrapped ? inner! : outer;
  const id = str(q.id, q.key);
  const prompt = str(q.prompt, q.title, q.label, q.text);
  if (!id || !prompt) return null;
  const optionSource = wrapped && Array.isArray(outer.options) ? outer.options : Array.isArray(q.options) ? q.options : Array.isArray(q.choices) ? q.choices : [];
  const options = optionSource.map(readOption).filter((o): o is OptionView => o !== null);
  const prefill = wrapped ? (outer.suggested ?? undefined) : (q.suggested ?? undefined);
  return {
    id,
    prompt,
    help: str(q.help, q.hint, q.description, q.subtitle),
    kind: readKind(q, options),
    options,
    max: num(q.max, q.maxSelections),
    optional: q.optional === true || q.skippable === true || q.required === false,
    private: q.private === true || q.sensitive === true || q.deviceOnly === true,
    prefill,
    exclusive: str(q.exclusiveOption, q.exclusive),
    slider: readSlider(q.slider),
    placeholder: str(q.placeholder),
    maxLength: num(q.maxLength),
    progress: wrapped ? readProgress(outer.progress) : undefined,
  };
}

/** Reads QUIZ (a QuizSpec) into the list of questions, tolerating `questions` or a bare array. */
export function normalizeQuizSpec(spec: unknown): QuestionView[] {
  const arr = Array.isArray(spec) ? spec : (asRec(spec)?.questions as unknown);
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeQuestion).filter((q): q is QuestionView => q !== null);
}

function readTier(v: unknown): Tier {
  return v === "strong" || v === "good" || v === "stretch" ? v : "stretch";
}

/** One MatchSet item to a MatchView. Any numeric score field present is ignored on purpose. */
export function normalizeMatchItem(input: unknown): MatchView | null {
  const m = asRec(input);
  if (!m) return null;
  const programId = str(m.programId, m.id);
  if (!programId) return null;
  const feas = asRec(m.feasibility) ?? {};
  const req = asRec(m.requirementsMet) ?? {};
  const met = Math.max(0, Math.trunc(num(req.met) ?? 0));
  const total = Math.max(met, Math.trunc(num(req.total) ?? 0));
  return {
    programId,
    tier: readTier(m.tier),
    reasons: strArray(m.reasons).slice(0, 4),
    startBy: str(feas.startBy) ?? null,
    daysLeft: num(feas.daysLeft) ?? null,
    enoughTime: feas.enoughTime !== false,
    met,
    total,
    missing: strArray(m.missing ?? req.missing).slice(0, 6),
    feasibilityLabel: str(feas.label) ?? null,
    evidence: strArray(m.evidence).slice(0, 12),
    name: str(m.name) ?? null,
    organizationName: str(m.organizationName) ?? null,
  };
}

/** A MatchSet ({ items }) or a bare array to MatchViews, kept in the order given. */
export function normalizeMatchSet(input: unknown): MatchView[] {
  const arr = Array.isArray(input) ? input : (asRec(input)?.items as unknown);
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeMatchItem).filter((m): m is MatchView => m !== null);
}

/** FirstDoorChoice to up to three options with one rationale line each. */
export function normalizeFirstDoor(input: unknown): DoorOptionView[] {
  const r = asRec(input);
  const arr = Array.isArray(input) ? input : (r?.options ?? r?.choices ?? r?.items ?? r?.doors);
  if (!Array.isArray(arr)) return [];
  const out: DoorOptionView[] = [];
  for (const raw of arr) {
    const o = asRec(raw);
    if (!o) continue;
    const programId = str(o.programId, asRec(o.match)?.programId, asRec(o.item)?.programId);
    if (!programId || out.some((x) => x.programId === programId)) continue;
    out.push({ programId, rationale: str(o.rationale, o.reason, o.label, o.why) ?? "A good place to start" });
  }
  return out.slice(0, 3);
}

/** FirstApplicationPlan to its steps. */
export function normalizePlan(input: unknown): PlanStepView[] {
  const arr = Array.isArray(input) ? input : (asRec(input)?.steps as unknown);
  if (!Array.isArray(arr)) return [];
  const out: PlanStepView[] = [];
  for (const raw of arr) {
    const s = asRec(raw);
    if (!s) continue;
    const id = str(s.id, s.key);
    const title = str(s.title, s.label);
    if (!id || !title) continue;
    out.push({
      id,
      title,
      kind: str(s.kind, s.type) ?? "other",
      minutes: Math.max(0, Math.round(num(s.minutes, s.effortMinutes) ?? 0)),
      due: str(s.due, s.dueOn) ?? null,
      doneDuringOnboarding: s.doneDuringOnboarding === true,
      ...optionalStepFields(s),
    });
  }
  return out;
}

/** Only http(s) links reach an href; anything else (javascript:, data:) is dropped. */
function safeUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function optionalStepFields(s: Rec): Pick<PlanStepView, "detail" | "url" | "late"> {
  const out: Pick<PlanStepView, "detail" | "url" | "late"> = {};
  const detail = str(s.detail);
  if (detail) out.detail = detail.slice(0, 400);
  const url = safeUrl(s.url);
  if (url) out.url = url;
  if (s.late === true) out.late = true;
  return out;
}

/** Steps the student can finish inside onboarding, in plan order. */
export function quickSteps(steps: readonly PlanStepView[]): PlanStepView[] {
  return steps.filter((s) => s.doneDuringOnboarding);
}

/** Groups matches by tier in strong, good, stretch order, keeping order within a tier. */
export function groupByTier(matches: readonly MatchView[]): Record<Tier, MatchView[]> {
  const out: Record<Tier, MatchView[]> = { strong: [], good: [], stretch: [] };
  for (const m of matches) out[m.tier].push(m);
  return out;
}

export interface PlanMetaView {
  /** Two sentences with blanks from the planner, when it provides them. */
  draftTemplate: string | null;
  missingKeywords: string[];
}

/** The plan's extras around its steps (draft template, missing keywords). */
export function normalizePlanMeta(input: unknown): PlanMetaView {
  const r = asRec(input);
  const draft = asRec(r?.draft);
  return {
    draftTemplate: str(draft?.template) ?? null,
    missingKeywords: strArray(r?.missingKeywords).slice(0, 12),
  };
}
