import { z } from "zod";
import type { ProgramCard } from "@shared/contracts";
import { filterCards, nextDeadlineDate, search, type SearchFilters } from "@shared/matching";
import { compareIsoDates } from "@shared/time";
import { MCP_CONFIG } from "../config";
import type { McpRegistry } from "../registry";
import { CursorSchema, ProgramSummarySchema, decodeCursor, paginate, toProgramSummary } from "../shapes";
import { limitSchema, openToCommunityCollege, searchFilterShape, toSearchFilters } from "./filters";
import { ToolError, type ToolDef } from "./types";

const SearchProgramsInput = z
  .object({
    query: z.string().max(MCP_CONFIG.maxQueryChars).optional().describe("Words to search program names, organizations, aliases and topics."),
    ...searchFilterShape,
    limit: limitSchema,
    cursor: CursorSchema.optional().describe("nextCursor from a previous call."),
  })
  .strict();

const SearchProgramsOutput = z
  .object({
    programs: z.array(ProgramSummarySchema),
    nextCursor: z.string().nullable(),
    release: z.number().int(),
    containsSample: z.boolean(),
  })
  .strict();

/** Search pages through MiniSearch 100 at a time (its cap) up to the pagination depth. */
function rankedByQuery(registry: McpRegistry, query: string, filters: SearchFilters, now: number): ProgramCard[] {
  const out: ProgramCard[] = [];
  const page = 100;
  for (let offset = 0; offset < MCP_CONFIG.maxPaginationDepth; offset += page) {
    const hits = search(registry.index, query, { filters, limit: page, offset, now });
    out.push(...hits.map((h) => h.card));
    if (hits.length < page) break;
  }
  return out;
}

/** Browse order without a query: next deadline first (undated last), then name. Deterministic. */
function browseOrder(cards: readonly ProgramCard[], filters: SearchFilters, now: number): ProgramCard[] {
  const dated = filterCards(cards, filters, { now }).map((card) => ({ card, next: nextDeadlineDate(card, { now }) }));
  dated.sort((a, b) => {
    if (a.next && b.next) return compareIsoDates(a.next, b.next) || a.card.name.localeCompare(b.card.name);
    if (a.next) return -1;
    if (b.next) return 1;
    return a.card.name.localeCompare(b.card.name);
  });
  return dated.map((d) => d.card);
}

export const searchProgramsTool: ToolDef<typeof SearchProgramsInput, typeof SearchProgramsOutput> = {
  name: "search_programs",
  title: "Search programs",
  description:
    "Searches published Novus programs by words and non-sensitive filters. Returns up to 25 programs per call, each " +
    "with its Novus summary, current-cycle status, next national deadline and a citation (official URL, last verified " +
    "date and Curator). Without a query, returns programs in next-deadline order.",
  input: SearchProgramsInput,
  output: SearchProgramsOutput,
  async run(args, ctx) {
    const offset = decodeCursor(args.cursor);
    if (offset === null) throw new ToolError("cursor is not valid; start again without one");
    const filters = toSearchFilters(args);
    const query = args.query?.trim() ?? "";
    let ordered = query ? rankedByQuery(ctx.registry, query, filters, ctx.now) : browseOrder(ctx.registry.cards, filters, ctx.now);
    if (args.open_to_community_college) ordered = ordered.filter((card) => openToCommunityCollege(card, ctx.now));
    const { page, nextCursor } = paginate(ordered, offset, args.limit ?? MCP_CONFIG.defaultResults, MCP_CONFIG.maxPaginationDepth);
    const citation = { origin: ctx.origin, release: ctx.registry.release };
    return {
      output: {
        programs: page.map((card) => toProgramSummary(card, citation, ctx.now)),
        nextCursor,
        release: ctx.registry.release,
        containsSample: ctx.registry.containsSample,
      },
      resultCount: page.length,
      programIds: page.filter((c) => !c.flags.sensitiveAudience).map((c) => c.programId),
    };
  },
};
