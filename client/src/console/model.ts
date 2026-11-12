import type { Deadline } from "@shared/contracts/registry";
import type { DeadlineEdit, DeadlineOp, EvidenceEdit, QuoteMark, RejectReason } from "./api";

/**
 * Pure helpers behind the console screens: keyboard actions, quote highlighting, labels, the
 * active-time counter and the deadline editor's form state. No React, no fetch, so every rule is
 * unit-tested in client/src/console/console.test.ts.
 */

// ---------------------------------------------------------------------------------------------
// Keyboard (plan 01 F-16): A approve, E edit, R reject, S snooze, X escalate, L release.
// Merge (M) and bulk approve (Shift+A) are not in console v0.
// ---------------------------------------------------------------------------------------------

export const KEY_ACTIONS = {
  a: "approve",
  e: "edit",
  r: "reject",
  s: "snooze",
  x: "escalate",
  l: "release",
  o: "open_official",
  c: "claim",
  j: "next",
  k: "previous",
  "?": "help",
} as const;
export type KeyAction = (typeof KEY_ACTIONS)[keyof typeof KEY_ACTIONS];

export const KEY_HELP: readonly { key: string; action: string }[] = [
  { key: "C", action: "Claim the selected task (15-minute lease); press again to extend it" },
  { key: "O", action: "Open the live official page (logged; needed before changing a deadline, status or URL)" },
  { key: "A", action: "Approve (verified as of now): press A twice within 3 seconds" },
  { key: "E", action: "Edit values before approving" },
  { key: "R", action: "Reject with a reason code" },
  { key: "S", action: "Snooze with a reason and a date" },
  { key: "X", action: "Escalate to an admin" },
  { key: "L", action: "Release the claim" },
  { key: "J / K", action: "Next / previous task in the queue" },
];

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** Tag name of the event target; keys typed into fields are text, not commands. */
  targetTag?: string | null;
  targetEditable?: boolean;
}

