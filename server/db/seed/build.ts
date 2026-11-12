import { addDays, computeDueAt, computeSortAt, formatCycleKey, parseIsoDate } from "../../../shared/time";
import {
  ELIGIBILITY_DIMENSIONS,
  LAUNCH_DIMENSIONS,
  EligibilityRuleSetSchema,
  type Coverage,
  type EligibilityDimension,
  type EligibilityRuleSet,
} from "../../../shared/contracts/eligibility";
import { deadlineIssues } from "../../../shared/contracts/registry";
import type { EvidenceQuote } from "../../../shared/contracts/evidence";
import type { CycleStatus, Term } from "../../../shared/taxonomy";
import { stableId } from "../columns";
import type * as s from "../schema";
import { iso, ruleSetHash } from "../util";
import {
  SAMPLE_CURATOR_HANDLE,
  SAMPLE_INSTITUTIONS,
  SAMPLE_ORGANIZATIONS,
  SAMPLE_PROGRAMS,
  SAMPLE_TODAY,
  SAMPLE_URL_BASE,
  type SampleDeadline,
  type SampleProgram,
} from "./sample-data";

/**
 * Turns the sample definitions into table rows. Pure apart from hashing: ids are stable
 * (`stableId`) so a reseed targets the same rows, and every date is relative to `today`.
 */

type Insert<T extends { $inferInsert: unknown }> = T["$inferInsert"];

export interface SampleSeed {
  today: string;
  curators: Insert<typeof s.curators>[];
  organizations: Insert<typeof s.organizations>[];
  institutions: Insert<typeof s.institutions>[];
  institutionEmailDomains: Insert<typeof s.institutionEmailDomains>[];
  programs: Insert<typeof s.programs>[];
  programTypes: Insert<typeof s.programTypes>[];
  programAliases: Insert<typeof s.programAliases>[];
  programInterestTags: Insert<typeof s.programInterestTags>[];
  programFields: Insert<typeof s.programFields>[];
  programMajorFamilies: Insert<typeof s.programMajorFamilies>[];
  programCycles: Insert<typeof s.programCycles>[];
  deadlines: Insert<typeof s.deadlines>[];
  requirements: Insert<typeof s.requirements>[];
  eligibilityRuleSets: Insert<typeof s.eligibilityRuleSets>[];
  institutionParticipation: Insert<typeof s.institutionParticipation>[];
  /** The full contract objects, for validation and tests. */
  ruleSetObjects: EligibilityRuleSet[];
}

export const sampleIds = {
  curator: () => stableId("sample:curator"),
  organization: (key: string) => stableId(`sample:org:${key}`),
  institution: (key: string) => stableId(`sample:institution:${key}`),
  program: (slug: string) => stableId(`sample:program:${slug}`),
  cycle: (slug: string) => stableId(`sample:cycle:${slug}`),
  deadline: (slug: string, i: number) => stableId(`sample:deadline:${slug}:${i}`),
  requirement: (slug: string, i: number) => stableId(`sample:requirement:${slug}:${i}`),
  ruleSet: (slug: string) => stableId(`sample:ruleset:${slug}:v1`),
};

/** UTC midnight of a `YYYY-MM-DD` date, as epoch ms (seed bookkeeping only, never a deadline). */
function dayStartMs(isoDate: string): number {
  const d = parseIsoDate(isoDate);
  if (!d) throw new Error(`invalid date ${isoDate}`);
  return Date.UTC(d.year, d.month - 1, d.day);
}

/** The next occurrence of a term on or after `today` (a summer key in November is next summer). */
export function sampleCycleKey(term: Term, today: string): string {
  const d = parseIsoDate(today);
  if (!d) throw new Error(`invalid date ${today}`);
  const academicYearStart = d.month >= 8 ? d.year : d.year - 1;
  switch (term) {
    case "summer":
    case "spring":
    case "year":
      return formatCycleKey(term, academicYearStart + 1);
    case "fall":
      return formatCycleKey("fall", d.month >= 8 ? d.year + 1 : d.year);
    case "winter":
      return formatCycleKey("winter", d.year);
    case "ay":
      return formatCycleKey("ay", academicYearStart + 1);
    case "rolling":
      return formatCycleKey("rolling", d.year);
  }
}

