/**
 * TEST ONLY. An in-memory StudentStore and SAMPLE registry records for route tests. Every program
 * here is invented: names start with "Sample", URLs are on example.org, and quotes start with
 * "Sample text, not a real program". Nothing here describes a real program's rules or odds.
 */
import {
  DeadlineSchema,
  EligibilityRuleSetSchema,
  NotificationPrefsSchema,
  StudentProfileUpdateSchema,
  findSensitiveKeys,
  type ConsentRecord,
  type Deadline,
  type EligibilityRuleSet,
  type InboxItem,
  type NotificationPrefs,
  type ProgramCard,
  type Requirement,
  type RequirementProgress,
  type StudentProfile,
  type TrackerItem,
} from "@shared/contracts";
import { EMPTY_STUDENT_PROFILE } from "@shared/contracts";
import type { InstitutionLike } from "@shared/eligibility";
import { computeDueAt, computeSortAt } from "@shared/time";
import goldenRuleSets from "@shared/eligibility/golden/rule-sets.json";
import { fail, ok } from "@server/db/repos/common";
import { applyRoadmapAction, sensitiveTagValues } from "@server/db/repos/students";
import { DEFAULT_NOTIFICATION_PREFS } from "@server/db/repos/notifications";
import type { ReadinessSource, RoadmapActionRecord, StudentStore, TrackedCycle } from "./ports";

export const sampleId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const SAMPLE_INSTITUTION: InstitutionLike = { id: sampleId(900), level: "four_year", calendar: "semester", academicYearStartMonth: 8 };

function deadline(fields: Omit<Deadline, "dueAt" | "sortAt" | "revision" | "verificationState" | "withdrawnAt" | "roundLabel" | "windowStart" | "windowEnd" | "tzSource">): Deadline {
  const base = { ...fields, roundLabel: "", windowStart: null, windowEnd: null, tzSource: fields.timeZone ? ("stated" as const) : null };
  const due = computeDueAt(base);
  const sort = computeSortAt(base);
  return DeadlineSchema.parse({
    ...base,
    dueAt: due === null ? null : new Date(due).toISOString(),
    sortAt: sort === null ? null : new Date(sort).toISOString(),
    revision: 1,
    verificationState: "verified",
    withdrawnAt: null,
  });
}

function sampleRuleSet(key: string, programCycleId: string): EligibilityRuleSet {
  const entry = (goldenRuleSets as { ruleSets: Record<string, { ruleSet: unknown }> }).ruleSets[key];
  if (!entry) throw new Error(`missing golden rule set ${key}`);
  return EligibilityRuleSetSchema.parse({ ...(entry.ruleSet as object), programCycleId });
}

function requirement(n: number, programCycleId: string, fields: Partial<Requirement> & Pick<Requirement, "kind" | "label">): Requirement {
  return {
    id: sampleId(n),
    programCycleId,
    detail: null,
    quantity: 1,
    wordLimit: null,
    deadlineId: null,
    effortHours: null,
    leadTimeDays: null,
    evidence: null,
    verificationState: "verified",
    ...fields,
  };
}

