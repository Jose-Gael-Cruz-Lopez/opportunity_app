import { z } from "zod";
import type { DeadlineView, ProgramCard } from "@shared/contracts";
import { matchesFilters } from "@shared/matching";
import { DeadlineKindSchema } from "@shared/taxonomy";
import { MS_PER_DAY } from "@shared/time";
import { MCP_CONFIG } from "../config";
import { CursorSchema, McpDeadlineSchema, decodeCursor, deadlineSortMs, paginate, publicDeadlines, toMcpDeadline } from "../shapes";
import { catalogueFilterShape, limitSchema, toSearchFilters } from "./filters";
import { ToolError, type ToolDef } from "./types";

const { min, max } = MCP_CONFIG.withinDays;

const ListDeadlinesInput = z
  .object({
    within_days: z.number().int().min(min).max(max).optional().describe(`Days ahead to list, ${min}-${max} (default ${MCP_CONFIG.withinDays.default}).`),
    program: z.string().min(1).max(120).optional().describe("Limit to one program (slug or id)."),
    kinds: z.array(DeadlineKindSchema).max(10).optional().describe("Deadline kinds, for example application or nomination."),
    ...catalogueFilterShape,
    limit: limitSchema,
    cursor: CursorSchema.optional().describe("nextCursor from a previous call."),
  })
  .strict();

const ListedDeadlineSchema = McpDeadlineSchema.extend({
  programSlug: z.string(),
  programName: z.string(),
  organizationName: z.string(),
  cycleKey: z.string(),
  isSample: z.boolean(),
}).strict();

const ListDeadlinesOutput = z
  .object({
    deadlines: z.array(ListedDeadlineSchema),
    window: z.object({ from: z.string(), to: z.string() }).strict(),
    nextCursor: z.string().nullable(),
    release: z.number().int(),
    containsSample: z.boolean(),
    note: z.string(),
  })
  .strict();

interface Row {
  readonly card: ProgramCard;
  readonly deadline: DeadlineView;
  readonly at: number;
}

/**
 * National deadlines due between now and now + within_days, in time order. Applicant-local
 * deadlines are placed at the latest US zone (shared/time computeSortAt) so a public list never
 * shows one as passed while it is still open somewhere in the US. Rolling and unannounced rows
 * have no date and are left out.
 */
function upcomingRows(cards: readonly ProgramCard[], from: number, to: number, kinds: readonly string[] | undefined): Row[] {
  const rows: Row[] = [];
  for (const card of cards) {
    for (const deadline of publicDeadlines(card)) {
      if (kinds?.length && !kinds.includes(deadline.kind)) continue;
      const at = deadlineSortMs(deadline);
      if (at === null || at < from || at > to) continue;
      rows.push({ card, deadline, at });
    }
  }
  rows.sort((a, b) => a.at - b.at || a.card.name.localeCompare(b.card.name) || a.deadline.id.localeCompare(b.deadline.id));
  return rows;
}

export const listDeadlinesTool: ToolDef<typeof ListDeadlinesInput, typeof ListDeadlinesOutput> = {
  name: "list_deadlines",
  title: "List upcoming deadlines",
  description:
    "Lists published national deadlines due in the next 1-120 days (default 30), in time order, optionally for one " +
    "program or filtered by type, class year, field and deadline kind. Each deadline carries its kind, precision, " +
    "time-zone mode, local date and time, ISO instant (null when the deadline is in the applicant's local time) and a " +
    "citation. Campus deadlines are not listed.",
  input: ListDeadlinesInput,
  output: ListDeadlinesOutput,
  async run(args, ctx) {
    const offset = decodeCursor(args.cursor);
    if (offset === null) throw new ToolError("cursor is not valid; start again without one");
    const days = args.within_days ?? MCP_CONFIG.withinDays.default;
    const to = ctx.now + days * MS_PER_DAY;
    const filters = toSearchFilters(args);
    let cards = ctx.registry.cards.filter((c) => matchesFilters(c, filters, { now: ctx.now }));
    if (args.program) {
      const one = ctx.registry.findCard(args.program);
      if (!one) throw new ToolError("No published program matches that slug or id.", "not_found");
      cards = cards.filter((c) => c.programCycleId === one.programCycleId);
    }
    const rows = upcomingRows(cards, ctx.now, to, args.kinds);
    const { page, nextCursor } = paginate(rows, offset, args.limit ?? MCP_CONFIG.defaultResults, MCP_CONFIG.maxPaginationDepth);
    const citation = { origin: ctx.origin, release: ctx.registry.release };
    return {
      output: {
        deadlines: page.map(({ card, deadline }) => ({
          ...toMcpDeadline(card, deadline, citation),
          programSlug: card.slug,
          programName: card.name,
          organizationName: card.organizationName,
          cycleKey: card.cycleKey,
          isSample: card.isSample,
        })),
        window: { from: new Date(ctx.now).toISOString(), to: new Date(to).toISOString() },
        nextCursor,
        release: ctx.registry.release,
        containsSample: ctx.registry.containsSample,
        note: "Campus deadlines for nominated programs are earlier and vary by school; the official page governs.",
      },
      resultCount: page.length,
      programIds: [...new Set(page.filter((r) => !r.card.flags.sensitiveAudience).map((r) => r.card.programId))],
    };
  },
};