export function termLabel(cycleKey: string): string {
  const ay = /^ay-(\d{4})-(\d{2})$/.exec(cycleKey);
  if (ay) return `${ay[1]}-${ay[2]}`;
  const [term, year] = cycleKey.split("-");
  if (term === "rolling") return "Rolling";
  if (term === "year") return year ?? "";
  return `${(term ?? "").charAt(0).toUpperCase()}${(term ?? "").slice(1)} ${year ?? ""}`;
}

/** Status implied by the sample dates: expected before opening, closed once the application deadline passed. */
export function sampleStatus(p: SampleProgram): CycleStatus {
  if (p.model === "rolling") return "open";
  if ((p.opensInDays ?? 0) > 0) return "expected";
  const application = p.deadlines.filter((d) => d.kind === "application" && d.inDays !== undefined);
  if (application.length > 0 && application.every((d) => (d.inDays as number) < 0)) return "closed";
  return "open";
}

function coverageFor(p: SampleProgram, dims: ReadonlySet<EligibilityDimension>): Partial<Record<EligibilityDimension, Coverage>> {
  const coverage: Partial<Record<EligibilityDimension, Coverage>> = {};
  for (const dim of ELIGIBILITY_DIMENSIONS) {
    if (dim === "team" || dim === "host_enrollment") continue;
    if (dims.has(dim)) coverage[dim] = "encoded";
    else if ((LAUNCH_DIMENSIONS as readonly string[]).includes(dim)) coverage[dim] = p.unverified ? "not_reviewed" : "no_restriction";
    else coverage[dim] = p.unverified ? "not_reviewed" : "none_stated";
  }
  return coverage;
}

function sampleQuote(p: SampleProgram, text: string, today: string): EvidenceQuote {
  return {
    basis: "manual_note",
    url: `${SAMPLE_URL_BASE}/${p.slug}#eligibility`,
    quote: `Sample text, not a real program. ${text}`.slice(0, 400),
    retrievedOn: today,
  };
}

interface DeadlineContext {
  program: SampleProgram;
  cycleId: string;
  orgZone: string;
  today: string;
  verified: boolean;
  institutionIdFor: (key: string) => string;
}