/** Nomination-gated sample award with a status-defined citizenship rule (checked privately). */
export const SAMPLE_CYCLE_ID = sampleId(201);
export const SAMPLE_PROGRAM_ID = sampleId(301);
export const SAMPLE_SOURCE: ReadinessSource = {
  program: {
    id: SAMPLE_PROGRAM_ID,
    slug: "sample-stem-research-award",
    name: "Sample STEM Research Award",
    organizationName: "Example Science Foundation",
    officialUrl: "https://example.org/sample-stem-research-award",
    summary: "Sample listing: an invented research award used in tests.",
    sensitiveAudience: false,
    isSample: true,
    newProgram: false,
  },
  cycle: { id: SAMPLE_CYCLE_ID, cycleKey: "ay-2026-27", opensOn: "2026-09-01", predictedOpensOn: null, applicationUrl: "https://example.org/sample-stem-research-award/apply" },
  deadlines: [
    deadline({ id: sampleId(401), programCycleId: SAMPLE_CYCLE_ID, kind: "nomination", scope: "national", institutionId: null, basis: "official", precision: "exact", tzMode: "fixed", localDate: "2027-01-29", localTime: "17:00", timeZone: "America/Chicago" }),
    deadline({ id: sampleId(402), programCycleId: SAMPLE_CYCLE_ID, kind: "program_start", scope: "national", institutionId: null, basis: "official", precision: "date_only", tzMode: "fixed", localDate: "2027-06-01", localTime: null, timeZone: "America/Chicago" }),
  ],
  requirements: [
    requirement(501, SAMPLE_CYCLE_ID, {
      kind: "essay",
      label: "Research essay",
      wordLimit: 1200,
      evidence: { basis: "snapshot", url: "https://example.org/sample-stem-research-award/essay", quote: "Sample text, not a real program: describe a research question you want to pursue.", retrievedOn: "2026-10-01" },
    }),
    requirement(502, SAMPLE_CYCLE_ID, { kind: "recommendation", label: "Letters of recommendation", quantity: 2 }),
    requirement(503, SAMPLE_CYCLE_ID, { kind: "campus_nomination", label: "Campus nomination" }),
  ],
  requirementsChecked: true,
  ruleSet: sampleRuleSet("sample-semester-standing", SAMPLE_CYCLE_ID),
  stageOdds: [],
};

/** A second sample with only non-sensitive rules (GPA, field, age, pathway). */
export const SAMPLE_GPA_CYCLE_ID = sampleId(202);
export const SAMPLE_GPA_SOURCE: ReadinessSource = {
  program: {
    id: sampleId(302),
    slug: "sample-summer-lab-program",
    name: "Sample Summer Lab Program",
    organizationName: "Example University Lab",
    officialUrl: "https://example.org/sample-summer-lab-program",
    summary: null,
    sensitiveAudience: false,
    isSample: true,
    newProgram: true,
  },
  cycle: { id: SAMPLE_GPA_CYCLE_ID, cycleKey: "summer-2027", opensOn: "2026-10-15", predictedOpensOn: null, applicationUrl: null },
  deadlines: [
    deadline({ id: sampleId(411), programCycleId: SAMPLE_GPA_CYCLE_ID, kind: "application", scope: "national", institutionId: null, basis: "official", precision: "date_only", tzMode: "applicant_local", localDate: "2027-02-15", localTime: null, timeZone: null }),
  ],
  requirements: [requirement(511, SAMPLE_GPA_CYCLE_ID, { kind: "resume", label: "Résumé" })],
  requirementsChecked: true,
  ruleSet: sampleRuleSet("sample-gpa-field-age", SAMPLE_GPA_CYCLE_ID),
  stageOdds: [],
};

/** A status-defined sample program: readiness and the assistant must answer 404. */
export const SAMPLE_SENSITIVE_CYCLE_ID = sampleId(203);
export const SAMPLE_SENSITIVE_SOURCE: ReadinessSource = {
  program: {
    id: sampleId(303),
    slug: "sample-status-defined-program",
    name: "Sample Status-Defined Program",
    organizationName: "Example Foundation",
    officialUrl: "https://example.org/sample-status-defined-program",
    summary: null,
    sensitiveAudience: true,
    isSample: true,
    newProgram: false,
  },
  cycle: { id: SAMPLE_SENSITIVE_CYCLE_ID, cycleKey: "ay-2026-27", opensOn: null, predictedOpensOn: null, applicationUrl: null },
  deadlines: [],
  requirements: [],
  requirementsChecked: false,
  ruleSet: null,
  stageOdds: [],
};

export const SAMPLE_SOURCES: readonly ReadinessSource[] = [SAMPLE_SOURCE, SAMPLE_GPA_SOURCE, SAMPLE_SENSITIVE_SOURCE];

