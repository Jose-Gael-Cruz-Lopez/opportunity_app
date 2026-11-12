import { and, desc, eq, inArray } from "drizzle-orm";
import type { Deadline, Requirement } from "@shared/contracts/registry";
import type { AuditLogEntry, ReviewTask } from "@shared/contracts/ops";
import type { Db } from "@server/db/client";
import * as s from "@server/db/schema";
import { audit, registry } from "@server/db/repos";
import { iso, isoOrNull } from "@server/db/util";
import type { CuratorBucket } from "./ports";
import { changedHunks, highlightRanges, lineDiff, plainModelText, type DiffOp, type QuoteMark } from "./text";
import { subjectLinks, toWire, type TaskRow } from "./store";

/**
 * The side-by-side evidence view of one task (plan 04 4.10, 01 F-16):
 *
 *   left   verified values (cycle fields, live Deadlines, Requirements) with their quotes
 *   right  each relevant Snapshot as plain text with every quote highlighted, the window diff
 *          against the Source's baseline ("changes first"), and the pipeline's draft proposals
 *   below  validator findings (codes and offsets, never model confidence), risk signals,
 *          official links (PDFs at `#page=N`) and the cycle's audit history
 *
 * Model-written values are plain text with links stripped. Nothing here reads student data:
 * the subject is always a registry entity and the texts are public official pages.
 */

/** Snapshot text shown per Snapshot; longer texts are cut (the official link has the rest). */
export const MAX_SNAPSHOT_CHARS = 120_000;
const MAX_SNAPSHOTS = 4;
const MAX_SOURCES = 5;

export interface EvidenceQuoteView {
  id: string;
  entityType: string;
  entityId: string;
  fieldPath: string;
  quote: string;
  url: string;
  snapshotId: string | null;
  basis: string;
  match: string;
  page: number | null;
}

export interface SnapshotView {
  id: string;
  sourceId: string;
  role: "latest" | "baseline" | "task";
  finalUrl: string;
  /** The link a Curator opens: `#page=N` for PDF evidence. */
  officialLink: string;
  fetchedAt: string;
  contentType: string;
  isPdf: boolean;
  changeClass: string | null;
  httpStatus: number;
  text: string | null;
  textTruncated: boolean;
  /** Why there is no text: no text layer stored, store unbound or object missing. */
  textUnavailable: "no_text_layer" | "store_unavailable" | "missing" | null;
  highlights: QuoteMark[];
  /** Quote refs not found in this Snapshot's text ("quote_missing" is itself a finding). */
  missingQuotes: string[];
}

export interface DiffView {
  sourceId: string;
  baselineSnapshotId: string;
  latestSnapshotId: string;
  hunks: DiffOp[];
  truncated: boolean;
}

export interface ProposalView {
  ref: string;
  field: string;
  value: string;
  quote: string;
  status: string;
}

export interface FindingView {
  path: string;
  code: string;
  blocked: boolean;
  flags: string[];
}

export interface EvidenceView {
  task: ReviewTask;
  program: { id: string; name: string; slug: string; officialUrl: string; isSample: boolean } | null;
  cycle: {
    id: string;
    cycleKey: string;
    termLabel: string;
    status: string;
    version: number;
    applicationUrl: string | null;
    applicationFeeCents: number | null;
    opensOn: string | null;
    verificationState: string;
    lastVerifiedAt: string | null;
    verifiedBy: string | null;
  } | null;
  verified: { deadlines: Deadline[]; requirements: Requirement[]; evidence: EvidenceQuoteView[] };
  snapshots: SnapshotView[];
  diffs: DiffView[];
  proposals: ProposalView[];
  findings: FindingView[];
  riskSignals: string[];
  firstApproval: { by: string | null; at: string | null; reasons: string[]; edits: unknown } | null;
  officialOpenedByMe: boolean;
  history: AuditLogEntry[];
}

function pageOf(locator: unknown): number | null {
  if (locator && typeof locator === "object" && typeof (locator as { page?: unknown }).page === "number") return (locator as { page: number }).page;
  return null;
}

