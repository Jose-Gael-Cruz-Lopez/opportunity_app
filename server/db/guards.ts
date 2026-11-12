/**
 * Guards: every trigger, and every index Drizzle cannot declare (expression indexes), in one
 * idempotent SQL text (data model 3.2, rule 3). A rebuild drops a table's triggers silently, so
 * this text is re-applied after any migration that rebuilds a guarded table; `guards.test.ts`
 * checks the committed guards migration still equals `renderGuardsSql()`.
 *
 * Statements are separated by drizzle's `--> statement-breakpoint` marker because trigger bodies
 * contain semicolons.
 */

export const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

function trigger(name: string, timing: string, when: string | null, message: string): string[] {
  const whenClause = when ? `\nWHEN ${when}` : "";
  return [
    `DROP TRIGGER IF EXISTS ${name};`,
    `CREATE TRIGGER ${name} ${timing}${whenClause}\nBEGIN SELECT RAISE(ABORT, '${message}'); END;`,
  ];
}

// ---------------------------------------------------------------------------------------------
// Expression and partial indexes
// ---------------------------------------------------------------------------------------------

const EXPRESSION_INDEXES = [
  // Prevents duplicate live slots; NULL institution ids would otherwise be distinct (3.5).
  "CREATE UNIQUE INDEX IF NOT EXISTS deadlines_slot_uq ON deadlines (program_cycle_id, kind, scope, coalesce(institution_id, ''), round_label) WHERE withdrawn_at IS NULL;",
  // One live consent decision per subject, kind and scope (3.12).
  "CREATE UNIQUE INDEX IF NOT EXISTS consents_live_uq ON consents (coalesce(user_id, contact_id), kind, coalesce(scope_id, '')) WHERE revoked_at IS NULL;",
  "CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_uq ON subscriptions (coalesce(user_id, contact_id), kind, coalesce(program_cycle_id, ''));",
  "CREATE UNIQUE INDEX IF NOT EXISTS user_roles_live_uq ON user_roles (user_id, role, coalesce(workspace_id, ''), coalesce(organization_id, '')) WHERE revoked_at IS NULL;",
];

// ---------------------------------------------------------------------------------------------
// Append-only and immutability guards
// ---------------------------------------------------------------------------------------------

function auditGuards(): string[] {
  const accessAuditChanged = [
    "id",
    "created_at",
    "actor_kind",
    "actor_ref",
    "action",
    "purpose",
    "fields",
    "request_id",
  ]
    .map((c) => `NEW.${c} IS NOT OLD.${c}`)
    .join(" OR ");
  return [
    ...trigger("registry_audit_no_update", "BEFORE UPDATE ON registry_audit", null, "registry_audit is append-only"),
    ...trigger("registry_audit_no_delete", "BEFORE DELETE ON registry_audit", null, "registry_audit is append-only"),
    // Only a deletion tombstone may replace the subject key; nothing else changes.
    ...trigger(
      "access_audit_no_update",
      "BEFORE UPDATE ON access_audit",
      `NEW.subject_key NOT LIKE 'tombstone:%' OR ${accessAuditChanged}`,
      "access_audit is append-only",
    ),
    // Rows may be deleted only after 24 months.
    ...trigger(
      "access_audit_no_delete",
      "BEFORE DELETE ON access_audit",
      "OLD.created_at > (CAST(strftime('%s', 'now') AS INTEGER) - 730 * 86400) * 1000",
      "access_audit rows are kept for 24 months",
    ),
  ];
}

function ruleSetGuards(): string[] {
  const frozen = [
    "body",
    "hash",
    "program_cycle_id",
    "version",
    "format",
    "template_key",
    "verified_by",
    "verified_at",
    "coverage_complete",
    "launch_coverage_complete",
    "diff_from_previous",
    "created_via",
    "from_cycle_key",
  ]
    .map((c) => `NEW.${c} IS NOT OLD.${c}`)
    .join(" OR ");
  return [
    ...trigger(
      "ers_immutable",
      "BEFORE UPDATE ON eligibility_rule_sets",
      `OLD.state <> 'draft' AND (${frozen} OR NOT (NEW.state = OLD.state OR (OLD.state = 'verified' AND NEW.state = 'superseded')))`,
      "verified rule sets are immutable",
    ),
    // Sample rule sets stay deletable so a local reseed can clear them.
    ...trigger(
      "ers_no_delete",
      "BEFORE DELETE ON eligibility_rule_sets",
      "OLD.state <> 'draft' AND OLD.created_via <> 'sample'",
      "only drafts may be deleted",
    ),
  ];
}

