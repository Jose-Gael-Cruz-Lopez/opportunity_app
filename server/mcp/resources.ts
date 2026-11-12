import { OPPORTUNITY_TYPES } from "@shared/taxonomy";
import { MCP_CONFIG } from "./config";
import type { McpRegistry } from "./registry";
import { toProgramSummary } from "./shapes";

/**
 * MCP resources (plan 8.12): a short methodology note, the opportunity-type taxonomy and one
 * program by slug. The program template has no list callback on purpose: no MCP surface lists the
 * whole registry; search_programs pages through it with limits instead.
 */

export const RESOURCE_URIS = {
  methodology: "novus://methodology",
  opportunityTypes: "novus://taxonomy/opportunity-types",
  programTemplate: "novus://programs/{slug}",
} as const;

export function methodologyText(origin: string): string {
  const base = origin.replace(/\/+$/, "");
  return [
    "# How Novus verifies records",
    "",
    "- Every published program and deadline was checked by a Novus Curator against the program's official page;",
    "  each record names the Curator handle and the date.",
    "- Records older than the freshness window are labelled aging or stale and re-checked; a record under",
    "  re-verification says so.",
    "- Predicted dates are labelled \"predicted, not announced\" and carry the interval they came from.",
    "- Eligibility is computed by deterministic rules over non-sensitive answers. Status and identity criteria are",
    "  never evaluated by Novus servers; they come back as self_check with the official rule text.",
    "- No tool returns a score, percentage or match number about a student.",
    `- Data license: ${MCP_CONFIG.dataLicense}. Terms: ${base}${MCP_CONFIG.termsPath}. Methods: ${base}${MCP_CONFIG.methodsPath}.`,
    "- The official program page always governs.",
  ].join("\n");
}

export function opportunityTypesJson(): string {
  const types = OPPORTUNITY_TYPES.filter((t) => t.inScope).map((t) => ({ slug: t.slug, label: t.label, group: t.group }));
  return JSON.stringify({ types }, null, 2);
}

/** One program summary with its citation, or null when the slug is unknown. */
export function programResourceJson(registry: McpRegistry, slug: string, origin: string, now: number): string | null {
  const card = registry.findCard(slug);
  if (!card) return null;
  return JSON.stringify(toProgramSummary(card, { origin, release: registry.release }, now), null, 2);
}