export function officialLink(finalUrl: string, isPdf: boolean, page: number | null): string {
  if (!isPdf || page === null) return finalUrl;
  return `${finalUrl.split("#")[0]}#page=${page}`;
}

async function readText(bucket: CuratorBucket | null, key: string | null): Promise<{ text: string | null; reason: SnapshotView["textUnavailable"] }> {
  if (!key) return { text: null, reason: "no_text_layer" };
  if (!bucket) return { text: null, reason: "store_unavailable" };
  try {
    const obj = await bucket.get(key);
    if (!obj) return { text: null, reason: "missing" };
    return { text: await obj.text(), reason: null };
  } catch {
    return { text: null, reason: "store_unavailable" };
  }
}

/** Snapshot text by id, for quote checks at publish time (uncut). */
export async function snapshotText(db: Db, bucket: CuratorBucket | null, snapshotId: string) {
  const snap = await db.query.snapshots.findFirst({ where: eq(s.snapshots.id, snapshotId) });
  if (!snap) return null;
  const { text, reason } = await readText(bucket, snap.textKey);
  return { snapshot: snap, text, reason };
}

const LEAF_FIELDS = ["cycle_status", "opens_on", "application_url", "cost_to_participate", "cycle_label", "program_name"] as const;

/** Draft proposals from the pipeline's extraction, as plain text (never links, never HTML). */
export function proposalsFrom(payload: Record<string, unknown>): ProposalView[] {
  const extraction = payload.extraction as { payload?: Record<string, unknown> } | undefined;
  const page = extraction?.payload;
  if (!page || typeof page !== "object") return [];
  const out: ProposalView[] = [];
  for (const field of LEAF_FIELDS) {
    const leaf = page[field] as { value?: unknown; quote?: unknown; status?: unknown } | undefined;
    if (!leaf || leaf.status === "not_stated") continue;
    out.push({ ref: `proposal:${out.length}`, field, value: plainModelText(leaf.value, 300), quote: plainModelText(leaf.quote, 1000), status: plainModelText(leaf.status, 20) });
  }
  const deadlines = Array.isArray(page.deadlines) ? page.deadlines : [];
  for (const d of deadlines.slice(0, 20) as Record<string, unknown>[]) {
    const value = [d.kind, d.local_date, d.local_time, d.time_zone_text].map((v) => plainModelText(v, 60)).filter(Boolean).join(" ");
    out.push({ ref: `proposal:${out.length}`, field: `deadline.${plainModelText(d.kind, 40)}`, value, quote: plainModelText(d.quote, 1000), status: plainModelText(d.status, 20) });
  }
  return out;
}

/** Validator findings: path, code, blocked and flags only (plan 01 F-16: "never model confidence"). */
export function findingsFrom(payload: Record<string, unknown>): FindingView[] {
  const extraction = payload.extraction as { validation?: { fields?: unknown } } | undefined;
  const fields = extraction?.validation?.fields;
  if (!Array.isArray(fields)) return [];
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
  return fields.slice(0, 100).map((f: Record<string, unknown>) => ({
    path: str(f.path, 120),
    code: str(f.code, 60),
    blocked: f.blocked === true,
    flags: Array.isArray(f.flags) ? f.flags.filter((x): x is string => typeof x === "string").slice(0, 20).map((x) => x.slice(0, 60)) : [],
  }));
}

export function riskSignalsFrom(payload: Record<string, unknown>): string[] {
  const risk = payload.riskSignals ?? payload.risk;
  if (!Array.isArray(risk)) return [];
  return risk.filter((x): x is string => typeof x === "string").slice(0, 20).map((x) => x.slice(0, 80));
}

