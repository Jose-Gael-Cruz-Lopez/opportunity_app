import { isSensitiveKey } from "@shared/contracts/sensitive";
import { isStage, type Stage } from "./flow";

/**
 * Local autosave for onboarding. Only what is needed to resume the flow is kept, and only
 * non-sensitive values: the stage, quiz answers (minus private questions), the chosen program,
 * finished plan steps, filters and reminder choices.
 *
 * Never saved here, by construction: the resume file, its raw or redacted text, parsed fields,
 * names of recommenders, draft sentences, and any SensitiveAnswers. Those stay in React memory
 * and vanish when the tab closes. The study notes are explicit that raw resume text must not
 * go to localStorage.
 */

export const STORAGE_KEY = "novus.start.v1";

/** The minimal Storage surface we use, so tests can pass a Map-backed fake. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type QuizAnswerValue = string | number | boolean | null | string[];

export interface SavedProgress {
  v: 1;
  stage: Stage;
  /** Question id -> answer. `null` means skipped. */
  quizAnswers: Record<string, QuizAnswerValue>;
  /** Order the questions were answered in, so replay through answerQuiz is faithful. */
  quizOrder: string[];
  resumeSource: ResumeSource | null;
  chosenProgramId: string | null;
  doneStepIds: string[];
  filters: SavedFilters;
  reminder: SavedReminder | null;
  savedAt: string;
}

export type ResumeSource = "pdf" | "docx" | "paste" | "builder" | "none";
const RESUME_SOURCES: readonly ResumeSource[] = ["pdf", "docx", "paste", "builder", "none"];

export interface SavedFilters {
  tiers: string[];
  paidOnly: boolean;
  remoteOnly: boolean;
  types: string[];
}

export interface SavedReminder {
  /** ISO date of the reminder, YYYY-MM-DD. */
  date: string;
  /** Local time HH:MM. */
  time: string;
  /** A place word such as "library"; free text but short, and the student's own. */
  place: string;
}

export const EMPTY_FILTERS: SavedFilters = { tiers: [], paidOnly: false, remoteOnly: false, types: [] };

export function emptyProgress(now: Date): SavedProgress {
  return {
    v: 1,
    stage: "welcome",
    quizAnswers: {},
    quizOrder: [],
    resumeSource: null,
    chosenProgramId: null,
    doneStepIds: [],
    filters: { ...EMPTY_FILTERS },
    reminder: null,
    savedAt: now.toISOString(),
  };
}

function isAnswerValue(v: unknown): v is QuizAnswerValue {
  if (v === null) return true;
  if (typeof v === "string") return v.length <= 200;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "boolean") return true;
  return Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === "string" && x.length <= 80);
}

function stringList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length <= 120).slice(0, max);
}

/**
 * Keeps only allowed answers. A question id that looks sensitive (citizenship, pell, gender...)
 * is dropped even if a caller passed it, and `privateIds` lets the quiz mark its private screen.
 */
export function sanitizeAnswers(
  answers: Record<string, unknown>,
  privateIds: ReadonlySet<string> = new Set(),
): Record<string, QuizAnswerValue> {
  const out: Record<string, QuizAnswerValue> = {};
  for (const [id, value] of Object.entries(answers)) {
    if (privateIds.has(id) || isSensitiveKey(id)) continue;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) continue;
    if (!isAnswerValue(value)) continue;
    out[id] = value;
  }
  return out;
}

function sanitizeReminder(v: unknown): SavedReminder | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : null;
  const time = typeof r.time === "string" && /^\d{2}:\d{2}$/.test(r.time) ? r.time : null;
  const place = typeof r.place === "string" ? r.place.slice(0, 60) : "";
  return date && time ? { date, time, place } : null;
}

