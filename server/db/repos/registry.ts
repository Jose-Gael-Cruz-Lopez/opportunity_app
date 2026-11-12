import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  COUNT_STAGES,
  CYCLE_STATUSES,
  canTransitionCycle,
  type ClassYear,
  type CountStage,
  type CycleStatus,
  type EvidenceEntity,
  type MajorFamily,
  type OpportunityTypeSlug,
} from "../../../shared/taxonomy";
import { computeDueAt, computeSortAt, isInSeason, freshness, verificationState, revisionChanged } from "../../../shared/time";
import type {
  Compensation,
  Deadline,
  DeadlineView,
  Organization,
  Prediction,
  Program,
  ProgramCard,
  ProgramCycle,
  ProgramCycleCount,
  ProgramDetail,
  ProgramFlags,
  Requirement,
  StageOdds,
} from "../../../shared/contracts/registry";
import { deadlineIssues } from "../../../shared/contracts/registry";
import {
  EligibilityRuleSetDraftSchema,
  EligibilityRuleSetSchema,
  type EligibilityRuleSet,
  type EligibilityRuleSetDraft,
} from "../../../shared/contracts/eligibility";
import type { EvidenceQuote, FieldEvidence, RecordCitation } from "../../../shared/contracts/evidence";
import type { ChangeEventType } from "../../../shared/contracts/events";
import type { Db } from "../client";
import * as s from "../schema";
import { uuidv7 } from "../columns";
import { iso, isoOrNull, ruleSetHash, utcDate } from "../util";
import { registryAuditInsert, type RegistryAuditInput } from "./audit";
import { classifyWriteError, fail, jsonIds, ok, runBatch, versionGuard, type RepoResult, type Stmt } from "./common";

/**
 * Registry repository: organizations, programs, cycles, deadlines, requirements, eligibility rule
 * sets, sources, snapshots and evidence, plus the read models (cards and detail) the API and the
 * release build serve. Reads assemble in memory from a handful of indexed queries; writes that
 * publish facts are guarded batches that also append registry audit rows and ChangeEvents.
 */

type ProgramRow = typeof s.programs.$inferSelect;
type CycleRow = typeof s.programCycles.$inferSelect;
type DeadlineRow = typeof s.deadlines.$inferSelect;
type RequirementRow = typeof s.requirements.$inferSelect;
type RuleSetRow = typeof s.eligibilityRuleSets.$inferSelect;
type OrganizationRow = typeof s.organizations.$inferSelect;
type EvidenceRow = typeof s.fieldEvidence.$inferSelect;
type CountRow = typeof s.programCycleCounts.$inferSelect;
type PredictionRow = typeof s.cyclePredictions.$inferSelect;

// =============================================================================================
// Pure mappers (row -> contract)
// =============================================================================================

export function toOrganization(row: OrganizationRow): Organization {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind as Organization["kind"],
    country: row.country,
    defaultTimeZone: row.defaultTimeZone,
    websiteUrl: row.websiteUrl,
    isSample: row.isSample,
  };
}

export interface ProgramParts {
  types: readonly OpportunityTypeSlug[];
  aliases: readonly string[];
  tags: readonly string[];
  majorFamilies: readonly MajorFamily[];
}

export function toProgram(row: ProgramRow, parts: ProgramParts): Program {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    organizationId: row.organizationId,
    summary: row.summary,
    officialUrl: row.officialUrl,
    recurrence: row.recurrence as Program["recurrence"],
    lifecycle: row.lifecycle as Program["lifecycle"],
    opportunityTypes: [...parts.types],
    sensitiveAudience: row.sensitiveAudience,
    identityAudience: [...row.identityAudience],
    majorFamilies: [...parts.majorFamilies],
    interestTags: [...parts.tags],
    aliases: [...parts.aliases],
    isWedge: row.isWedge,
    isPublished: row.isPublished,
    isSample: row.isSample,
    version: row.version,
  };
}

export function toCycle(row: CycleRow, handles: ReadonlyMap<string, string>): ProgramCycle {
  return {
    id: row.id,
    programId: row.programId,
    cycleKey: row.cycleKey,
    termLabel: row.termLabel,
    cycleModel: row.cycleModel as ProgramCycle["cycleModel"],
    status: row.status as CycleStatus,
    statusChangedAt: iso(row.statusChangedAt),
    // A Curator id becomes their public handle; system actors pass through.
    statusChangedBy: handles.get(row.statusChangedBy) ?? row.statusChangedBy,
    timeZone: row.timeZone,
    opensOn: row.opensOn,
    predictedOpensOn: row.predictedOpensOn,
    predictionLabel: row.predictionLabel as ProgramCycle["predictionLabel"],
    decisionWindowStart: row.decisionWindowStart,
    decisionWindowEnd: row.decisionWindowEnd,
    decisionsReleasedOn: row.decisionsReleasedOn,
    eventStart: row.eventStart,
    eventEnd: row.eventEnd,
    applicationUrl: row.applicationUrl,
    pellDisplacement: row.pellDisplacement as ProgramCycle["pellDisplacement"],
    applicationFeeCents: row.applicationFeeCents,
    participantCostCents: row.participantCostCents,
    compensation: row.compensation,
    verificationState: row.verificationState as ProgramCycle["verificationState"],
    lastVerifiedAt: isoOrNull(row.lastVerifiedAt),
    verifiedBy: row.verifiedBy ? (handles.get(row.verifiedBy) ?? null) : null,
    sourceCheckedAt: isoOrNull(row.sourceCheckedAt),
    rolledOverFromId: row.rolledOverFromId,
    version: row.version,
  };
}

export function toDeadline(row: DeadlineRow): Deadline {
  return {
    id: row.id,
    programCycleId: row.programCycleId,
    kind: row.kind as Deadline["kind"],
    scope: row.scope as Deadline["scope"],
    institutionId: row.institutionId,
    roundLabel: row.roundLabel,
    basis: row.basis as Deadline["basis"],
    precision: row.precision as Deadline["precision"],
    tzMode: row.tzMode as Deadline["tzMode"],
    localDate: row.localDate,
    localTime: row.localTime,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    timeZone: row.timeZone,
    tzSource: row.tzSource as Deadline["tzSource"],
    dueAt: isoOrNull(row.dueAt),
    sortAt: isoOrNull(row.sortAt),
    revision: row.revision,
    verificationState: row.verificationState as Deadline["verificationState"],
    withdrawnAt: isoOrNull(row.withdrawnAt),
  };
}

export function toDeadlineView(row: DeadlineRow): DeadlineView {
  const d = toDeadline(row);
  return {
    id: d.id,
    kind: d.kind,
    scope: d.scope,
    roundLabel: d.roundLabel,
    basis: d.basis,
    precision: d.precision,
    tzMode: d.tzMode,
    localDate: d.localDate,
    localTime: d.localTime,
    windowStart: d.windowStart,
    windowEnd: d.windowEnd,
    timeZone: d.timeZone,
    dueAt: d.dueAt,
    sortAt: d.sortAt,
    revision: d.revision,
  };
}

/** Public evidence form; the excerpt is cut to the word limit public surfaces allow. */
export function toEvidenceQuote(row: EvidenceRow, maxWords = 25): EvidenceQuote {
  const words = row.quote.split(/\s+/).filter(Boolean);
  const quote = words.length > maxWords ? `${words.slice(0, maxWords).join(" ")} ...` : row.quote;
  return {
    fieldEvidenceId: row.id,
    basis: row.basis as EvidenceQuote["basis"],
    url: row.url,
    // manual_note facts come from hosts that forbid republishing excerpts.
    quote: row.basis === "manual_note" ? null : quote,
    retrievedOn: utcDate(row.createdAt),
  };
}

