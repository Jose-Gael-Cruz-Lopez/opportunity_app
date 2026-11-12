import type { DeadlineView, ProgramCard, ProgramDetail, RecordCitation } from "@shared/contracts";
import { MCP_CONFIG } from "./config";

/**
 * Citations for every Program and Deadline an MCP tool returns (plan 8.12, REQ-037): the Novus
 * page, the official page, when and by whom the record was verified, and a ready `citeAs` line.
 * Built only from release data. Attested campus rows never reach MCP, so `basis` is official or
 * predicted here.
 */

export type McpCitation = RecordCitation & { readonly citeAs: string };

export interface CitationContext {
  /** Public origin, for example the APP_ORIGIN var. */
  readonly origin: string;
  readonly release: number;
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

export function novusUrl(ctx: CitationContext, slug: string): string {
  return `${trimOrigin(ctx.origin)}${MCP_CONFIG.programPath(slug)}?ref=mcp`;
}

/** Caps an excerpt at 25 words; public surfaces never quote more. */
export function capExcerpt(text: string | null | undefined, maxWords: number = MCP_CONFIG.maxExcerptWords): string | null {
  if (!text) return null;
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return words.length <= maxWords ? words.join(" ") : `${words.slice(0, maxWords).join(" ")} ...`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** "2027-01-29 17:00 America/New_York", "2027-01 (day not announced)", and so on. */
export function describeDeadlineDate(d: DeadlineView): string {
  switch (d.precision) {
    case "exact":
      return d.tzMode === "applicant_local"
        ? `${d.localDate} ${d.localTime} in the applicant's local time`
        : `${d.localDate} ${d.localTime} ${d.timeZone ?? ""}`.trim();
    case "date_only":
      return d.tzMode === "applicant_local" ? `${d.localDate}, applicant's local time` : `${d.localDate} (${d.timeZone ?? "zone not stated"})`;
    case "month_only":
      return `${d.localDate} (day not announced)`;
    case "window":
      return `predicted between ${d.windowStart} and ${d.windowEnd}, not announced`;
    case "rolling":
      return "rolling admission";
    case "tbd":
      return "date not announced";
  }
}

function verificationClause(card: ProgramCard): string {
  const v = card.verification;
  if (v.state === "reverifying") return `Re-verification in progress${v.verifiedOn ? ` since ${v.verifiedOn}` : ""}.`;
  if (v.verifiedOn && v.verifiedBy) return `Verified ${v.verifiedOn} by ${v.verifiedBy} against ${hostOf(card.officialUrl)}.`;
  return `Not yet verified by a Novus Curator; check ${hostOf(card.officialUrl)}.`;
}

function samplePrefix(card: ProgramCard): string {
  return card.isSample ? "SAMPLE DATA, not a real program: " : "";
}

function displayState(card: ProgramCard): RecordCitation["verificationState"] {
  return card.verification.state === "draft" ? "unverified" : card.verification.state;
}

/** The next national application deadline on a card, for the program citation line. */
export function primaryDeadline(card: ProgramCard): DeadlineView | null {
  return card.deadlines.find((d) => d.scope === "national" && d.kind === "application" && d.basis !== "attested") ?? null;
}

export function citeProgram(card: ProgramCard, ctx: CitationContext, detail: ProgramDetail | null = null): McpCitation {
  const url = novusUrl(ctx, card.slug);
  const main = primaryDeadline(card);
  const deadlineText = main ? `national deadline ${describeDeadlineDate(main)}` : "no deadline announced";
  return {
    novusUrl: url,
    officialUrl: card.officialUrl,
    basis: "official",
    evidenceUrl: detail?.citation.evidenceUrl ?? null,
    evidenceExcerpt: capExcerpt(detail?.citation.evidenceExcerpt),
    lastVerifiedAt: card.verification.verifiedOn,
    verifiedBy: card.verification.verifiedBy,
    derivation: null,
    sourceCheckedAt: detail?.citation.sourceCheckedAt ?? null,
    verificationState: displayState(card),
    freshness: card.verification.freshness,
    recordVersion: String(ctx.release),
    license: MCP_CONFIG.dataLicense,
    termsUrl: `${trimOrigin(ctx.origin)}${MCP_CONFIG.termsPath}`,
    citeAs: `${samplePrefix(card)}${card.name} (${card.cycleKey} cycle): ${deadlineText}. ${verificationClause(card)} Source: Novus, ${url}.`,
  };
}

export function citeDeadline(card: ProgramCard, d: DeadlineView, ctx: CitationContext, detail: ProgramDetail | null = null): McpCitation {
  const base = citeProgram(card, ctx, detail);
  const predicted = d.basis === "predicted";
  const label = d.kind.replace(/_/g, " ");
  return {
    ...base,
    basis: predicted ? "predicted" : "official",
    // Predicted dates were not read from a page, so they carry no evidence and no verification date.
    evidenceUrl: predicted ? null : base.evidenceUrl,
    evidenceExcerpt: predicted ? null : base.evidenceExcerpt,
    lastVerifiedAt: predicted ? null : base.lastVerifiedAt,
    verifiedBy: predicted ? null : base.verifiedBy,
    derivation: predicted
      ? {
          method: "cycle_prediction",
          p10: card.prediction?.p10 ?? d.windowStart,
          p90: card.prediction?.p90 ?? d.windowEnd,
          leadTimeDays: null,
          priorCycleUrl: null,
        }
      : null,
    recordVersion: `${ctx.release}.${d.revision}`,
    citeAs:
      `${samplePrefix(card)}${card.name} (${card.cycleKey} cycle): ${label} ${describeDeadlineDate(d)}` +
      `${predicted ? " (predicted, not announced)" : ""}. ${predicted ? "" : `${verificationClause(card)} `}Source: Novus, ${base.novusUrl}.`,
  };
}