/** Parses whatever is in storage into a valid SavedProgress, or null when unusable. */
export function parseProgress(raw: string | null, privateIds?: ReadonlySet<string>): SavedProgress | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.v !== 1 || !isStage(d.stage)) return null;
  const answers = sanitizeAnswers((d.quizAnswers as Record<string, unknown>) ?? {}, privateIds);
  const f = (d.filters ?? {}) as Record<string, unknown>;
  return {
    v: 1,
    stage: d.stage,
    quizAnswers: answers,
    quizOrder: stringList(d.quizOrder, 40).filter((id) => id in answers),
    resumeSource: RESUME_SOURCES.includes(d.resumeSource as ResumeSource) ? (d.resumeSource as ResumeSource) : null,
    chosenProgramId: typeof d.chosenProgramId === "string" ? d.chosenProgramId.slice(0, 64) : null,
    doneStepIds: stringList(d.doneStepIds, 40),
    filters: {
      tiers: stringList(f.tiers, 3),
      paidOnly: f.paidOnly === true,
      remoteOnly: f.remoteOnly === true,
      types: stringList(f.types, 33),
    },
    reminder: sanitizeReminder(d.reminder),
    savedAt: typeof d.savedAt === "string" ? d.savedAt : new Date(0).toISOString(),
  };
}

/** Serializes after sanitizing, so a bug upstream cannot widen what reaches storage. */
export function serializeProgress(p: SavedProgress, privateIds?: ReadonlySet<string>): string {
  const clean: SavedProgress = {
    v: 1,
    stage: p.stage,
    quizAnswers: sanitizeAnswers(p.quizAnswers, privateIds),
    quizOrder: p.quizOrder.slice(0, 40),
    resumeSource: p.resumeSource,
    chosenProgramId: p.chosenProgramId,
    doneStepIds: p.doneStepIds.slice(0, 40),
    filters: { ...p.filters },
    reminder: sanitizeReminder(p.reminder),
    savedAt: p.savedAt,
  };
  clean.quizOrder = clean.quizOrder.filter((id) => id in clean.quizAnswers);
  return JSON.stringify(clean);
}

export function loadProgress(store: KeyValueStore | null, privateIds?: ReadonlySet<string>): SavedProgress | null {
  if (!store) return null;
  try {
    return parseProgress(store.getItem(STORAGE_KEY), privateIds);
  } catch {
    return null;
  }
}

export function saveProgress(store: KeyValueStore | null, p: SavedProgress, privateIds?: ReadonlySet<string>): boolean {
  if (!store) return false;
  try {
    store.setItem(STORAGE_KEY, serializeProgress(p, privateIds));
    return true;
  } catch {
    return false;
  }
}

export function clearProgress(store: KeyValueStore | null): void {
  if (!store) return;
  try {
    store.removeItem(STORAGE_KEY);
    store.removeItem(DRAFT_KEY);
  } catch {
    /* storage blocked: nothing to clear */
  }
}

/**
 * The "Why this program?" draft, kept on this device only when the student turns on "Keep my
 * draft on this device". It is a separate key from the autosave, which never holds free text,
 * so turning the option off (or "Forget this on my device") removes exactly this.
 */
export const DRAFT_KEY = "novus.start.draft.v1";
export const DRAFT_MAX_CHARS = 800;

export interface KeptDraft {
  programId: string;
  text: string;
}

export function loadDraft(store: KeyValueStore | null): KeptDraft | null {
  if (!store) return null;
  try {
    const raw = JSON.parse(store.getItem(DRAFT_KEY) ?? "null") as unknown;
    if (!raw || typeof raw !== "object") return null;
    const { programId, text } = raw as Record<string, unknown>;
    if (typeof programId !== "string" || typeof text !== "string" || !programId || programId.length > 100) return null;
    return { programId, text: text.slice(0, DRAFT_MAX_CHARS) };
  } catch {
    return null;
  }
}

export function saveDraft(store: KeyValueStore | null, draft: KeptDraft): boolean {
  if (!store) return false;
  try {
    store.setItem(DRAFT_KEY, JSON.stringify({ programId: draft.programId.slice(0, 100), text: draft.text.slice(0, DRAFT_MAX_CHARS) }));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(store: KeyValueStore | null): void {
  if (!store) return;
  try {
    store.removeItem(DRAFT_KEY);
  } catch {
    /* storage blocked: nothing to clear */
  }
}

/** A file name for "Download .txt": the program name in plain characters, never a student name. */
export function draftFileName(programName: string): string {
  const slug = programName
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .slice(0, 60);
  return `${slug || "application"}-why-this-program.txt`;
}

/** window.localStorage when it exists and works; private windows can throw on access. */
export function browserStore(): KeyValueStore | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const probe = "novus.start.probe";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}