const NOT_SAMPLE_CYCLE = (cycleExpr: string) =>
  `NOT EXISTS (SELECT 1 FROM program_cycles c JOIN programs p ON p.id = c.program_id WHERE c.id = ${cycleExpr} AND p.is_sample = 1)`;

function registryDeleteGuards(): string[] {
  // Withdrawn Deadlines and ended cycles stay, so calendars can emit CANCELLED and history keeps provenance.
  return [
    ...trigger("deadlines_no_delete", "BEFORE DELETE ON deadlines", NOT_SAMPLE_CYCLE("OLD.program_cycle_id"), "withdraw deadlines instead of deleting them"),
    ...trigger("cycles_no_delete", "BEFORE DELETE ON program_cycles", NOT_SAMPLE_CYCLE("OLD.id"), "program cycles are never deleted"),
  ];
}

function evidenceGuards(): string[] {
  const changed = [
    "id",
    "entity_type",
    "entity_id",
    "field_path",
    "basis",
    "snapshot_id",
    "attestation_task_id",
    "url",
    "quote",
    "locator",
    "match",
    "verified_by",
    "created_at",
  ]
    .map((c) => `NEW.${c} IS NOT OLD.${c}`)
    .join(" OR ");
  // The only allowed update sets superseded_at once.
  return [
    ...trigger(
      "field_evidence_append_only",
      "BEFORE UPDATE ON field_evidence",
      `OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL OR ${changed}`,
      "field_evidence quotes are never rewritten",
    ),
  ];
}

function sourceGuards(): string[] {
  const forbidden =
    "NEW.next_check_at IS NOT NULL AND COALESCE((SELECT policy FROM source_hosts WHERE host = NEW.host), 'never') NOT IN ('allowed', 'api_only')";
  return [
    ...trigger("sources_cadence_ins", "BEFORE INSERT ON sources", forbidden, "host policy forbids automated fetching"),
    ...trigger("sources_cadence_upd", "BEFORE UPDATE OF next_check_at, host ON sources", forbidden, "host policy forbids automated fetching"),
  ];
}

function programGuards(): string[] {
  // A trigger rather than a CHECK, so lifting the rule later needs no rebuild of `programs`.
  const when = "instr(NEW.identity_audience, '\"health\"') > 0 AND NEW.sensitive_audience = 0";
  return [
    ...trigger("programs_health_audience_ins", "BEFORE INSERT ON programs", when, "health audience requires sensitive_audience"),
    ...trigger("programs_health_audience_upd", "BEFORE UPDATE OF identity_audience, sensitive_audience ON programs", when, "health audience requires sensitive_audience"),
  ];
}

function workspaceGuards(): string[] {
  const when =
    "NEW.workspace_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM advisor_workspaces w WHERE w.id = NEW.workspace_id AND w.approved_at IS NOT NULL AND w.deleted_at IS NULL)";
  return [
    ...trigger("program_lists_workspace_ins", "BEFORE INSERT ON program_lists", when, "workspace is not approved"),
    ...trigger("program_lists_workspace_upd", "BEFORE UPDATE OF workspace_id ON program_lists", when, "workspace is not approved"),
  ];
}

// ---------------------------------------------------------------------------------------------
// Audience guards (3.12): a row linking a person to a status-, health- or identity-defined
// program exists only under a live consent. Outcomes and roadmap actions on sensitive-audience
// programs are refused whatever the consents.
// ---------------------------------------------------------------------------------------------

interface AudienceTarget {
  table: string;
  /** Column holding the program cycle (or program, when `programColumn` is set). */
  cycleColumn?: string;
  programColumn?: string;
  /** SQL matching a consent row `k` to the new row's subject. */
  subject: string;
  /** Columns whose update re-checks the guard. */
  updateOf: string[];
  /** Refuse sensitive-audience programs even with consent. */
  strict: boolean;
}