export function buildDeadline(d: SampleDeadline, i: number, ctx: DeadlineContext): Insert<typeof s.deadlines> {
  const campus = d.campusInstitution ? SAMPLE_INSTITUTIONS.find((x) => x.key === d.campusInstitution) : undefined;
  if (d.campusInstitution && !campus) throw new Error(`unknown sample institution ${d.campusInstitution}`);
  const zone = campus?.timeZone ?? ctx.orgZone;
  const date = d.inDays === undefined ? null : addDays(ctx.today, d.inDays);
  const applicantLocal = Boolean(d.applicantLocal);
  const base = {
    kind: d.kind,
    scope: campus ? ("campus" as const) : ("national" as const),
    institutionId: campus ? ctx.institutionIdFor(campus.key) : null,
    roundLabel: d.round ?? "",
    tzMode: applicantLocal ? ("applicant_local" as const) : ("fixed" as const),
  };
  let fields: {
    basis: "official" | "predicted";
    precision: SampleDeadline["precision"];
    localDate: string | null;
    localTime: string | null;
    windowStart: string | null;
    windowEnd: string | null;
    timeZone: string | null;
    tzSource: "stated" | null;
  };
  switch (d.precision) {
    case "exact":
    case "date_only":
      if (!date) throw new Error(`${ctx.program.slug}: dated deadline needs inDays`);
      fields = {
        basis: "official",
        precision: d.precision,
        localDate: date,
        localTime: d.precision === "exact" ? (d.time ?? "23:59") : null,
        windowStart: null,
        windowEnd: null,
        timeZone: applicantLocal ? null : zone,
        tzSource: applicantLocal ? null : "stated",
      };
      break;
    case "month_only":
      if (!date) throw new Error(`${ctx.program.slug}: month-only deadline needs inDays`);
      fields = { basis: "official", precision: "month_only", localDate: date.slice(0, 7), localTime: null, windowStart: null, windowEnd: null, timeZone: zone, tzSource: "stated" };
      break;
    case "window": {
      const [p10, p50, p90] = d.window ?? [0, 0, 0];
      fields = {
        basis: "predicted",
        precision: "window",
        localDate: addDays(ctx.today, p50),
        localTime: null,
        windowStart: addDays(ctx.today, p10),
        windowEnd: addDays(ctx.today, p90),
        timeZone: zone,
        tzSource: "stated",
      };
      break;
    }
    case "rolling":
    case "tbd":
      fields = { basis: "official", precision: d.precision, localDate: null, localTime: null, windowStart: null, windowEnd: null, timeZone: null, tzSource: null };
      break;
  }
  const timeFields = { ...fields, tzMode: base.tzMode };
  const dueAt = computeDueAt(timeFields);
  const sortAt = computeSortAt(timeFields);
  const issues = deadlineIssues({
    id: sampleIds.deadline(ctx.program.slug, i),
    programCycleId: ctx.cycleId,
    ...base,
    ...fields,
    dueAt: dueAt === null ? null : iso(dueAt),
    sortAt: sortAt === null ? null : iso(sortAt),
    revision: 1,
    verificationState: "verified",
    withdrawnAt: null,
  });
  if (issues.length > 0) throw new Error(`${ctx.program.slug} deadline ${i}: ${issues.map((x) => x.message).join("; ")}`);
  return {
    id: sampleIds.deadline(ctx.program.slug, i),
    programCycleId: ctx.cycleId,
    ...base,
    ...fields,
    dueAt,
    sortAt,
    revision: 1,
    verificationState: fields.basis === "predicted" || !ctx.verified ? "unverified" : "verified",
    withdrawnAt: null,
  };
}

