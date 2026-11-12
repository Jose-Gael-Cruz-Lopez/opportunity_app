/**
 * MCP server constants. Limits follow plan 8.12; values marked "judgment" are tuned on logs.
 */
export const MCP_CONFIG = {
  serverName: "novus",
  serverTitle: "Novus opportunity registry",
  serverVersion: "1.0.0",
  /** The flag that turns the server on; off answers 404 (turning it off is the rollback). */
  flagKey: "mcp.enabled",
  /** How long an isolate trusts a flag read before asking D1 again (judgment). */
  flagTtlMs: 30_000,
  /** No tool returns more than this many items per call. */
  maxResults: 25,
  defaultResults: 10,
  /** A paginated query stops here, so no tool can list the whole registry. */
  maxPaginationDepth: 200,
  maxQueryChars: 200,
  maxEligibilityPrograms: 10,
  withinDays: { min: 1, max: 120, default: 30 },
  /** One JSON-RPC message per POST; bodies above this are refused before parsing (judgment). */
  maxBodyBytes: 64 * 1024,
  /** Pending s09's license decision (D12 proposes CC BY 4.0 for facts). */
  dataLicense: "CC-BY-4.0",
  termsPath: "/methods#mcp-terms",
  methodsPath: "/methods",
  programPath: (slug: string) => `/programs/${encodeURIComponent(slug)}`,
  /** Excerpts on public surfaces are capped at this many words. */
  maxExcerptWords: 25,
} as const;

/** Text every check_eligibility response carries (plan 8.12, D10). */
export const ELIGIBILITY_NOTICE =
  "Novus does not store or log the profile values sent to this tool. Eligibility is checked only against non-sensitive " +
  "criteria; citizenship, immigration, Pell, first-generation and identity criteria come back as self_check with the " +
  "official rule text. The program's official page governs.";

/** Refusal text when a request carries sensitive or unknown profile keys. */
export const SENSITIVE_REFUSAL =
  "Novus does not accept that information. Do not send citizenship, immigration, income, Pell, disability, race or " +
  "ethnicity, gender, sexual orientation, first-generation, veteran or foster-care status; criteria on those come back " +
  "as self_check with the official rule text so the student can decide privately.";

export const SERVER_INSTRUCTIONS =
  "Novus is a verified registry of student opportunities (internships, fellowships, research, apprenticeships, " +
  "scholarships, insight weeks and more) for first- and second-year students. Every tool is read-only and returns " +
  "published records with a citation: the official URL, when and by whom the record was last verified, and the Novus " +
  "page. Quote dates with their citation and say that the official page governs. Records marked isSample are sample " +
  "data and describe no real program. Facts are licensed under " +
  MCP_CONFIG.dataLicense +
  "; the MCP terms are on the Novus methods page.";
