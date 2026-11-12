import { checkEligibilityTool } from "./check-eligibility";
import { getProgramTool } from "./get-program";
import { listDeadlinesTool } from "./list-deadlines";
import { searchProgramsTool } from "./search-programs";
import type { AnyToolDef } from "./types";

/** Fixed listing order (plan 8.12): assistants see the same tools in the same order every time. */
export const MCP_TOOLS: readonly AnyToolDef[] = [searchProgramsTool, getProgramTool, listDeadlinesTool, checkEligibilityTool];

export { checkEligibilityTool, getProgramTool, listDeadlinesTool, searchProgramsTool };
export { READ_ONLY_ANNOTATIONS, ToolError, type AnyToolDef, type ToolContext, type ToolDef, type ToolRun } from "./types";