export function toFieldEvidence(row: EvidenceRow, handles: ReadonlyMap<string, string>): FieldEvidence {
  return {
    id: row.id,
    entityType: row.entityType as EvidenceEntity,
    entityId: row.entityId,
    fieldPath: row.fieldPath,
    basis: row.basis as FieldEvidence["basis"],
    snapshotId: row.snapshotId,
    attestationTaskId: row.attestationTaskId,
    url: row.url,
    quote: row.quote,
    locator: row.locator,
    match: row.match as FieldEvidence["match"],
    verifiedBy: row.verifiedBy ? (handles.get(row.verifiedBy) ?? null) : null,
    supersededAt: isoOrNull(row.supersededAt),
  };
}

export function toRequirement(row: RequirementRow, evidence: EvidenceQuote | null): Requirement {
  return {
    id: row.id,
    programCycleId: row.programCycleId,
    kind: row.kind as Requirement["kind"],
    label: row.label,
    detail: row.detail,
    quantity: row.quantity,
    wordLimit: row.wordLimit,
    deadlineId: row.deadlineId,
    effortHours: row.effortHours,
    leadTimeDays: row.leadTimeDays,
    evidence,
    verificationState: row.verificationState as Requirement["verificationState"],
  };
}

export function toRuleSet(row: RuleSetRow, handles: ReadonlyMap<string, string>): EligibilityRuleSet {
  // Stored rule sets were validated at write time; parse again so a hand-edited row fails loudly.
  return EligibilityRuleSetSchema.parse({
    ...row.body,
    id: row.id,
    programCycleId: row.programCycleId,
    version: row.version,
    format: row.format,
    state: row.state,
    templateKey: row.templateKey,
    hash: row.hash,
    createdVia: row.createdVia,
    verifiedAt: isoOrNull(row.verifiedAt),
    verifiedBy: row.verifiedBy ? (handles.get(row.verifiedBy) ?? null) : null,
    fromCycleKey: row.fromCycleKey,
  });
}

export function toCount(row: CountRow, evidence: EvidenceQuote | null): ProgramCycleCount {
  return {
    programCycleId: row.programCycleId,
    stage: row.stage as CountStage,
    count: row.count,
    kind: row.kind as ProgramCycleCount["kind"],
    provenance: row.provenance as ProgramCycleCount["provenance"],
    asOf: row.asOf,
    evidence,
  };
}

export function toPrediction(row: PredictionRow): Prediction {
  return { p10: row.p10, p50: row.p50, p90: row.p90, label: row.label as Prediction["label"], method: row.method as Prediction["method"] };
}

// =============================================================================================
// Pure read-model helpers
// =============================================================================================

const STATUS_RANK: Record<CycleStatus, number> = { open: 0, relaunched: 1, expected: 2, paused: 3, closed: 4, ended: 5 };

function cycleYear(cycleKey: string): number {
  const m = /(\d{4})/.exec(cycleKey);
  return m ? Number(m[1]) : 0;
}

/**
 * The cycle a program page shows: an open cycle first, then a relaunched or expected one (the
 * next term), then the most recent paused, closed or ended one. Ties go to the later cycle year.
 */
export function pickCurrentCycle<T extends { status: string; cycleKey: string }>(cycles: readonly T[]): T | null {
  let best: T | null = null;
  for (const c of cycles) {
    if (!best) {
      best = c;
      continue;
    }
    const rank = STATUS_RANK[c.status as CycleStatus] ?? 9;
    const bestRank = STATUS_RANK[best.status as CycleStatus] ?? 9;
    if (rank < bestRank || (rank === bestRank && cycleYear(c.cycleKey) > cycleYear(best.cycleKey))) best = c;
  }
  return best;
}

const PAID_KINDS: ReadonlySet<Compensation["kind"]> = new Set(["stipend", "salary_hourly", "award", "tuition", "travel"]);

export function programFlags(input: {
  compensation: Compensation | null;
  applicationFeeCents: number | null;
  participantCostCents: number | null;
  pellDisplacement: string;
  sensitiveAudience: boolean;
  identityAudience: readonly string[];
  nominationRequired: boolean;
}): ProgramFlags {
  return {
    paid: input.compensation !== null && PAID_KINDS.has(input.compensation.kind),
    participantCost: (input.participantCostCents ?? 0) > 0,
    applicationFee: (input.applicationFeeCents ?? 0) > 0,
    pellDisplacement: input.pellDisplacement === "yes" || input.pellDisplacement === "possible",
    sensitiveAudience: input.sensitiveAudience,
    identityAudience: input.identityAudience.length > 0,
    nominationRequired: input.nominationRequired,
  };
}

/** Max (lead time + effort days) across Requirements; null when nothing is known (never zero). */
export function prepDays(reqs: readonly { leadTimeDays: number | null; effortHours: number | null }[], hoursPerDay = 1): number | null {
  let best: number | null = null;
  for (const r of reqs) {
    if (r.leadTimeDays === null && r.effortHours === null) continue;
    const days = (r.leadTimeDays ?? 0) + Math.ceil((r.effortHours ?? 0) / hoursPerDay);
    best = best === null ? days : Math.max(best, days);
  }
  return best;
}

/** Odds between consecutive official stages (program-level facts, never about a student). */
export function stageOddsFromCounts(
  counts: readonly ProgramCycleCount[],
  cycleKey: string,
  verifiedBy: string | null,
): StageOdds[] {
  if (!verifiedBy) return [];
  const official = counts
    .filter((c) => c.provenance === "official_publication" && c.evidence)
    .sort((a, b) => COUNT_STAGES.indexOf(a.stage) - COUNT_STAGES.indexOf(b.stage));
  const out: StageOdds[] = [];
  for (let i = 1; i < official.length; i++) {
    const from = official[i - 1] as ProgramCycleCount;
    const to = official[i] as ProgramCycleCount;
    if (from.count <= 0 || to.count > from.count) continue;
    out.push({
      fromStage: from.stage,
      toStage: to.stage,
      cycleYear: cycleYear(cycleKey),
      numerator: to.count,
      denominator: from.count,
      denominatorKind: from.kind,
      sourceUrl: (to.evidence as EvidenceQuote).url,
      verifiedAt: to.asOf,
      verifiedBy,
    });
  }
  return out;
}

// =============================================================================================
// Bulk loading
// =============================================================================================

export interface RegistrySnapshot {
  programs: ProgramRow[];
  organizations: Map<string, OrganizationRow>;
  cyclesByProgram: Map<string, CycleRow[]>;
  types: Map<string, OpportunityTypeSlug[]>;
  aliases: Map<string, string[]>;
  tags: Map<string, string[]>;
  fields: Map<string, string[]>;
  majorFamilies: Map<string, MajorFamily[]>;
  deadlinesByCycle: Map<string, DeadlineRow[]>;
  requirementsByCycle: Map<string, RequirementRow[]>;
  ruleSetsByCycle: Map<string, RuleSetRow>;
  predictionsByCycle: Map<string, PredictionRow>;
  handles: Map<string, string>;
}

