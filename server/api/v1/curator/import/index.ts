import { curatorDeps } from "../index";
import { createCuratorImportRoutes } from "./routes";

/**
 * server/api/v1/curator/import: the Curator candidate import (plan 04 4.4 and 4.9, plan 01
 * F-16). Researchers' candidate files (JSON or CSV) become unverified draft Programs with
 * ReviewTasks; nothing is published automatically. Mount under /api/v1 next to the Curator
 * router:
 *
 *   app.route("/api/v1", curatorImportRoutes)
 *
 * The local CLI is infra/scripts/import-candidates.ts. See docs/registry-import.md.
 */

export { createCuratorImportRoutes, IMPORT_PATH, MAX_ROUTE_ROWS, ROUTE_MAX_BYTES } from "./routes";
export { runImport, type ImportReport, type ImportResult } from "./service";
export { parseCandidateFile, MAX_FILE_BYTES, MAX_ROWS, type ParsedRow, type CandidateFormat } from "./parse";
export { planImport, summarize, type ImportPlan, type RowOutcome, type ImportSummary } from "./plan";
export { CandidateSchema, type Candidate } from "./schema";
export { IMPORT_SYSTEM } from "./existing";

export const curatorImportRoutes = createCuratorImportRoutes(curatorDeps);