const USER_SUBJECT = "k.user_id = NEW.user_id";
const USER_OR_CONTACT_SUBJECT = "((NEW.user_id IS NOT NULL AND k.user_id = NEW.user_id) OR (NEW.contact_id IS NOT NULL AND k.contact_id = NEW.contact_id))";

export const AUDIENCE_TARGETS: readonly AudienceTarget[] = [
  { table: "tracker_items", cycleColumn: "program_cycle_id", subject: USER_SUBJECT, updateOf: ["program_cycle_id", "user_id"], strict: false },
  { table: "subscriptions", cycleColumn: "program_cycle_id", subject: USER_OR_CONTACT_SUBJECT, updateOf: ["program_cycle_id", "user_id", "contact_id"], strict: false },
  { table: "alerts", cycleColumn: "program_cycle_id", subject: USER_OR_CONTACT_SUBJECT, updateOf: ["program_cycle_id", "user_id", "contact_id"], strict: false },
  { table: "requirement_progress", cycleColumn: "program_cycle_id", subject: USER_SUBJECT, updateOf: ["program_cycle_id", "user_id"], strict: false },
  { table: "outcomes", cycleColumn: "program_cycle_id", subject: USER_SUBJECT, updateOf: ["program_cycle_id", "user_id"], strict: true },
  { table: "roadmap_items", programColumn: "program_id", subject: USER_SUBJECT, updateOf: ["program_id", "user_id"], strict: true },
];

export function audienceCondition(target: AudienceTarget): string {
  const sensitive = target.strict
    ? "p.sensitive_audience = 1"
    : `(p.sensitive_audience = 1 AND NOT EXISTS (SELECT 1 FROM consents k WHERE ${target.subject} AND k.kind = 'sensitive_tracking' AND k.scope_id = p.id AND k.revoked_at IS NULL))`;
  const identity = `(json_array_length(p.identity_audience) > 0 AND NOT EXISTS (SELECT 1 FROM consents k WHERE ${target.subject} AND k.kind = 'identity_tracking' AND k.revoked_at IS NULL))`;
  const audience = `instr(p.identity_audience, '"health"') > 0 OR ${sensitive} OR ${identity}`;
  if (target.programColumn) {
    const col = `NEW.${target.programColumn}`;
    return `${col} IS NOT NULL AND EXISTS (SELECT 1 FROM programs p WHERE p.id = ${col} AND (${audience}))`;
  }
  const col = `NEW.${target.cycleColumn}`;
  return `${col} IS NOT NULL AND EXISTS (SELECT 1 FROM program_cycles c JOIN programs p ON p.id = c.program_id WHERE c.id = ${col} AND (${audience}))`;
}

function audienceGuards(): string[] {
  return AUDIENCE_TARGETS.flatMap((t) => {
    const when = audienceCondition(t);
    return [
      ...trigger(`${t.table}_audience_ins`, `BEFORE INSERT ON ${t.table}`, when, "audience consent required"),
      ...trigger(`${t.table}_audience_upd`, `BEFORE UPDATE OF ${t.updateOf.join(", ")} ON ${t.table}`, when, "audience consent required"),
    ];
  });
}

/** Every guard statement in apply order. */
export function guardStatements(): string[] {
  return [
    ...EXPRESSION_INDEXES,
    ...auditGuards(),
    ...ruleSetGuards(),
    ...registryDeleteGuards(),
    ...evidenceGuards(),
    ...sourceGuards(),
    ...programGuards(),
    ...workspaceGuards(),
    ...audienceGuards(),
  ];
}

/** Trigger names the database must hold after migrations (the golden list). */
export function guardTriggerNames(): string[] {
  return guardStatements()
    .map((s) => /^CREATE TRIGGER (\w+)/.exec(s)?.[1])
    .filter((n): n is string => Boolean(n));
}

export function renderGuardsSql(): string {
  const header = "-- Guards: generated by server/db/guards.ts (renderGuardsSql). Do not edit by hand.\n";
  return header + guardStatements().join(`\n${STATEMENT_BREAKPOINT}\n`) + "\n";
}
