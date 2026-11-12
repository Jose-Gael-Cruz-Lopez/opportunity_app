/**
 * Feature flags (plan 02 2.3.12). Values live in the D1 `flags` table behind a 60-second
 * in-isolate cache; the defaults below are compiled in and used whenever a row is missing or D1
 * is unreachable, so each default is the safe choice for a degraded platform.
 *
 * Every flag is a boolean `enabled`. Kill switches default on (the feature runs) and are turned
 * off in an incident; switches for unfinished or risky features default off.
 */
export interface FlagDefinition {
  readonly default: boolean;
  readonly kind: "kill_switch" | "switch";
  readonly description: string;
}

export const FLAGS = {
  "llm.all": { default: true, kind: "kill_switch", description: "Every model call; off means deterministic fallbacks only" },
  "llm.explain": { default: true, kind: "kill_switch", description: "Readiness explanations" },
  "llm.statement_feedback": { default: true, kind: "kill_switch", description: "Statement feedback" },
  "llm.ask": { default: true, kind: "kill_switch", description: "Ask Novus" },
  "llm.resume_extract": { default: true, kind: "kill_switch", description: "Onboarding resume extraction" },
  "alerts.fanout": { default: true, kind: "kill_switch", description: "ChangeEvent fan-out to Alerts" },
  "site.read_only": { default: false, kind: "switch", description: "Refuse writes on /api/v1 with 503" },
  "mcp.enabled": { default: false, kind: "switch", description: "Serve /mcp (Phase 2)" },
  "uploads.enabled": { default: false, kind: "switch", description: "Student and Curator uploads" },
  "docintel.flyer_check": { default: false, kind: "switch", description: "Flyer checks through DocIntel (Phase 2)" },
  "pass.fake_door": { default: false, kind: "switch", description: "Pass fake-door experiment" },
  /** The plan's `email.provider` switch, as a boolean: on sends through the SES standby. */
  "email.use_ses": { default: false, kind: "switch", description: "Send email through Amazon SES instead of Email Sending" },
  /** Two admins, 24 hours; never on by default. */
  "breakglass.enabled": { default: false, kind: "switch", description: "Accept the break-glass internal key" },
} as const satisfies Record<string, FlagDefinition>;

export type FlagKey = keyof typeof FLAGS;
export type FlagValues = Readonly<Record<FlagKey, boolean>>;

export const FLAG_KEYS = Object.keys(FLAGS) as FlagKey[];

export function isFlagKey(key: string): key is FlagKey {
  return Object.prototype.hasOwnProperty.call(FLAGS, key);
}

export const FLAG_DEFAULTS: FlagValues = Object.freeze(
  Object.fromEntries(FLAG_KEYS.map((k) => [k, FLAGS[k].default])) as Record<FlagKey, boolean>,
);

/** How long an isolate trusts its copy of the flags table. */
export const FLAG_CACHE_TTL_MS = 60_000;

/**
 * Optional percentage rollouts live in the D1 `config` table under `rollout.<flag>` as a number
 * from 0 to 100 (kept out of the public repository with the other thresholds).
 */
export const ROLLOUT_CONFIG_PREFIX = "rollout.";