export async function buildSampleSeed(today: string = SAMPLE_TODAY): Promise<SampleSeed> {
  if (!parseIsoDate(today)) throw new Error(`invalid --today ${today}`);
  const nowMs = dayStartMs(today);
  const verifiedAtMs = nowMs - 3 * 86_400_000;
  const curatorId = sampleIds.curator();
  const orgByKey = new Map(SAMPLE_ORGANIZATIONS.map((o) => [o.key, o]));
  const institutionIdFor = (key: string): string => {
    if (!SAMPLE_INSTITUTIONS.some((i) => i.key === key)) throw new Error(`unknown sample institution ${key}`);
    return sampleIds.institution(key);
  };

  const seed: SampleSeed = {
    today,
    curators: [{ id: curatorId, publicHandle: SAMPLE_CURATOR_HANDLE, role: "curator", isSample: true, createdAt: nowMs }],
    organizations: SAMPLE_ORGANIZATIONS.map((o) => ({
      id: sampleIds.organization(o.key),
      slug: o.key,
      name: o.name,
      kind: o.kind,
      country: o.country,
      defaultTimeZone: o.timeZone,
      websiteUrl: `${SAMPLE_URL_BASE}/org/${o.key}`,
      isSample: true,
      createdAt: nowMs,
      updatedAt: nowMs,
    })),
    institutions: SAMPLE_INSTITUTIONS.map((i) => ({
      id: sampleIds.institution(i.key),
      unitId: null,
      name: i.name,
      level: i.level,
      control: "public",
      state: i.state,
      calendar: i.calendar,
      timeZone: i.timeZone,
      isSample: true,
      createdAt: nowMs,
      updatedAt: nowMs,
    })),
    institutionEmailDomains: SAMPLE_INSTITUTIONS.map((i) => ({ domain: i.emailDomain, institutionId: sampleIds.institution(i.key), createdAt: nowMs })),
    programs: [],
    programTypes: [],
    programAliases: [],
    programInterestTags: [],
    programFields: [],
    programMajorFamilies: [],
    programCycles: [],
    deadlines: [],
    requirements: [],
    eligibilityRuleSets: [],
    institutionParticipation: [],
    ruleSetObjects: [],
  };

  for (const p of SAMPLE_PROGRAMS) {
    const org = orgByKey.get(p.org);
    if (!org) throw new Error(`${p.slug}: unknown organization ${p.org}`);
    const programId = sampleIds.program(p.slug);
    const cycleId = sampleIds.cycle(p.slug);
    const verified = !p.unverified;
    const cycleKey = sampleCycleKey(p.term, today);

    seed.programs.push({
      id: programId,
      slug: p.slug,
      name: p.name,
      organizationId: sampleIds.organization(org.key),
      summary: p.summary,
      officialUrl: `${SAMPLE_URL_BASE}/${p.slug}`,
      recurrence: p.recurrence,
      lifecycle: "active",
      sensitiveAudience: Boolean(p.sensitiveAudience),
      identityAudience: [...(p.identityAudience ?? [])],
      isWedge: Boolean(p.isWedge),
      isPublished: true,
      isSample: true,
      createdAt: nowMs,
      updatedAt: nowMs,
    });
    p.types.forEach((t, i) => seed.programTypes.push({ programId, typeSlug: t, isPrimary: i === 0 }));
    for (const alias of p.aliases ?? []) seed.programAliases.push({ programId, alias });
    for (const tag of p.tags ?? []) seed.programInterestTags.push({ programId, tag });
    for (const [cipPrefix, relation] of p.cip ?? []) seed.programFields.push({ programId, cipPrefix, relation });
    for (const majorFamily of p.majorFamilies ?? []) seed.programMajorFamilies.push({ programId, majorFamily });

    const opens = p.opensInDays ?? null;
    seed.programCycles.push({
      id: cycleId,
      programId,
      cycleKey,
      termLabel: termLabel(cycleKey),
      cycleModel: p.model ?? "term",
      status: sampleStatus(p),
      statusChangedAt: nowMs,
      statusChangedBy: "system:seed",
      timeZone: org.timeZone,
      opensOn: opens !== null && opens <= 0 ? addDays(today, opens) : null,
      predictedOpensOn: opens !== null && opens > 0 ? addDays(today, opens) : null,
      predictionLabel: opens !== null && opens > 0 ? "medium" : null,
      eventStart: p.event ? addDays(today, p.event[0]) : null,
      eventEnd: p.event ? addDays(today, p.event[1]) : null,
      applicationUrl: `${SAMPLE_URL_BASE}/${p.slug}/apply`,
      pellDisplacement: p.pellDisplacement ?? (p.compensation?.kind === "award" || p.compensation?.kind === "tuition" ? "unknown" : "none"),
      applicationFeeCents: p.applicationFeeCents ?? null,
      participantCostCents: p.participantCostCents ?? null,
      compensation: p.compensation ?? null,
      classYears: [...p.classYears],
      verificationState: verified ? "verified" : "unverified",
      lastVerifiedAt: verified ? verifiedAtMs : null,
      verifiedBy: verified ? curatorId : null,
      createdAt: nowMs,
      updatedAt: nowMs,
    });

    const dlCtx: DeadlineContext = { program: p, cycleId, orgZone: org.timeZone, today, verified, institutionIdFor };
    p.deadlines.forEach((d, i) => seed.deadlines.push(buildDeadline(d, i, dlCtx)));

    p.requirements.forEach((r, i) =>
      seed.requirements.push({
        id: sampleIds.requirement(p.slug, i),
        programCycleId: cycleId,
        kind: r.kind,
        label: r.label,
        quantity: r.quantity ?? 1,
        wordLimit: r.wordLimit ?? null,
        leadTimeDays: r.leadTimeDays ?? null,
        effortHours: r.effortHours ?? null,
        sortOrder: i,
        verificationState: verified ? "verified" : "unverified",
        createdAt: nowMs,
        updatedAt: nowMs,
      }),
    );

    if (p.nomination && p.deadlines.some((d) => d.campusInstitution)) {
      const year = Number(cycleKey.slice(-4)) || Number(today.slice(0, 4));
      for (const d of p.deadlines) {
        if (!d.campusInstitution) continue;
        seed.institutionParticipation.push({
          programId,
          institutionId: institutionIdFor(d.campusInstitution),
          listYear: year,
          basis: "official_list",
          createdAt: nowMs,
        });
      }
    }

    const ruleSet = await buildRuleSet(p, cycleId, cycleKey, today, verified, verifiedAtMs, { institutionId: institutionIdFor });
    seed.ruleSetObjects.push(ruleSet);
    seed.eligibilityRuleSets.push({
      id: ruleSet.id,
      programCycleId: cycleId,
      version: ruleSet.version,
      format: ruleSet.format,
      state: ruleSet.state,
      templateKey: null,
      body: {
        coverage: ruleSet.coverage,
        rules: ruleSet.rules,
        anyOf: ruleSet.anyOf,
        attestations: ruleSet.attestations,
        nomination: ruleSet.nomination,
        evidence: ruleSet.evidence,
      },
      hash: ruleSet.hash,
      coverageComplete: verified,
      launchCoverageComplete: verified,
      createdVia: "sample",
      fromCycleKey: null,
      verifiedAt: verified ? verifiedAtMs : null,
      verifiedBy: verified ? curatorId : null,
      createdAt: nowMs,
      updatedAt: nowMs,
    });
  }
  return seed;
}