export async function buildEvidenceView(db: Db, bucket: CuratorBucket | null, row: TaskRow, curatorId: string): Promise<EvidenceView> {
  const [task] = await toWire(db, [row]);
  const link = (await subjectLinks(db, [row])).get(row.id);
  const handles = await registry.curatorHandles(db);

  const programRow = link?.programId ? await db.query.programs.findFirst({ where: eq(s.programs.id, link.programId) }) : undefined;
  const cycleRow = link?.cycleId ? await registry.getCycle(db, link.cycleId) : undefined;

  const deadlines = cycleRow ? await registry.listLiveDeadlines(db, [cycleRow.id]) : [];
  const requirements = cycleRow ? await registry.listRequirements(db, cycleRow.id) : [];
  const evidenceRows = [
    ...(cycleRow ? await registry.liveEvidence(db, "program_cycle", [cycleRow.id]) : []),
    ...(deadlines.length ? await registry.liveEvidence(db, "deadline", deadlines.map((d) => d.id)) : []),
  ];
  const evidence: EvidenceQuoteView[] = evidenceRows.map((e) => ({
    id: e.id,
    entityType: e.entityType,
    entityId: e.entityId,
    fieldPath: e.fieldPath,
    quote: e.quote,
    url: e.url,
    snapshotId: e.snapshotId,
    basis: e.basis,
    match: e.match,
    page: pageOf(e.locator),
  }));

  // Snapshots: the task's own evidence, the extraction's Snapshot, then latest and baseline per Source.
  const wanted: { id: string; role: SnapshotView["role"] }[] = [];
  const add = (id: string | null | undefined, role: SnapshotView["role"]) => {
    if (id && !wanted.some((w) => w.id === id)) wanted.push({ id, role });
  };
  const extractionSnapshot = (row.payload.extraction as { snapshotId?: unknown } | undefined)?.snapshotId;
  add(typeof extractionSnapshot === "string" ? extractionSnapshot : null, "task");
  const sources = link?.programId
    ? await db.select().from(s.sources).where(eq(s.sources.programId, link.programId)).limit(MAX_SOURCES)
    : [];
  const pairs: { sourceId: string; baseline: string; latest: string }[] = [];
  for (const src of sources) {
    const latest = await db.select({ id: s.snapshots.id }).from(s.snapshots).where(eq(s.snapshots.sourceId, src.id)).orderBy(desc(s.snapshots.fetchedAt)).limit(1);
    const latestId = latest[0]?.id ?? null;
    add(latestId, "latest");
    if (src.baselineSnapshotId && latestId && src.baselineSnapshotId !== latestId) {
      add(src.baselineSnapshotId, "baseline");
      pairs.push({ sourceId: src.id, baseline: src.baselineSnapshotId, latest: latestId });
    }
  }
  const taskSnapshotIds = row.evidenceIds.length
    ? (await db.select({ id: s.snapshots.id }).from(s.snapshots).where(inArray(s.snapshots.id, row.evidenceIds))).map((r) => r.id)
    : [];
  for (const id of taskSnapshotIds) add(id, "task");

  const proposals = proposalsFrom(row.payload);
  const quotes = [
    ...evidence.map((e) => ({ ref: e.id, quote: e.quote, kind: "verified" as const })),
    ...proposals.filter((p) => p.quote).map((p) => ({ ref: p.ref, quote: p.quote, kind: "proposed" as const })),
  ];

  const snapshots: SnapshotView[] = [];
  const fullText = new Map<string, string>();
  const chosen = wanted.slice(0, MAX_SNAPSHOTS + pairs.length);
  const snapRows = chosen.length ? await db.select().from(s.snapshots).where(inArray(s.snapshots.id, chosen.map((w) => w.id))) : [];
  for (const want of chosen) {
    const snap = snapRows.find((r) => r.id === want.id);
    if (!snap) continue;
    const { text, reason } = await readText(bucket, snap.textKey);
    if (text !== null) fullText.set(snap.id, text);
    const shown = text === null ? null : text.slice(0, MAX_SNAPSHOT_CHARS);
    const isPdf = snap.contentType.toLowerCase().includes("pdf");
    const firstPage = evidence.find((e) => e.snapshotId === snap.id && e.page !== null)?.page ?? null;
    const hl = shown === null ? { marks: [], missing: [] } : highlightRanges(shown, quotes);
    snapshots.push({
      id: snap.id,
      sourceId: snap.sourceId,
      role: want.role,
      finalUrl: snap.finalUrl,
      officialLink: officialLink(snap.finalUrl, isPdf, firstPage),
      fetchedAt: iso(snap.fetchedAt),
      contentType: snap.contentType,
      isPdf,
      changeClass: snap.changeClass,
      httpStatus: snap.httpStatus,
      text: shown,
      textTruncated: text !== null && text.length > MAX_SNAPSHOT_CHARS,
      textUnavailable: reason,
      highlights: hl.marks,
      missingQuotes: hl.missing,
    });
  }

  const diffs: DiffView[] = [];
  for (const p of pairs) {
    const a = fullText.get(p.baseline);
    const b = fullText.get(p.latest);
    if (a === undefined || b === undefined) continue;
    const d = lineDiff(a, b);
    diffs.push({ sourceId: p.sourceId, baselineSnapshotId: p.baseline, latestSnapshotId: p.latest, hunks: changedHunks(d.ops).slice(0, 300), truncated: d.truncated });
  }

  const first = row.payload.firstApproval as { by?: unknown; at?: unknown; reasons?: unknown; edits?: unknown } | undefined;
  const opened = row.payload.officialOpened as Record<string, unknown> | undefined;

  const history = cycleRow ? await audit.listRegistryAudit(db, "program_cycle", cycleRow.id, 30) : [];
  const taskHistory = await db
    .select()
    .from(s.registryAudit)
    .where(and(eq(s.registryAudit.taskId, row.id)))
    .orderBy(desc(s.registryAudit.at))
    .limit(30);
  const seen = new Set(history.map((h) => h.id));
  for (const r of taskHistory) {
    if (seen.has(r.id)) continue;
    history.push({
      log: "registry",
      id: r.id,
      at: iso(r.at),
      actor: { kind: r.actorKind as AuditLogEntry["actor"]["kind"], ref: r.actorRef },
      entityType: r.entityType as never,
      entityId: r.entityId,
      field: r.field,
      before: (r.before as { v?: unknown } | null)?.v ?? null,
      after: (r.after as { v?: unknown } | null)?.v ?? null,
      taskId: r.taskId,
      snapshotIds: r.snapshotIds,
    });
  }
  history.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  return {
    task: task!,
    program: programRow
      ? { id: programRow.id, name: programRow.name, slug: programRow.slug, officialUrl: programRow.officialUrl, isSample: programRow.isSample }
      : null,
    cycle: cycleRow
      ? {
          id: cycleRow.id,
          cycleKey: cycleRow.cycleKey,
          termLabel: cycleRow.termLabel,
          status: cycleRow.status,
          version: cycleRow.version,
          applicationUrl: cycleRow.applicationUrl,
          applicationFeeCents: cycleRow.applicationFeeCents,
          opensOn: cycleRow.opensOn,
          verificationState: cycleRow.verificationState,
          lastVerifiedAt: isoOrNull(cycleRow.lastVerifiedAt),
          verifiedBy: cycleRow.verifiedBy ? (handles.get(cycleRow.verifiedBy) ?? null) : null,
        }
      : null,
    verified: { deadlines, requirements, evidence },
    snapshots,
    diffs,
    proposals,
    findings: findingsFrom(row.payload),
    riskSignals: riskSignalsFrom(row.payload),
    firstApproval: first
      ? {
          by: typeof first.by === "string" ? (handles.get(first.by) ?? null) : null,
          at: typeof first.at === "string" ? first.at : null,
          reasons: Array.isArray(first.reasons) ? first.reasons.filter((x): x is string => typeof x === "string") : [],
          edits: first.edits ?? null,
        }
      : null,
    officialOpenedByMe: !!opened && typeof opened[curatorId] === "string",
    history: history.slice(0, 40),
  };
}