function groupBy<T, K>(rows: readonly T[], key: (r: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

function groupValues<T, V>(rows: readonly T[], key: (r: T) => string, value: (r: T) => V): Map<string, V[]> {
  const m = new Map<string, V[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(value(r));
    else m.set(k, [value(r)]);
  }
  return m;
}

/**
 * Loads published programs (or the given ids) with everything their cards need, in one D1 batch
 * of indexed queries. Cheap at registry scale (hundreds of programs).
 */
export async function loadRegistrySnapshot(db: Db, opts: { programIds?: readonly string[]; includeUnpublished?: boolean } = {}): Promise<RegistrySnapshot> {
  const programFilter = opts.programIds
    ? sql`${s.programs.id} IN ${jsonIds(opts.programIds)}`
    : opts.includeUnpublished
      ? sql`1 = 1`
      : sql`${s.programs.isPublished} = 1`;
  const programIdsSub = db.select({ id: s.programs.id }).from(s.programs).where(programFilter);
  const cycleIdsSub = db.select({ id: s.programCycles.id }).from(s.programCycles).where(inArray(s.programCycles.programId, programIdsSub));

  const [programs, organizations, cycles, types, aliases, tags, fields, families, deadlines, requirements, ruleSets, predictions, curators] = await db.batch([
    db.select().from(s.programs).where(programFilter).orderBy(asc(s.programs.slug)),
    db.select().from(s.organizations).where(inArray(s.organizations.id, db.select({ id: s.programs.organizationId }).from(s.programs).where(programFilter))),
    db.select().from(s.programCycles).where(inArray(s.programCycles.programId, programIdsSub)),
    db.select().from(s.programTypes).where(inArray(s.programTypes.programId, programIdsSub)).orderBy(desc(s.programTypes.isPrimary)),
    db.select().from(s.programAliases).where(inArray(s.programAliases.programId, programIdsSub)),
    db.select().from(s.programInterestTags).where(inArray(s.programInterestTags.programId, programIdsSub)),
    db.select().from(s.programFields).where(inArray(s.programFields.programId, programIdsSub)),
    db.select().from(s.programMajorFamilies).where(inArray(s.programMajorFamilies.programId, programIdsSub)),
    db
      .select()
      .from(s.deadlines)
      .where(and(inArray(s.deadlines.programCycleId, cycleIdsSub), isNull(s.deadlines.withdrawnAt)))
      .orderBy(asc(s.deadlines.sortAt)),
    db
      .select()
      .from(s.requirements)
      .where(and(inArray(s.requirements.programCycleId, cycleIdsSub), isNull(s.requirements.withdrawnAt)))
      .orderBy(asc(s.requirements.sortOrder)),
    db
      .select()
      .from(s.eligibilityRuleSets)
      .where(and(inArray(s.eligibilityRuleSets.programCycleId, cycleIdsSub), eq(s.eligibilityRuleSets.state, "verified"))),
    db
      .select()
      .from(s.cyclePredictions)
      .where(and(inArray(s.cyclePredictions.programCycleId, cycleIdsSub), eq(s.cyclePredictions.isCurrent, true), eq(s.cyclePredictions.event, "opens"))),
    db.select({ id: s.curators.id, handle: s.curators.publicHandle }).from(s.curators),
  ]);

  return {
    programs,
    organizations: new Map(organizations.map((o) => [o.id, o])),
    cyclesByProgram: groupBy(cycles, (c) => c.programId),
    types: groupValues(types, (t) => t.programId, (t) => t.typeSlug),
    aliases: groupValues(aliases, (a) => a.programId, (a) => a.alias),
    tags: groupValues(tags, (t) => t.programId, (t) => t.tag),
    fields: groupValues(fields, (f) => f.programId, (f) => f.cipPrefix),
    majorFamilies: groupValues(families, (f) => f.programId, (f) => f.majorFamily as MajorFamily),
    deadlinesByCycle: groupBy(deadlines, (d) => d.programCycleId),
    requirementsByCycle: groupBy(requirements, (r) => r.programCycleId),
    ruleSetsByCycle: new Map(ruleSets.map((r) => [r.programCycleId, r])),
    predictionsByCycle: new Map(predictions.map((p) => [p.programCycleId, p])),
    handles: new Map(curators.map((c) => [c.id, c.handle])),
  };
}

function seasonOf(cycle: CycleRow, deadlines: readonly DeadlineRow[], prediction: PredictionRow | undefined, now: number): boolean {
  return isInSeason(
    {
      status: cycle.status as CycleStatus,
      opensOn: cycle.opensOn,
      predictedOpensP10: prediction?.p10 ?? null,
      deadlineSortAts: deadlines.map((d) => d.sortAt),
    },
    now,
  );
}

/** Assembles one card from a snapshot; null when the program has no cycle yet. */
export function buildProgramCard(snap: RegistrySnapshot, program: ProgramRow, now: number): ProgramCard | null {
  const cycle = pickCurrentCycle(snap.cyclesByProgram.get(program.id) ?? []);
  if (!cycle) return null;
  const org = snap.organizations.get(program.organizationId);
  const deadlines = snap.deadlinesByCycle.get(cycle.id) ?? [];
  const requirements = snap.requirementsByCycle.get(cycle.id) ?? [];
  const ruleSetRow = snap.ruleSetsByCycle.get(cycle.id);
  const ruleSet = ruleSetRow ? toRuleSet(ruleSetRow, snap.handles) : null;
  const prediction = snap.predictionsByCycle.get(cycle.id);
  const inSeason = seasonOf(cycle, deadlines, prediction, now);
  const verifiable = { verificationState: cycle.verificationState as ProgramCycle["verificationState"], lastVerifiedAt: cycle.lastVerifiedAt };
  const nominationRequired = ruleSet?.nomination != null || deadlines.some((d) => d.kind === "nomination" || d.kind === "campus_internal");
  return {
    programId: program.id,
    programCycleId: cycle.id,
    slug: program.slug,
    cycleKey: cycle.cycleKey,
    name: program.name,
    organizationName: org?.name ?? "",
    summary: program.summary,
    opportunityTypes: snap.types.get(program.id) ?? [],
    status: cycle.status as CycleStatus,
    verification: {
      state: verificationState(verifiable, now, inSeason),
      verifiedOn: utcDate(cycle.lastVerifiedAt),
      verifiedBy: cycle.verifiedBy ? (snap.handles.get(cycle.verifiedBy) ?? null) : null,
      freshness: freshness(verifiable, now, inSeason),
    },
    deadlines: deadlines.filter((d) => d.scope === "national").map(toDeadlineView),
    opensOn: cycle.opensOn,
    prediction: prediction ? toPrediction(prediction) : null,
    classYears: [...(cycle.classYears as ClassYear[])],
    majorFamilies: snap.majorFamilies.get(program.id) ?? [],
    cipPrefixes: snap.fields.get(program.id) ?? [],
    interestTags: snap.tags.get(program.id) ?? [],
    aliases: snap.aliases.get(program.id) ?? [],
    flags: programFlags({
      compensation: cycle.compensation,
      applicationFeeCents: cycle.applicationFeeCents,
      participantCostCents: cycle.participantCostCents,
      pellDisplacement: cycle.pellDisplacement,
      sensitiveAudience: program.sensitiveAudience,
      identityAudience: program.identityAudience,
      nominationRequired,
    }),
    compensation: cycle.compensation,
    applicationUrl: cycle.applicationUrl,
    officialUrl: program.officialUrl,
    prepDays: prepDays(requirements),
    rules: ruleSet,
    rulesFromPreviousCycle: ruleSet?.fromCycleKey ?? null,
    isSample: program.isSample,
  };
}

/** Every published program's card (the release artifact and list endpoints read this). */
export async function listProgramCards(db: Db, now: number, opts: { programIds?: readonly string[] } = {}): Promise<ProgramCard[]> {
  const snap = await loadRegistrySnapshot(db, opts);
  return snap.programs.map((p) => buildProgramCard(snap, p, now)).filter((c): c is ProgramCard => c !== null);
}

export interface CitationOptions {
  /** Public origin, e.g. the APP_ORIGIN var. */
  origin: string;
  license: string;
  termsPath: string;
}

/** Program detail for `GET /api/v1/programs/:slug`; null when unknown or unpublished. */
export async function getProgramDetail(db: Db, slug: string, now: number, citation: CitationOptions): Promise<ProgramDetail | null> {
  const program = await db.query.programs.findFirst({ where: eq(s.programs.slug, slug) });
  if (!program || !program.isPublished) return null;
  const snap = await loadRegistrySnapshot(db, { programIds: [program.id] });
  const cycles = snap.cyclesByProgram.get(program.id) ?? [];
  const cycle = pickCurrentCycle(cycles);
  const org = snap.organizations.get(program.organizationId);
  if (!cycle || !org) return null;

  const requirementIds = (snap.requirementsByCycle.get(cycle.id) ?? []).map((r) => r.id);
  const [allDeadlines, counts, evidence, release] = await db.batch([
    db
      .select()
      .from(s.deadlines)
      .where(and(eq(s.deadlines.programCycleId, cycle.id), isNull(s.deadlines.withdrawnAt)))
      .orderBy(asc(s.deadlines.sortAt)),
    db.select().from(s.programCycleCounts).where(eq(s.programCycleCounts.programCycleId, cycle.id)),
    db
      .select()
      .from(s.fieldEvidence)
      .where(
        and(
          isNull(s.fieldEvidence.supersededAt),
          sql`${s.fieldEvidence.entityId} IN ${jsonIds([cycle.id, program.id, ...requirementIds])}`,
        ),
      ),
    db
      .select({ number: s.registryReleases.number })
      .from(s.registryReleases)
      .where(eq(s.registryReleases.state, "published"))
      .orderBy(desc(s.registryReleases.number))
      .limit(1),
  ]);

  const evidenceFor = (entityType: string, entityId: string, fieldPath?: string): EvidenceRow | undefined =>
    evidence.find((e) => e.entityType === entityType && e.entityId === entityId && (!fieldPath || e.fieldPath === fieldPath));
  const countEvidence = await liveEvidence(db, "program_cycle_count", counts.map((c) => c.id));
  const countRows = counts.map((c) => {
    const ev = countEvidence.find((e) => e.entityId === c.id);
    return toCount(c, ev ? toEvidenceQuote(ev) : null);
  });
  const ruleSetRow = snap.ruleSetsByCycle.get(cycle.id);
  const prediction = snap.predictionsByCycle.get(cycle.id);
  const cycleView = toCycle(cycle, snap.handles);
  const inSeason = seasonOf(cycle, allDeadlines, prediction, now);
  const verifiable = { verificationState: cycleView.verificationState, lastVerifiedAt: cycle.lastVerifiedAt };
  const statusEvidence = evidenceFor("program_cycle", cycle.id);
  const releaseNumber = release[0]?.number ?? 0;
  const display = verificationState(verifiable, now, inSeason);
  const requirementRows = snap.requirementsByCycle.get(cycle.id) ?? [];

  const citationValue: RecordCitation = {
    novusUrl: `${citation.origin.replace(/\/$/, "")}/programs/${program.slug}`,
    officialUrl: program.officialUrl,
    basis: "official",
    evidenceUrl: statusEvidence?.url ?? null,
    evidenceExcerpt: statusEvidence ? toEvidenceQuote(statusEvidence).quote : null,
    lastVerifiedAt: utcDate(cycle.lastVerifiedAt),
    verifiedBy: cycleView.verifiedBy,
    derivation: null,
    sourceCheckedAt: cycleView.sourceCheckedAt,
    verificationState: display === "draft" ? "unverified" : display,
    freshness: freshness(verifiable, now, inSeason),
    recordVersion: String(releaseNumber),
    license: citation.license,
    termsUrl: `${citation.origin.replace(/\/$/, "")}${citation.termsPath}`,
  };

  return {
    program: toProgram(program, {
      types: snap.types.get(program.id) ?? [],
      aliases: snap.aliases.get(program.id) ?? [],
      tags: snap.tags.get(program.id) ?? [],
      majorFamilies: snap.majorFamilies.get(program.id) ?? [],
    }),
    organization: toOrganization(org),
    cycle: cycleView,
    deadlines: allDeadlines.map(toDeadline),
    requirements: requirementRows.map((r) => {
      const ev = evidenceFor("requirement", r.id);
      return toRequirement(r, ev ? toEvidenceQuote(ev) : null);
    }),
    requirementsChecked: requirementRows.length > 0 && requirementRows.every((r) => r.verificationState === "verified"),
    counts: countRows,
    stageOdds: stageOddsFromCounts(countRows, cycle.cycleKey, cycleView.verifiedBy),
    prediction: prediction ? toPrediction(prediction) : null,
    ruleSet: ruleSetRow ? toRuleSet(ruleSetRow, snap.handles) : null,
    otherCycles: cycles.filter((c) => c.id !== cycle.id).map((c) => ({ cycleKey: c.cycleKey, status: c.status as CycleStatus })),
    citation: citationValue,
    release: releaseNumber,
  };
}

// =============================================================================================
// Simple reads
// =============================================================================================

export async function getProgramBySlug(db: Db, slug: string): Promise<ProgramRow | undefined> {
  return db.query.programs.findFirst({ where: eq(s.programs.slug, slug) });
}

/** Resolves a slug that may have been renamed or merged. */
export async function resolveProgramSlug(db: Db, slug: string): Promise<{ program: ProgramRow; redirectedFrom: string | null } | null> {
  const direct = await getProgramBySlug(db, slug);
  if (direct) return { program: direct, redirectedFrom: null };
  const redirect = await db.query.slugRedirects.findFirst({ where: eq(s.slugRedirects.fromSlug, slug) });
  if (!redirect) return null;
  const program = await db.query.programs.findFirst({ where: eq(s.programs.id, redirect.toProgramId) });
  return program ? { program, redirectedFrom: slug } : null;
}

export async function getCycle(db: Db, cycleId: string): Promise<CycleRow | undefined> {
  return db.query.programCycles.findFirst({ where: eq(s.programCycles.id, cycleId) });
}

export async function getCycleByKey(db: Db, programId: string, cycleKey: string): Promise<CycleRow | undefined> {
  return db.query.programCycles.findFirst({ where: and(eq(s.programCycles.programId, programId), eq(s.programCycles.cycleKey, cycleKey)) });
}

export async function listCycles(db: Db, programId: string): Promise<CycleRow[]> {
  return db.select().from(s.programCycles).where(eq(s.programCycles.programId, programId)).orderBy(desc(s.programCycles.cycleKey));
}

/** Program and organization context for a cycle (used by tracker, alerts and readiness). */
export async function getCycleContext(db: Db, cycleId: string) {
  const rows = await db
    .select({ cycle: s.programCycles, program: s.programs })
    .from(s.programCycles)
    .innerJoin(s.programs, eq(s.programs.id, s.programCycles.programId))
    .where(eq(s.programCycles.id, cycleId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getVerifiedRuleSet(db: Db, cycleId: string): Promise<EligibilityRuleSet | null> {
  const row = await db.query.eligibilityRuleSets.findFirst({
    where: and(eq(s.eligibilityRuleSets.programCycleId, cycleId), eq(s.eligibilityRuleSets.state, "verified")),
  });
  if (!row) return null;
  return toRuleSet(row, await curatorHandles(db));
}

export async function listRequirements(db: Db, cycleId: string): Promise<Requirement[]> {
  const rows = await db
    .select()
    .from(s.requirements)
    .where(and(eq(s.requirements.programCycleId, cycleId), isNull(s.requirements.withdrawnAt)))
    .orderBy(asc(s.requirements.sortOrder));
  const ev = await liveEvidence(db, "requirement", rows.map((r) => r.id));
  return rows.map((r) => {
    const e = ev.find((x) => x.entityId === r.id);
    return toRequirement(r, e ? toEvidenceQuote(e) : null);
  });
}

export async function listLiveDeadlines(db: Db, cycleIds: readonly string[]): Promise<Deadline[]> {
  if (cycleIds.length === 0) return [];
  const rows = await db
    .select()
    .from(s.deadlines)
    .where(and(sql`${s.deadlines.programCycleId} IN ${jsonIds(cycleIds)}`, isNull(s.deadlines.withdrawnAt)))
    .orderBy(asc(s.deadlines.sortAt));
  return rows.map(toDeadline);
}

/** National (and optionally one campus's) live deadlines whose sort instant falls in [fromMs, toMs]. */
export async function listDeadlinesBetween(
  db: Db,
  opts: { fromMs: number; toMs: number; institutionId?: string | null; limit: number; after?: { sortAt: number; id: string } | null },
) {
  const scope = opts.institutionId
    ? sql`(${s.deadlines.scope} = 'national' OR ${s.deadlines.institutionId} = ${opts.institutionId})`
    : sql`${s.deadlines.scope} = 'national'`;
  const after = opts.after
    ? sql`(${s.deadlines.sortAt} > ${opts.after.sortAt} OR (${s.deadlines.sortAt} = ${opts.after.sortAt} AND ${s.deadlines.id} > ${opts.after.id}))`
    : sql`1 = 1`;
  return db
    .select({ deadline: s.deadlines, cycle: s.programCycles, program: s.programs })
    .from(s.deadlines)
    .innerJoin(s.programCycles, eq(s.programCycles.id, s.deadlines.programCycleId))
    .innerJoin(s.programs, eq(s.programs.id, s.programCycles.programId))
    .where(
      and(
        isNull(s.deadlines.withdrawnAt),
        eq(s.programs.isPublished, true),
        sql`${s.deadlines.sortAt} BETWEEN ${opts.fromMs} AND ${opts.toMs}`,
        scope,
        after,
      ),
    )
    .orderBy(asc(s.deadlines.sortAt), asc(s.deadlines.id))
    .limit(opts.limit);
}

export async function curatorHandles(db: Db): Promise<Map<string, string>> {
  const rows = await db.select({ id: s.curators.id, handle: s.curators.publicHandle }).from(s.curators);
  return new Map(rows.map((r) => [r.id, r.handle]));
}

export async function getCuratorByHandle(db: Db, handle: string) {
  return db.query.curators.findFirst({ where: eq(s.curators.publicHandle, handle) });
}

export async function searchInstitutions(db: Db, q: string, limit: number) {
  const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return db
    .select({ id: s.institutions.id, name: s.institutions.name, level: s.institutions.level, state: s.institutions.state, calendar: s.institutions.calendar })
    .from(s.institutions)
    .where(sql`${s.institutions.name} LIKE ${pattern} ESCAPE '\\'`)
    .orderBy(asc(s.institutions.name))
    .limit(limit);
}

export async function getInstitution(db: Db, id: string) {
  return db.query.institutions.findFirst({ where: eq(s.institutions.id, id) });
}

/** The institution for a school email domain, if the domain is active. */
export async function institutionForEmailDomain(db: Db, domain: string) {
  const rows = await db
    .select({ institution: s.institutions })
    .from(s.institutionEmailDomains)
    .innerJoin(s.institutions, eq(s.institutions.id, s.institutionEmailDomains.institutionId))
    .where(and(eq(s.institutionEmailDomains.domain, domain.toLowerCase()), eq(s.institutionEmailDomains.active, true)))
    .limit(1);
  return rows[0]?.institution ?? null;
}

/** Whether an institution has a positive participation listing for a program (unknown, never "no", otherwise). */
export async function institutionParticipates(db: Db, programId: string, institutionId: string): Promise<boolean | null> {
  const row = await db.query.institutionParticipation.findFirst({
    where: and(eq(s.institutionParticipation.programId, programId), eq(s.institutionParticipation.institutionId, institutionId)),
  });
  return row ? true : null;
}

export async function opportunityTypeCounts(db: Db) {
  return db
    .select({
      slug: s.opportunityTypes.slug,
      ordinal: s.opportunityTypes.ordinal,
      label: s.opportunityTypes.label,
      group: s.opportunityTypes.group,
      inScope: s.opportunityTypes.inScope,
      // Raw qualified names: Drizzle renders a lone column unqualified, which a subquery would rebind.
      programCount: sql<number>`(SELECT count(*) FROM program_types pt JOIN programs p ON p.id = pt.program_id WHERE pt.type_slug = opportunity_types.slug AND p.is_published = 1)`,
    })
    .from(s.opportunityTypes)
    .orderBy(asc(s.opportunityTypes.ordinal));
}

// =============================================================================================
// Evidence and sources
// =============================================================================================

export async function liveEvidence(db: Db, entityType: EvidenceEntity, entityIds: readonly string[]): Promise<EvidenceRow[]> {
  if (entityIds.length === 0) return [];
  return db
    .select()
    .from(s.fieldEvidence)
    .where(and(eq(s.fieldEvidence.entityType, entityType), sql`${s.fieldEvidence.entityId} IN ${jsonIds(entityIds)}`, isNull(s.fieldEvidence.supersededAt)));
}

export type EvidenceInsert = Omit<typeof s.fieldEvidence.$inferInsert, "id" | "supersededAt" | "createdAt"> & { id?: string };

export function evidenceInsertStatement(db: Db, rows: readonly EvidenceInsert[], now: number): Stmt | null {
  if (rows.length === 0) return null;
  return db.insert(s.fieldEvidence).values(rows.map((r) => ({ ...r, id: r.id ?? uuidv7(now), createdAt: now })));
}

/** Supersedes the live evidence of one field (the only update field_evidence allows). */
export function supersedeEvidenceStatement(db: Db, entityType: EvidenceEntity, entityId: string, fieldPath: string, now: number): Stmt {
  return db
    .update(s.fieldEvidence)
    .set({ supersededAt: now })
    .where(
      and(
        eq(s.fieldEvidence.entityType, entityType),
        eq(s.fieldEvidence.entityId, entityId),
        eq(s.fieldEvidence.fieldPath, fieldPath),
        isNull(s.fieldEvidence.supersededAt),
      ),
    );
}

export interface SourceInput {
  url: string;
  kind: (typeof s.sources.$inferInsert)["kind"];
  host: string;
  hostPolicy: string;
  policySource: "seed" | "default" | "curator";
  minIntervalMs?: number;
  renderMode?: string;
  programId?: string | null;
  organizationId?: string | null;
  nextCheckAt?: number | null;
}

/** Upserts the resolved host row and the Source in one batch (the cadence trigger checks the pair). */
export async function upsertSource(db: Db, input: SourceInput, now: number): Promise<string> {
  const existing = await db.query.sources.findFirst({ where: eq(s.sources.url, input.url) });
  const id = existing?.id ?? uuidv7(now);
  await runBatch(db, [
    db
      .insert(s.sourceHosts)
      .values({ host: input.host, policy: input.hostPolicy, policySource: input.policySource, minIntervalMs: input.minIntervalMs ?? 2000, updatedAt: now })
      .onConflictDoUpdate({ target: s.sourceHosts.host, set: { policy: input.hostPolicy, policySource: input.policySource, updatedAt: now } }),
    db
      .insert(s.sources)
      .values({
        id,
        url: input.url,
        kind: input.kind,
        host: input.host,
        renderMode: input.renderMode ?? "static",
        programId: input.programId ?? null,
        organizationId: input.organizationId ?? null,
        nextCheckAt: input.nextCheckAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: s.sources.url,
        set: { kind: input.kind, host: input.host, programId: input.programId ?? null, organizationId: input.organizationId ?? null, updatedAt: now },
      }),
  ]);
  return id;
}

/** Sources whose next check is due, oldest first (the tick enqueues fetch jobs for them). */
export async function listDueSources(db: Db, now: number, limit: number) {
  return db
    .select()
    .from(s.sources)
    .where(and(sql`${s.sources.nextCheckAt} <= ${now}`, eq(s.sources.approval, "approved"), sql`${s.sources.health} NOT IN ('blocked', 'opted_out')`))
    .orderBy(asc(s.sources.nextCheckAt))
    .limit(limit);
}

export async function setSourceSchedule(db: Db, sourceId: string, nextCheckAt: number | null, now: number) {
  await db.update(s.sources).set({ nextCheckAt, updatedAt: now }).where(eq(s.sources.id, sourceId));
}

export type SnapshotInsert = Omit<typeof s.snapshots.$inferInsert, "id" | "createdAt">;

export async function recordSnapshot(db: Db, input: SnapshotInsert, now: number): Promise<string> {
  const id = uuidv7(now);
  await runBatch(db, [
    db.insert(s.snapshots).values({ ...input, id, createdAt: now }),
    db.update(s.sources).set({ lastFetchedAt: input.fetchedAt, updatedAt: now }).where(eq(s.sources.id, input.sourceId)),
  ]);
  return id;
}

// =============================================================================================
// Writes: programs, cycles, deadlines, requirements
// =============================================================================================

export interface ProgramInsert {
  slug: string;
  name: string;
  organizationId: string;
  summary?: string | null;
  officialUrl: string;
  recurrence: string;
  types: readonly OpportunityTypeSlug[];
  aliases?: readonly string[];
  tags?: readonly string[];
  majorFamilies?: readonly MajorFamily[];
  cip?: readonly { prefix: string; relation: "core" | "related" | "borderline" }[];
  sensitiveAudience: boolean;
  identityAudience: readonly string[];
  isPublished?: boolean;
  isSample?: boolean;
}

export async function createProgram(db: Db, input: ProgramInsert, now: number): Promise<RepoResult<string>> {
  if (input.types.length === 0) return fail("invalid", "a program needs at least one opportunity type");
  const id = uuidv7(now);
  const stmts: Stmt[] = [
    db.insert(s.programs).values({
      id,
      slug: input.slug,
      name: input.name,
      organizationId: input.organizationId,
      summary: input.summary ?? null,
      officialUrl: input.officialUrl,
      recurrence: input.recurrence,
      sensitiveAudience: input.sensitiveAudience,
      identityAudience: [...input.identityAudience] as (typeof s.programs.$inferInsert)["identityAudience"],
      isPublished: input.isPublished ?? false,
      isSample: input.isSample ?? false,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(s.programTypes).values(input.types.map((t, i) => ({ programId: id, typeSlug: t, isPrimary: i === 0 }))),
  ];
  if (input.aliases?.length) stmts.push(db.insert(s.programAliases).values(input.aliases.map((alias) => ({ programId: id, alias }))));
  if (input.tags?.length) stmts.push(db.insert(s.programInterestTags).values(input.tags.map((tag) => ({ programId: id, tag }))));
  if (input.majorFamilies?.length) stmts.push(db.insert(s.programMajorFamilies).values(input.majorFamilies.map((majorFamily) => ({ programId: id, majorFamily }))));
  if (input.cip?.length) stmts.push(db.insert(s.programFields).values(input.cip.map((c) => ({ programId: id, cipPrefix: c.prefix, relation: c.relation }))));
  try {
    await runBatch(db, stmts);
    return ok(id);
  } catch (err) {
    return classifyWriteError(err);
  }
}

export interface CycleInsert {
  programId: string;
  cycleKey: string;
  termLabel: string;
  cycleModel?: string;
  status?: CycleStatus;
  statusChangedBy: string;
  timeZone?: string | null;
  opensOn?: string | null;
  applicationUrl?: string | null;
  compensation?: Compensation | null;
  classYears?: readonly ClassYear[];
  rolledOverFromId?: string | null;
}

export async function createCycle(db: Db, input: CycleInsert, now: number): Promise<RepoResult<string>> {
  const id = uuidv7(now);
  try {
    await db.insert(s.programCycles).values({
      id,
      programId: input.programId,
      cycleKey: input.cycleKey,
      termLabel: input.termLabel,
      cycleModel: input.cycleModel ?? "term",
      status: input.status ?? "expected",
      statusChangedAt: now,
      statusChangedBy: input.statusChangedBy,
      timeZone: input.timeZone ?? null,
      opensOn: input.opensOn ?? null,
      applicationUrl: input.applicationUrl ?? null,
      compensation: input.compensation ?? null,
      classYears: [...(input.classYears ?? [])],
      rolledOverFromId: input.rolledOverFromId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return ok(id);
  } catch (err) {
    return classifyWriteError(err);
  }
}

/** Fields a Curator supplies for a Deadline; instants are derived, never accepted from input. */
export type DeadlineInput = Omit<Deadline, "id" | "dueAt" | "sortAt" | "revision" | "withdrawnAt" | "roundLabel"> & { roundLabel?: string };

/** Validates a Deadline against the table's CHECK rules and derives `due_at` and `sort_at`. */
export function prepareDeadlineRow(input: DeadlineInput, id: string, revision: number, now: number): RepoResult<typeof s.deadlines.$inferInsert> {
  const dueAt = computeDueAt(input);
  const sortAt = computeSortAt(input);
  const issues = deadlineIssues({
    ...input,
    roundLabel: input.roundLabel ?? "",
    id,
    dueAt: dueAt === null ? null : iso(dueAt),
    sortAt: sortAt === null ? null : iso(sortAt),
    revision,
    withdrawnAt: null,
  });
  if (issues.length > 0) return fail("invalid", issues.map((i) => `${i.path}: ${i.message}`).join("; "));
  return ok({
    id,
    programCycleId: input.programCycleId,
    kind: input.kind,
    scope: input.scope,
    institutionId: input.institutionId,
    roundLabel: input.roundLabel ?? "",
    basis: input.basis,
    precision: input.precision,
    tzMode: input.tzMode,
    localDate: input.localDate,
    localTime: input.localTime,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    timeZone: input.timeZone,
    tzSource: input.tzSource,
    dueAt,
    sortAt,
    revision,
    verificationState: input.verificationState,
    createdAt: now,
    updatedAt: now,
  });
}

export interface PublishContext {
  /** Task or request id: the guard key, so a retried publish applies once. */
  guardKey: string;
  /** Cycle version the Curator reviewed. */
  cycleVersion: number;
  actor: RegistryAuditInput["actor"];
  snapshotIds?: readonly string[];
  now: number;
}

function cycleBump(db: Db, cycleId: string, now: number): Stmt {
  return db
    .update(s.programCycles)
    .set({ version: sql`${s.programCycles.version} + 1`, updatedAt: now })
    .where(eq(s.programCycles.id, cycleId));
}

function changeEvent(db: Db, ctx: PublishContext, type: ChangeEventType, cycleId: string, payload: Record<string, unknown>): Stmt {
  return db
    .insert(s.changeEvents)
    .values({ id: uuidv7(ctx.now), type, programCycleId: cycleId, payload, taskId: ctx.guardKey, idempotencyKey: `${ctx.guardKey}:${type}:${cycleId}`, createdAt: ctx.now })
    .onConflictDoNothing();
}

function audit(db: Db, ctx: PublishContext, entityType: EvidenceEntity, entityId: string, field: string, before: unknown, after: unknown): Stmt {
  return registryAuditInsert(db, {
    at: ctx.now,
    actor: ctx.actor,
    entityType,
    entityId,
    field,
    before,
    after,
    taskId: ctx.guardKey,
    snapshotIds: ctx.snapshotIds ?? [],
  });
}

/**
 * Inserts or revises a Deadline in its slot (kind, scope, institution, round). A changed value
 * bumps `revision` (the ICS SEQUENCE) and emits `deadline.changed`; evidence rows join the batch.
 */
export async function publishDeadline(db: Db, input: DeadlineInput, evidence: readonly EvidenceInsert[], ctx: PublishContext): Promise<RepoResult<string>> {
  const slot = await db.query.deadlines.findFirst({
    where: and(
      eq(s.deadlines.programCycleId, input.programCycleId),
      eq(s.deadlines.kind, input.kind),
      eq(s.deadlines.scope, input.scope),
      input.institutionId ? eq(s.deadlines.institutionId, input.institutionId) : isNull(s.deadlines.institutionId),
      eq(s.deadlines.roundLabel, input.roundLabel ?? ""),
      isNull(s.deadlines.withdrawnAt),
    ),
  });
  const id = slot?.id ?? uuidv7(ctx.now);
  const changed = !slot || revisionChanged({ ...slot, withdrawnAt: null } as Parameters<typeof revisionChanged>[0], { ...input, withdrawnAt: null } as Parameters<typeof revisionChanged>[1]);
  const prepared = prepareDeadlineRow(input, id, slot ? slot.revision + (changed ? 1 : 0) : 1, ctx.now);
  if (!prepared.ok) return fail(prepared.error, prepared.detail);
  const row = prepared.value;
  const stmts: Stmt[] = [versionGuard(db, ctx.guardKey, "program_cycles", input.programCycleId, ctx.cycleVersion, ctx.now)];
  if (slot) {
    const { id: _id, createdAt: _c, ...rest } = row;
    stmts.push(db.update(s.deadlines).set({ ...rest, updatedAt: ctx.now }).where(eq(s.deadlines.id, id)));
  } else {
    stmts.push(db.insert(s.deadlines).values(row));
  }
  for (const e of evidence) stmts.push(supersedeEvidenceStatement(db, "deadline", id, e.fieldPath, ctx.now));
  const ev = evidenceInsertStatement(db, evidence.map((e) => ({ ...e, entityType: "deadline", entityId: id })), ctx.now);
  if (ev) stmts.push(ev);
  if (changed) {
    stmts.push(audit(db, ctx, "deadline", id, "deadline", slot ? toDeadline(slot) : null, { ...input, revision: row.revision }));
    stmts.push(
      changeEvent(db, ctx, "deadline.changed", input.programCycleId, {
        deadlineId: id,
        kind: input.kind,
        scope: row.scope,
        institutionId: row.institutionId ?? null,
        localDate: row.localDate ?? null,
        localTime: row.localTime ?? null,
        timeZone: row.timeZone ?? null,
        dueAt: row.dueAt ?? null,
        previousLocalDate: slot?.localDate ?? null,
        previousLocalTime: slot?.localTime ?? null,
        previousTimeZone: slot?.timeZone ?? null,
        previousDueAt: slot?.dueAt ?? null,
        revision: row.revision,
      }),
    );
  }
  stmts.push(cycleBump(db, input.programCycleId, ctx.now));
  try {
    await runBatch(db, stmts);
    return ok(id);
  } catch (err) {
    return classifyWriteError(err);
  }
}

/** Withdraws a Deadline (never deleted: calendars emit CANCELLED with a higher SEQUENCE). */
export async function withdrawDeadline(db: Db, deadlineId: string, ctx: PublishContext): Promise<RepoResult<true>> {
  const row = await db.query.deadlines.findFirst({ where: eq(s.deadlines.id, deadlineId) });
  if (!row) return fail("not_found");
  if (row.withdrawnAt !== null) return ok(true);
  try {
    await runBatch(db, [
      versionGuard(db, ctx.guardKey, "program_cycles", row.programCycleId, ctx.cycleVersion, ctx.now),
      db
        .update(s.deadlines)
        .set({ withdrawnAt: ctx.now, revision: row.revision + 1, updatedAt: ctx.now })
        .where(eq(s.deadlines.id, deadlineId)),
      audit(db, ctx, "deadline", deadlineId, "withdrawn_at", null, iso(ctx.now)),
      changeEvent(db, ctx, "deadline.changed", row.programCycleId, {
        deadlineId,
        kind: row.kind,
        scope: row.scope,
        institutionId: row.institutionId ?? null,
        withdrawn: true,
        previousLocalDate: row.localDate,
        revision: row.revision + 1,
      }),
      cycleBump(db, row.programCycleId, ctx.now),
    ]);
    return ok(true);
  } catch (err) {
    return classifyWriteError(err);
  }
}

/** Moves a cycle along the state machine (only allowed transitions), with audit and ChangeEvent. */
export async function transitionCycleStatus(db: Db, cycleId: string, to: CycleStatus, ctx: PublishContext): Promise<RepoResult<CycleStatus>> {
  if (!(CYCLE_STATUSES as readonly string[]).includes(to)) return fail("invalid", "unknown status");
  const cycle = await getCycle(db, cycleId);
  if (!cycle) return fail("not_found");
  const from = cycle.status as CycleStatus;
  if (!canTransitionCycle(from, to)) return fail("invalid", `cannot move a cycle from ${from} to ${to}`);
  const stmts: Stmt[] = [
    versionGuard(db, ctx.guardKey, "program_cycles", cycleId, ctx.cycleVersion, ctx.now),
    db
      .update(s.programCycles)
      .set({ status: to, statusChangedAt: ctx.now, statusChangedBy: ctx.actor.ref, updatedAt: ctx.now, version: sql`${s.programCycles.version} + 1` })
      .where(eq(s.programCycles.id, cycleId)),
    audit(db, ctx, "program_cycle", cycleId, "status", from, to),
    changeEvent(db, ctx, "cycle.status_changed", cycleId, { from, to }),
  ];
  if (to === "ended") {
    stmts.push(db.update(s.programs).set({ lifecycle: "ended", updatedAt: ctx.now }).where(eq(s.programs.id, cycle.programId)));
  }
  try {
    await runBatch(db, stmts);
    return ok(to);
  } catch (err) {
    return classifyWriteError(err);
  }
}

/** Records a Curator verification of a cycle (state, time, Curator) and emits `program_cycle.verified`. */
export async function verifyCycle(db: Db, cycleId: string, curatorId: string, ctx: PublishContext): Promise<RepoResult<true>> {
  try {
    await runBatch(db, [
      versionGuard(db, ctx.guardKey, "program_cycles", cycleId, ctx.cycleVersion, ctx.now),
      db
        .update(s.programCycles)
        .set({ verificationState: "verified", lastVerifiedAt: ctx.now, verifiedBy: curatorId, updatedAt: ctx.now, version: sql`${s.programCycles.version} + 1` })
        .where(eq(s.programCycles.id, cycleId)),
      db
        .update(s.deadlines)
        .set({ verificationState: "verified", updatedAt: ctx.now })
        .where(and(eq(s.deadlines.programCycleId, cycleId), isNull(s.deadlines.withdrawnAt), sql`${s.deadlines.basis} <> 'predicted'`)),
      db
        .update(s.requirements)
        .set({ verificationState: "verified", updatedAt: ctx.now })
        .where(and(eq(s.requirements.programCycleId, cycleId), isNull(s.requirements.withdrawnAt))),
      audit(db, ctx, "program_cycle", cycleId, "verification_state", null, "verified"),
      changeEvent(db, ctx, "program_cycle.verified", cycleId, {}),
    ]);
    return ok(true);
  } catch (err) {
    return classifyWriteError(err);
  }
}

export type RequirementInput = Omit<Requirement, "id" | "evidence" | "verificationState"> & { sortOrder?: number };

export async function addRequirement(db: Db, input: RequirementInput, evidence: readonly EvidenceInsert[], ctx: PublishContext): Promise<RepoResult<string>> {
  const id = uuidv7(ctx.now);
  const stmts: Stmt[] = [
    versionGuard(db, ctx.guardKey, "program_cycles", input.programCycleId, ctx.cycleVersion, ctx.now),
    db.insert(s.requirements).values({
      id,
      programCycleId: input.programCycleId,
      kind: input.kind,
      label: input.label,
      detail: input.detail,
      quantity: input.quantity,
      wordLimit: input.wordLimit,
      deadlineId: input.deadlineId,
      effortHours: input.effortHours,
      leadTimeDays: input.leadTimeDays,
      sortOrder: input.sortOrder ?? 0,
      verificationState: "draft",
      createdAt: ctx.now,
      updatedAt: ctx.now,
    }),
    audit(db, ctx, "requirement", id, "requirement", null, { kind: input.kind, label: input.label }),
    cycleBump(db, input.programCycleId, ctx.now),
  ];
  const ev = evidenceInsertStatement(db, evidence.map((e) => ({ ...e, entityType: "requirement", entityId: id })), ctx.now);
  if (ev) stmts.push(ev);
  try {
    await runBatch(db, stmts);
    return ok(id);
  } catch (err) {
    return classifyWriteError(err);
  }
}

// =============================================================================================
// Eligibility rule sets
// =============================================================================================

/** Stores a new draft version (validated against the contract); returns its id and version. */
export async function insertRuleSetDraft(
  db: Db,
  cycleId: string,
  draft: EligibilityRuleSetDraft,
  now: number,
): Promise<RepoResult<{ id: string; version: number }>> {
  const parsed = EligibilityRuleSetDraftSchema.safeParse(draft);
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const d = parsed.data;
  const latest = await db
    .select({ version: s.eligibilityRuleSets.version })
    .from(s.eligibilityRuleSets)
    .where(eq(s.eligibilityRuleSets.programCycleId, cycleId))
    .orderBy(desc(s.eligibilityRuleSets.version))
    .limit(1);
  const version = (latest[0]?.version ?? 0) + 1;
  const id = uuidv7(now);
  try {
    await db.insert(s.eligibilityRuleSets).values({
      id,
      programCycleId: cycleId,
      version,
      format: d.format,
      state: "draft",
      templateKey: d.templateKey,
      body: { coverage: d.coverage, rules: d.rules, anyOf: d.anyOf, attestations: d.attestations, nomination: d.nomination, evidence: d.evidence },
      createdVia: d.createdVia,
      fromCycleKey: d.fromCycleKey,
      createdAt: now,
      updatedAt: now,
    });
    return ok({ id, version });
  } catch (err) {
    return classifyWriteError(err);
  }
}

/**
 * Verifies a draft: computes the hash, validates the result as a verified rule set, supersedes
 * the previous verified version and emits `eligibility.changed`, all in one guarded batch.
 */
export async function publishRuleSet(db: Db, ruleSetId: string, curatorId: string, ctx: PublishContext): Promise<RepoResult<{ hash: string }>> {
  const row = await db.query.eligibilityRuleSets.findFirst({ where: eq(s.eligibilityRuleSets.id, ruleSetId) });
  if (!row) return fail("not_found");
  if (row.state !== "draft") return fail("invalid", "only drafts can be published");
  const curator = await db.query.curators.findFirst({ where: eq(s.curators.id, curatorId) });
  if (!curator) return fail("invalid", "unknown curator");
  // Validate first (a verified set must carry a hash, so a placeholder stands in), then hash the
  // parsed set: the stored hash is the one hashMatches() and the release gate recompute.
  const check = EligibilityRuleSetSchema.safeParse({
    ...row.body,
    id: row.id,
    programCycleId: row.programCycleId,
    version: row.version,
    format: row.format,
    state: "verified",
    templateKey: row.templateKey,
    hash: "0".repeat(64),
    createdVia: row.createdVia,
    verifiedAt: iso(ctx.now),
    verifiedBy: curator.publicHandle,
    fromCycleKey: row.fromCycleKey,
  });
  if (!check.success) return fail("invalid", check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const hash = await ruleSetHash(check.data);
  const previous = await db.query.eligibilityRuleSets.findFirst({
    where: and(eq(s.eligibilityRuleSets.programCycleId, row.programCycleId), eq(s.eligibilityRuleSets.state, "verified")),
  });
  const coverage = check.data.coverage;
  const launchComplete = ["standing", "enrollment", "transfer", "gpa", "citizenship", "pell"].every(
    (d) => coverage[d as keyof typeof coverage] === "encoded" || coverage[d as keyof typeof coverage] === "no_restriction",
  );
  const complete = Object.values(coverage).every((c) => c !== "not_reviewed");
  const stmts: Stmt[] = [versionGuard(db, ctx.guardKey, "program_cycles", row.programCycleId, ctx.cycleVersion, ctx.now)];
  if (previous) {
    stmts.push(db.update(s.eligibilityRuleSets).set({ state: "superseded", updatedAt: ctx.now }).where(eq(s.eligibilityRuleSets.id, previous.id)));
  }
  stmts.push(
    db
      .update(s.eligibilityRuleSets)
      .set({ state: "verified", hash, verifiedAt: ctx.now, verifiedBy: curatorId, coverageComplete: complete, launchCoverageComplete: launchComplete, updatedAt: ctx.now })
      .where(eq(s.eligibilityRuleSets.id, ruleSetId)),
    audit(db, ctx, "eligibility_rule_set", ruleSetId, "state", "draft", "verified"),
    changeEvent(db, ctx, "eligibility.changed", row.programCycleId, { ruleSetId, version: row.version, previousVersion: previous?.version ?? null }),
    cycleBump(db, row.programCycleId, ctx.now),
  );
  try {
    await runBatch(db, stmts);
    return ok({ hash });
  } catch (err) {
    return classifyWriteError(err);
  }
}

// =============================================================================================
// Releases
// =============================================================================================

/** Allocates the next release number (max + 1) in state `pending`; part of a publish batch or alone. */
export async function allocateRelease(db: Db, now: number): Promise<number> {
  const rows = await db
    .insert(s.registryReleases)
    .values({ number: sql`(SELECT coalesce(max(number), 0) + 1 FROM ${s.registryReleases})`, createdAt: now })
    .returning({ number: s.registryReleases.number });
  return (rows[0] as { number: number }).number;
}

export async function markReleaseBuilt(db: Db, n: number, info: { clientCoreKey: string; sizeBytes: number; sha256: string; containsSample: boolean }, now: number) {
  await db
    .update(s.registryReleases)
    .set({ state: "built", clientCoreKey: info.clientCoreKey, sizeBytes: info.sizeBytes, sha256: info.sha256, containsSample: info.containsSample, builtAt: now })
    .where(eq(s.registryReleases.number, n));
}

/** The pointer only moves forward: publishing n is a no-op when a later release is already published. */
export async function markReleasePublished(db: Db, n: number, now: number): Promise<boolean> {
  const later = await db
    .select({ number: s.registryReleases.number })
    .from(s.registryReleases)
    .where(and(eq(s.registryReleases.state, "published"), sql`${s.registryReleases.number} > ${n}`))
    .limit(1);
  if (later.length > 0) return false;
  await db.update(s.registryReleases).set({ state: "published", publishedAt: now }).where(eq(s.registryReleases.number, n));
  return true;
}

export async function latestPublishedRelease(db: Db) {
  const rows = await db.select().from(s.registryReleases).where(eq(s.registryReleases.state, "published")).orderBy(desc(s.registryReleases.number)).limit(1);
  return rows[0] ?? null;
}

/** Releases allocated but not built (the tick retries their build). */
export async function pendingReleases(db: Db) {
  return db.select().from(s.registryReleases).where(sql`${s.registryReleases.state} IN ('pending', 'failed')`).orderBy(asc(s.registryReleases.number));
}

/** Releases allocated or built but not yet published, oldest first (release.build works on these). */
export async function unpublishedReleases(db: Db) {
  return db.select().from(s.registryReleases).where(sql`${s.registryReleases.state} IN ('pending', 'built')`).orderBy(asc(s.registryReleases.number));
}

/** A failed gate or a superseded build; failed releases are never retried automatically. */
export async function markReleaseFailed(db: Db, n: number): Promise<void> {
  await db.update(s.registryReleases).set({ state: "failed" }).where(and(eq(s.registryReleases.number, n), sql`${s.registryReleases.state} <> 'published'`));
}

/** True when at least one program is published (a fresh environment's first release needs one). */
export async function hasPublishedPrograms(db: Db): Promise<boolean> {
  const rows = await db.select({ id: s.programs.id }).from(s.programs).where(eq(s.programs.isPublished, true)).limit(1);
  return rows.length > 0;
}

/** Loser slug -> survivor slug for merges and renames since `sinceMs` (client-core `merged`). */
export async function mergedSlugs(db: Db, sinceMs: number): Promise<Record<string, string>> {
  const rows = await db
    .select({ from: s.slugRedirects.fromSlug, to: s.programs.slug })
    .from(s.slugRedirects)
    .innerJoin(s.programs, eq(s.programs.id, s.slugRedirects.toProgramId))
    .where(sql`${s.slugRedirects.createdAt} >= ${sinceMs}`);
  return Object.fromEntries(rows.map((r) => [r.from, r.to]));
}