export function actionForKey(e: KeyLike): KeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const tag = (e.targetTag ?? "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.targetEditable) return null;
  if (e.shiftKey && e.key !== "?") return null; // Shift+A (bulk approve) is deliberately not wired.
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return (KEY_ACTIONS as Record<string, KeyAction>)[k] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Highlighting: split Snapshot text into segments carrying the quote kinds that cover them.
// ---------------------------------------------------------------------------------------------

export interface Segment {
  text: string;
  start: number;
  kinds: ("verified" | "proposed")[];
  refs: string[];
}

export function segments(text: string, marks: readonly QuoteMark[]): Segment[] {
  const cuts = new Set<number>([0, text.length]);
  for (const m of marks) {
    if (m.start >= 0 && m.end <= text.length && m.start < m.end) {
      cuts.add(m.start);
      cuts.add(m.end);
    }
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (start === end) continue;
    const covering = marks.filter((m) => m.start <= start && m.end >= end);
    const kinds = [...new Set(covering.map((m) => m.kind))].sort() as Segment["kinds"];
    out.push({ text: text.slice(start, end), start, kinds, refs: covering.map((m) => m.ref) });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

export function dueLabel(dueAt: string | null, now: number): { text: string; tone: "late" | "soon" | "ok" | "none" } {
  if (!dueAt) return { text: "No due time", tone: "none" };
  const ms = Date.parse(dueAt) - now;
  const abs = Math.abs(ms);
  const unit = abs < 3_600_000 ? `${Math.max(1, Math.round(abs / 60_000))} min` : abs < 172_800_000 ? `${Math.round(abs / 3_600_000)} h` : `${Math.round(abs / 86_400_000)} d`;
  if (ms < 0) return { text: `Overdue by ${unit}`, tone: "late" };
  if (ms < 24 * 3_600_000) return { text: `Due in ${unit}`, tone: "soon" };
  return { text: `Due in ${unit}`, tone: "ok" };
}

// ---------------------------------------------------------------------------------------------
// Claim lease and the approve confirmation
// ---------------------------------------------------------------------------------------------

/** Warn this long before a claim (15-minute lease) ends. */
export const CLAIM_WARN_MS = 2 * 60_000;

export type ClaimStatus =
  | { kind: "none" }
  | { kind: "other"; by: string | null; live: boolean }
  | { kind: "held"; msLeft: number; text: string; warn: boolean }
  | { kind: "expired" };

/** "mm:ss", never negative. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Where the viewer's claim on a task stands. A claim whose lease has run out is "expired" even
 * while the row still says `claimed`: the server refuses every write on it, so the UI does too.
 */
export function claimStatus(
  task: { state: string; claimedBy: string | null; claimExpiresAt: string | null },
  handle: string,
  now: number,
): ClaimStatus {
  if (task.state !== "claimed") return { kind: "none" };
  const ends = task.claimExpiresAt ? Date.parse(task.claimExpiresAt) : Number.NaN;
  if (task.claimedBy !== handle) return { kind: "other", by: task.claimedBy, live: Number.isFinite(ends) && ends > now };
  if (!Number.isFinite(ends)) return { kind: "expired" };
  const msLeft = ends - now;
  if (msLeft <= 0) return { kind: "expired" };
  return { kind: "held", msLeft, text: `Claim ends in ${formatCountdown(msLeft)}`, warn: msLeft <= CLAIM_WARN_MS };
}

/** The A key publishes only when pressed twice within this window. */
export const APPROVE_CONFIRM_MS = 3_000;

/** First A press arms the approval; a second press before `armedUntil` approves. */
export function approveKeyStep(armedUntil: number | null, now: number): "arm" | "approve" {
  return armedUntil !== null && now < armedUntil ? "approve" : "arm";
}

export function severityLabel(severity: number): "High" | "Medium" | "Low" {
  if (severity >= 0.8) return "High";
  if (severity >= 0.5) return "Medium";
  return "Low";
}

export function humanize(code: string): string {
  const s = code.replace(/[_.:]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const REJECT_LABELS: Record<RejectReason, string> = {
  no_material_change: "No material change (false alarm)",
  not_official_source: "Not an official source",
  quote_not_found: "Quote not on the official page",
  duplicate: "Duplicate of another task or record",
  out_of_scope: "Out of scope for Novus",
  source_unreachable: "Official page unreachable",
  other: "Other (explain)",
};

export const HIGH_IMPACT_LABELS: Record<string, string> = {
  status_paused_or_ended: "Status set to paused or ended",
  deadline_moved_earlier: "A deadline moved more than 3 days earlier",
  new_application_host: "The application link moved to a new site",
  attested_change: "A change backed by a note rather than the official page",
};

export const STATE_LABELS: Record<string, string> = {
  open: "Open",
  claimed: "Claimed",
  second_review: "Second review",
  approved: "Approved",
  applied: "Published",
  apply_failed: "Apply failed",
  rejected: "Rejected",
  snoozed: "Snoozed",
  escalated: "Escalated",
};

export function formatSeconds(seconds: number | null): string {
  if (seconds === null) return "n/a";
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

export function formatCents(cents: number | null): string {
  if (cents === null) return "None stated";
  return `$${(cents / 100).toFixed(2)}`;
}

// ---------------------------------------------------------------------------------------------
// Active time (plan 01 F-16 metrics: median active minutes per task)
// ---------------------------------------------------------------------------------------------

/** Idle after this long without input: the counter pauses, so a forgotten tab does not count. */
export const IDLE_AFTER_MS = 90_000;
export const MAX_ACTIVE_SECONDS = 3600;

export class ActiveTimer {
  private activeMs = 0;
  private lastTick: number;
  /** Activity counts until this instant (the last input plus the idle allowance). */
  private activeUntil: number;
  /** When activity resumed after an idle gap; time before it is not counted. */
  private resumedAt: number;

  constructor(now: number) {
    this.lastTick = now;
    this.activeUntil = now + IDLE_AFTER_MS;
    this.resumedAt = now;
  }

  input(now: number): void {
    if (now > this.activeUntil) this.resumedAt = now;
    this.activeUntil = now + IDLE_AFTER_MS;
  }

  /** Counts the part of the time since the last tick that was visible, focused and not idle. */
  tick(now: number, visible: boolean, focused: boolean): void {
    if (visible && focused) {
      const start = Math.max(this.lastTick, this.resumedAt);
      const end = Math.min(now, this.activeUntil);
      if (end > start) this.activeMs += end - start;
    }
    this.lastTick = Math.max(this.lastTick, now);
  }

  seconds(): number {
    return Math.min(MAX_ACTIVE_SECONDS, Math.round(this.activeMs / 1000));
  }
}

// ---------------------------------------------------------------------------------------------
// Deadline editor
// ---------------------------------------------------------------------------------------------

export interface DeadlineForm {
  /** The live Deadline this row edits, or null for a new one. */
  deadlineId: string | null;
  withdraw: boolean;
  kind: string;
  precision: DeadlineEdit["precision"];
  localDate: string;
  localTime: string;
  timeZone: string;
  tzMode: "fixed" | "applicant_local";
  scope: "national" | "campus";
  institutionId: string | null;
  roundLabel: string;
  quote: string;
  snapshotId: string | null;
  page: string;
}

export function formFromDeadline(d: Deadline): DeadlineForm {
  return {
    deadlineId: d.id,
    withdraw: false,
    kind: d.kind,
    precision: d.precision === "window" ? "tbd" : d.precision,
    localDate: d.localDate ?? "",
    localTime: d.localTime ?? "",
    timeZone: d.timeZone ?? "",
    tzMode: d.tzMode,
    scope: d.scope,
    institutionId: d.institutionId,
    roundLabel: d.roundLabel,
    quote: "",
    snapshotId: null,
    page: "",
  };
}

/** Whether the form differs from the live value (only changed rows are sent). */
export function formChanged(form: DeadlineForm, original: Deadline | undefined): boolean {
  if (!original) return true;
  if (form.withdraw) return true;
  return (
    form.localDate !== (original.localDate ?? "") ||
    form.localTime !== (original.localTime ?? "") ||
    form.timeZone !== (original.timeZone ?? "") ||
    form.precision !== original.precision ||
    form.tzMode !== original.tzMode
  );
}

export type BuiltOp = { ok: true; op: DeadlineOp } | { ok: false; message: string };

/** Turns one form row into the API's deadline op, or says what is missing. */
export function buildDeadlineOp(form: DeadlineForm, evidenceUrl: string): BuiltOp {
  const evidence: EvidenceEdit | null = form.quote.trim()
    ? {
        snapshotId: form.snapshotId,
        url: evidenceUrl,
        quote: form.quote.trim(),
        basis: form.snapshotId ? "snapshot" : "manual_note",
        page: form.page ? Number(form.page) : null,
      }
    : null;
  if (form.withdraw) {
    if (!form.deadlineId) return { ok: false, message: "Only a live deadline can be withdrawn." };
    return { ok: true, op: { op: "withdraw", deadlineId: form.deadlineId, evidence } };
  }
  if (!evidence) return { ok: false, message: "Paste the verbatim quote from the official page." };
  const dated = form.precision === "exact" || form.precision === "date_only" || form.precision === "month_only";
  if (dated && !form.localDate) return { ok: false, message: "Enter the date." };
  if (form.precision === "exact" && !form.localTime) return { ok: false, message: "Exact deadlines need a time." };
  const zone = form.tzMode === "fixed" && dated && form.precision !== "month_only" ? form.timeZone || null : null;
  if (form.tzMode === "fixed" && (form.precision === "exact" || form.precision === "date_only") && !zone) return { ok: false, message: "Enter the time zone the page states, such as America/Chicago." };
  return {
    ok: true,
    op: {
      op: "upsert",
      deadline: {
        kind: form.kind,
        scope: form.scope,
        institutionId: form.institutionId,
        roundLabel: form.roundLabel,
        precision: form.precision,
        tzMode: form.tzMode,
        localDate: dated ? form.localDate : null,
        localTime: form.precision === "exact" ? form.localTime : null,
        timeZone: zone,
      },
      evidence,
    },
  };
}

/**
 * The quote a Curator selected in the Snapshot pane, trimmed to one sentence-sized span. The
 * server re-checks it against the stored text, so this is a convenience, not a guarantee.
 */
export function selectionQuote(selected: string, max = 1000): string {
  return selected.replace(/\s+/g, " ").trim().slice(0, max);
}