/** Minimal sample cards for Ask Novus retrieval. */
export function sampleCard(source: ReadinessSource): ProgramCard {
  return {
    programId: source.program.id,
    programCycleId: source.cycle.id,
    slug: source.program.slug,
    cycleKey: source.cycle.cycleKey,
    name: source.program.name,
    organizationName: source.program.organizationName,
    summary: source.program.summary,
    opportunityTypes: ["undergraduate_fellowship"],
    status: "open",
    verification: { state: "verified", verifiedOn: "2026-10-01", verifiedBy: null, freshness: "fresh" },
    deadlines: [],
    opensOn: source.cycle.opensOn,
    prediction: null,
    classYears: ["first_year", "second_year"],
    majorFamilies: [],
    cipPrefixes: [],
    interestTags: [],
    aliases: [],
    flags: {
      paid: false,
      participantCost: false,
      applicationFee: false,
      pellDisplacement: false,
      sensitiveAudience: source.program.sensitiveAudience,
      identityAudience: false,
      nominationRequired: false,
    },
    compensation: null,
    applicationUrl: source.cycle.applicationUrl,
    officialUrl: source.program.officialUrl,
    prepDays: null,
    rules: null,
    rulesFromPreviousCycle: null,
    isSample: true,
  };
}

interface RoadmapMemory {
  templateKey: string | null;
  lastShownItemKeys: string[];
  actions: Map<string, RoadmapActionRecord & { programId: string | null }>;
}

export interface MemoryStoreOptions {
  readonly sources?: readonly ReadinessSource[];
  readonly institutions?: readonly InstitutionLike[];
  /** `${programId}|${institutionId}` pairs with a positive participation listing. */
  readonly participation?: readonly string[];
}

/**
 * Same contract as the D1 store, with plain maps. `calls` records each method name so tests can
 * prove a refused request never reached storage.
 */
export class MemoryStudentStore implements StudentStore {
  readonly calls: string[] = [];
  readonly profiles = new Map<string, StudentProfile>();
  readonly trackers = new Map<string, TrackerItem[]>();
  readonly prefs = new Map<string, NotificationPrefs>();
  readonly consents = new Map<string, ConsentRecord[]>();
  readonly progress = new Map<string, RequirementProgress[]>();
  readonly roadmaps = new Map<string, RoadmapMemory>();
  readonly feeds = new Map<string, string[]>();
  readonly inbox = new Map<string, InboxItem[]>();
  private readonly sources: Map<string, ReadinessSource>;
  private readonly institutions: Map<string, InstitutionLike>;
  private readonly participation: Set<string>;
  private seq = 0;

  constructor(opts: MemoryStoreOptions = {}) {
    this.sources = new Map((opts.sources ?? SAMPLE_SOURCES).map((s) => [s.cycle.id, s]));
    this.institutions = new Map((opts.institutions ?? [SAMPLE_INSTITUTION]).map((i) => [i.id, i]));
    this.participation = new Set(opts.participation ?? []);
  }

  private track(name: string): void {
    this.calls.push(name);
  }

  private nextId(): string {
    this.seq += 1;
    return `00000000-0000-4000-9000-${String(this.seq).padStart(12, "0")}`;
  }

  async getProfile(userId: string) {
    this.track("getProfile");
    return this.profiles.get(userId) ?? null;
  }

  async updateProfile(userId: string, update: Parameters<StudentStore["updateProfile"]>[1], _now: number) {
    this.track("updateProfile");
    if (findSensitiveKeys(update).length > 0) return fail("invalid", "sensitive_field_rejected");
    if (update.interestTags && sensitiveTagValues(update.interestTags).length > 0) return fail("invalid", "sensitive_field_rejected");
    const parsed = StudentProfileUpdateSchema.safeParse(update);
    if (!parsed.success) return fail("invalid");
    const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    const next = { ...(this.profiles.get(userId) ?? EMPTY_STUDENT_PROFILE), ...patch } as StudentProfile;
    this.profiles.set(userId, next);
    return ok(next);
  }

