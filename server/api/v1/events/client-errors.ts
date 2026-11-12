import type { ClientErrorReport } from "@shared/contracts/api";
import { routeTemplate } from "./allowlist";

/**
 * Client error reports (plan s02 2.3.12 "Client errors", S02-074): the shape of a crash, never
 * its content. A report carries the error class, the route template, the release, a browser
 * family and the first-party file and line. It has no message text, no stack, no URL, no query
 * string, no props or state, and no identifier at all (not even the session id): reports are
 * stored only as day counters, so nothing in them can be joined to a person.
 */

// The wire schema lives in shared/contracts/api.ts so the route map can name it (`clientErrors`).
export {
  BROWSER_FAMILIES,
  ClientErrorBatchSchema,
  ClientErrorReportSchema,
  ERROR_KINDS,
  ERROR_SURFACES,
  type ClientErrorBatch,
  type ClientErrorReport,
} from "@shared/contracts/api";

/** The island scripts' fixed release ids and files (server/pages/islands). */
export const ISLAND_RELEASES: Readonly<Record<string, string>> = { "remind-me.v1": "remind-me.js" };
/** Vite's hashed bundle names (`index-BX12abCd.js`, `console-z3rkXjr_.js`). */
const HASHED_BUNDLE = /^[A-Za-z0-9_.-]{1,64}-[A-Za-z0-9_-]{8}\.m?js$/;

/**
 * Whether a report may become a counter row. Island reports must carry an island's own release
 * and file. SPA and console reports must carry the deployed release when `RELEASE_ID` is set,
 * and a file that is null or named like a Vite hashed bundle, so client-chosen strings cannot
 * multiply rows. (Checking the file against the build's asset manifest needs the manifest at
 * runtime; BUILD_REPORT section 5.)
 */
export function acceptedErrorReport(report: ClientErrorReport, deployedRelease: string | undefined): boolean {
  if (report.surface === "island" || report.kind === "island") {
    const file = ISLAND_RELEASES[report.release];
    return file !== undefined && (report.file === null || report.file === file);
  }
  if (deployedRelease && report.release !== deployedRelease) return false;
  return report.file === null || HASHED_BUNDLE.test(report.file);
}

/** One counter row: the report with its route reduced to a template and nullables as "". */
export interface ClientErrorKey {
  readonly kind: string;
  readonly surface: string;
  readonly errorClass: string;
  readonly route: string;
  readonly release: string;
  readonly browser: string;
  readonly file: string;
  readonly line: number;
}

export function errorKey(report: ClientErrorReport): ClientErrorKey {
  return {
    kind: report.kind,
    surface: report.surface,
    errorClass: report.errorClass,
    route: routeTemplate(report.route),
    release: report.release,
    browser: report.browser,
    file: report.file ?? "",
    // The column is accepted for forward compatibility but not stored: file and line identify
    // the site in a minified bundle well enough, and a finer key multiplies rows.
    line: report.line ?? 0,
  };
}

/**
 * The `novus-events` table (server/db/migrations-events/0002_client_error_daily.sql, Drizzle
 * `clientErrorDaily`). Where that migration is not applied yet the route logs each report as a
 * structured `client_error` line instead (Workers Logs, 7 days).
 */
export const CLIENT_ERROR_TABLE = "client_error_daily";

export const UPSERT_CLIENT_ERROR_SQL =
  `INSERT INTO ${CLIENT_ERROR_TABLE} (day, kind, surface, error_class, route, release, browser, file, line, n) ` +
  `VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1) ` +
  `ON CONFLICT (day, kind, surface, error_class, route, release, browser, file, line) DO UPDATE SET n = n + 1`;