async function buildRuleSet(
  p: SampleProgram,
  cycleId: string,
  cycleKey: string,
  today: string,
  verified: boolean,
  verifiedAtMs: number,
  ctx: { institutionId: (key: string) => string },
): Promise<EligibilityRuleSet> {
  const rules = p.rules(ctx);
  const evidence: Record<string, EvidenceQuote> = {};
  for (const r of rules) if (r.evidenceKey) evidence[r.evidenceKey] = sampleQuote(p, r.officialText, today);
  if (p.nomination?.evidenceKey) evidence[p.nomination.evidenceKey] ??= sampleQuote(p, "Sample rule: a campus representative nominates applicants.", today);
  const dims = new Set(rules.map((r) => r.dimension));
  const attestations = (p.attestations ?? []).map((a) => ({ ...a, sensitive: true, evidenceKey: null }));
  // A verified rule set must carry a hash to parse; the real one is computed from the parsed set
  // (defaults applied) below, exactly as hashMatches() recomputes it.
  const hash = verified ? HASH_PLACEHOLDER : null;
  const parsed = EligibilityRuleSetSchema.safeParse({
    id: sampleIds.ruleSet(p.slug),
    programCycleId: cycleId,
    version: 1,
    format: "jsonlogic-v1",
    state: verified ? "verified" : "draft",
    templateKey: null,
    coverage: coverageFor(p, dims),
    rules,
    anyOf: [...(p.anyOf ?? [])],
    attestations,
    nomination: p.nomination ?? null,
    evidence,
    hash,
    createdVia: "sample",
    verifiedAt: verified ? iso(verifiedAtMs) : null,
    verifiedBy: verified ? SAMPLE_CURATOR_HANDLE : null,
    fromCycleKey: null,
  });
  if (!parsed.success) {
    throw new Error(`${p.slug} (${cycleKey}) rule set invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return verified ? { ...parsed.data, hash: await ruleSetHash(parsed.data) } : parsed.data;
}

const HASH_PLACEHOLDER = "0".repeat(64);