  async listTracker(userId: string) {
    this.track("listTracker");
    return [...(this.trackers.get(userId) ?? [])];
  }

  private liveConsent(userId: string, kind: string, programId: string | null): boolean {
    return (this.consents.get(userId) ?? []).some((c) => c.kind === kind && c.programId === programId && c.revokedAt === null);
  }

  async addTracker(userId: string, input: Parameters<StudentStore["addTracker"]>[1], now: number) {
    this.track("addTracker");
    const source = this.sources.get(input.programCycleId);
    if (!source) return fail("not_found");
    if (source.program.sensitiveAudience && !this.liveConsent(userId, "sensitive_tracking", source.program.id)) return fail("consent_required");
    const list = this.trackers.get(userId) ?? [];
    const existing = list.find((t) => t.programCycleId === input.programCycleId);
    if (existing) return ok(existing);
    const at = new Date(now).toISOString();
    const item: TrackerItem = {
      id: this.nextId(),
      programCycleId: input.programCycleId,
      programSlug: source.program.slug,
      cycleKey: source.cycle.cycleKey,
      status: input.status,
      statusSource: "student",
      ownCampusDeadline: null,
      submittedOn: null,
      nameInMessages: input.nameInMessages,
      createdAt: at,
      updatedAt: at,
      version: 1,
    };
    this.trackers.set(userId, [...list, item]);
    return ok(item);
  }

  async updateTracker(userId: string, itemId: string, update: Parameters<StudentStore["updateTracker"]>[2], now: number) {
    this.track("updateTracker");
    const list = this.trackers.get(userId) ?? [];
    const idx = list.findIndex((t) => t.id === itemId);
    const current = list[idx];
    if (!current) return fail("not_found");
    if (current.version !== update.version) return fail("version_conflict");
    const { version: _v, ...fields } = update;
    const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const next: TrackerItem = { ...current, ...defined, updatedAt: new Date(now).toISOString(), version: current.version + 1 };
    list[idx] = next;
    return ok(next);
  }

  async removeTracker(userId: string, itemId: string) {
    this.track("removeTracker");
    const list = this.trackers.get(userId) ?? [];
    const next = list.filter((t) => t.id !== itemId);
    this.trackers.set(userId, next);
    return next.length !== list.length;
  }

  async trackedCycles(userId: string): Promise<TrackedCycle[]> {
    this.track("trackedCycles");
    return (this.trackers.get(userId) ?? []).flatMap((item) => {
      const s = this.sources.get(item.programCycleId);
      return s ? [{ item, program: s.program, cycle: s.cycle, deadlines: s.deadlines, requirements: s.requirements }] : [];
    });
  }

  async getNotificationPrefs(userId: string) {
    this.track("getNotificationPrefs");
    return this.prefs.get(userId) ?? DEFAULT_NOTIFICATION_PREFS;
  }

  async saveNotificationPrefs(userId: string, prefs: NotificationPrefs) {
    this.track("saveNotificationPrefs");
    this.prefs.set(userId, NotificationPrefsSchema.parse(prefs));
  }

  async listConsents(userId: string) {
    this.track("listConsents");
    return [...(this.consents.get(userId) ?? [])];
  }

  async changeConsent(userId: string, change: Parameters<StudentStore["changeConsent"]>[1], now: number) {
    this.track("changeConsent");
    const list = this.consents.get(userId) ?? [];
    const at = new Date(now).toISOString();
    if (change.granted) {
      if (!this.liveConsent(userId, change.kind, change.programId)) {
        list.push({ kind: change.kind, textVersion: change.textVersion, grantedAt: at, revokedAt: null, programId: change.programId });
      }
    } else {
      for (const c of list) if (c.kind === change.kind && c.programId === change.programId && c.revokedAt === null) c.revokedAt = at;
    }
    this.consents.set(userId, list);
    return ok(true as const);
  }

  async listRequirementProgress(userId: string) {
    this.track("listRequirementProgress");
    return [...(this.progress.get(userId) ?? [])];
  }

  async setRequirementProgress(userId: string, update: Parameters<StudentStore["setRequirementProgress"]>[1], now: number) {
    this.track("setRequirementProgress");
    const entry: RequirementProgress = { ...update, updatedAt: new Date(now).toISOString() };
    const list = (this.progress.get(userId) ?? []).filter((p) => p.subjectKey !== update.subjectKey);
    this.progress.set(userId, [...list, entry]);
    return ok(entry);
  }

  private roadmap(userId: string): RoadmapMemory {
    let r = this.roadmaps.get(userId);
    if (!r) {
      r = { templateKey: null, lastShownItemKeys: [], actions: new Map() };
      this.roadmaps.set(userId, r);
    }
    return r;
  }

  async getRoadmapState(userId: string) {
    this.track("getRoadmapState");
    const r = this.roadmap(userId);
    return { templateKey: r.templateKey, lastShownItemKeys: [...r.lastShownItemKeys], actions: new Map(r.actions) };
  }

  async recordRoadmapAction(userId: string, itemKey: string, action: Parameters<StudentStore["recordRoadmapAction"]>[2], programId: string | null) {
    this.track("recordRoadmapAction");
    const r = this.roadmap(userId);
    const current = r.actions.get(itemKey) ?? { pinned: false, state: "open" as const };
    const next = applyRoadmapAction(current, action);
    r.actions.set(itemKey, { ...next, programId });
    return ok(next);
  }

  async saveRoadmapVisit(userId: string, itemKeys: readonly string[], templateKey: string | null) {
    this.track("saveRoadmapVisit");
    const r = this.roadmap(userId);
    r.lastShownItemKeys = [...itemKeys];
    r.templateKey = templateKey;
  }

  async readinessSource(programCycleId: string) {
    this.track("readinessSource");
    return this.sources.get(programCycleId) ?? null;
  }

  async readinessSourceBySlug(slug: string) {
    this.track("readinessSourceBySlug");
    return [...this.sources.values()].find((s) => s.program.slug === slug) ?? null;
  }

  async institution(institutionId: string) {
    this.track("institution");
    return this.institutions.get(institutionId) ?? null;
  }

  async participates(programId: string, institutionId: string) {
    this.track("participates");
    return this.participation.has(`${programId}|${institutionId}`);
  }

  async rotateCalendarFeed(userId: string, tokenHash: string) {
    this.track("rotateCalendarFeed");
    this.feeds.set(userId, [...(this.feeds.get(userId) ?? []), tokenHash]);
  }

  async listInbox(userId: string, _now: number, opts: { limit: number; before: { createdAt: number; id: string } | null }) {
    this.track("listInbox");
    const all = [...(this.inbox.get(userId) ?? [])].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
    const after = opts.before
      ? all.filter((i) => Date.parse(i.createdAt) < opts.before!.createdAt || (Date.parse(i.createdAt) === opts.before!.createdAt && i.id < opts.before!.id))
      : all;
    return after.slice(0, opts.limit);
  }

  async markInboxRead(userId: string, alertId: string, now: number) {
    this.track("markInboxRead");
    const item = (this.inbox.get(userId) ?? []).find((i) => i.id === alertId && i.readAt === null);
    if (!item) return false;
    item.readAt = new Date(now).toISOString();
    return true;
  }

  readonly deleted = new Map<string, number>();

  async deleteAccount(userId: string, now: number) {
    this.track("deleteAccount");
    this.deleted.set(userId, now);
    this.feeds.delete(userId);
  }

  async searchCards(query: string, _now: number, limit: number) {
    this.track("searchCards");
    const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    return [...this.sources.values()]
      .filter((s) => words.some((w) => s.program.name.toLowerCase().includes(w)))
      .slice(0, limit)
      .map(sampleCard);
  }
}
