# server/db

D1 schema, migrations, repositories and sample seed for Novus.

| Path | What it is |
|---|---|
| `schema.ts` | Drizzle `sqlite-core` schema for D1 `novus-main` (registry, students, notifications, advisor pilot kit, outcomes, ops, Better Auth tables) |
| `events-schema.ts` | Schema for D1 `novus-events` (analytics, day counters, LLM metering, email ledger) |
| `columns.ts` | Column kit: UUIDv7 keys, public ids, epoch-ms instants, JSON columns, CHECK builders |
| `guards.ts` | Triggers and expression indexes (append-only audit, immutable rule sets, audience consent guards, host policy, workspace approval) |
| `client.ts` | `getDb(env.DB)` and `getEventsDb(env.EVENTS_DB)` |
| `repos/` | The only code that queries D1. Plain functions that take the Drizzle client first |
| `seed/` | SAMPLE data (28 invented programs) and the SQL generators for seeds and lookup rows |
| `testing/` | Test-only D1 shim over Node's built-in `node:sqlite`, plus fixtures |
| `migrations/`, `migrations-events/` | Generated SQL, applied with `wrangler d1 migrations apply` |

## Rules the schema enforces

- **No SensitiveAnswers anywhere.** No table or column can hold citizenship or immigration status, Pell or income, first-generation, disability, race or ethnicity, gender, sexual orientation, veteran, foster care or similar answers. `schema.test.ts` checks every column of the student-owned and events tables against the shared sensitive-key stems. `programs.sensitive_audience` and `programs.identity_audience` describe programs, never people.
- **Audience guards.** A row that links a person to a status-, health- or identity-defined program (`tracker_items`, `subscriptions`, `alerts`, `requirement_progress`, `outcomes`, `roadmap_items`) is refused by trigger unless a live consent covers it. Outcomes and roadmap actions on sensitive-audience programs are always refused. Repositories report this as `consent_required`.
- **No score columns.** No column stores readiness, match or a composite number about a student.
- **No cascading foreign keys.** D1 table rebuilds would cascade-delete children, so repositories delete children explicitly (for example `students.purgeUser`).
- **History is kept.** `registry_audit` is append-only. Verified rule sets are immutable (they can only be superseded). Deadlines and cycles are withdrawn or closed, never deleted. Evidence quotes are never rewritten.
- **Concurrency.** A publish batch starts with `versionGuard(...)`. If the version is stale, the guard insert fails and the whole batch rolls back, with no audit rows or ChangeEvents written. A repeated guard key means the change was already applied.
- **D1 limits.** Repositories bind an id list as one JSON parameter (`jsonIds`) and chunk multi-row inserts with `rowsPerInsert`, so no statement passes D1's 100-parameter limit. One test binds 101 ids.

## Commands

```sh
# Regenerate migrations after editing schema.ts (never edit an applied migration)
npx drizzle-kit generate --name <change>
npx drizzle-kit generate --config server/db/drizzle.events.config.ts --name <change>

# If a new migration rebuilds a guarded table, append the guards again:
npx tsx server/db/seed/cli.ts guards   # paste into a --custom migration

# Lookup rows (generated from shared/taxonomy) and guards are committed migrations;
# tests fail if they drift from lookups.ts / guards.ts.

# Local D1
npm run db:migrate:local
npm run db:migrate:events:local                # novus-events (analytics, AI ledger, client_error_daily)
npm run db:seed:local -- --migrate            # migrate, then insert the sample seed
npm run db:seed:local -- --reset --today 2026-11-11
npm run db:seed:local -- --dry-run            # only write .wrangler/novus-seed/sample-seed.sql

# Tests
npx vitest run server/db
```

`infra/wrangler/wrangler.toml` must point the bindings at these folders: `migrations_dir = "../../server/db/migrations"` for `DB`, and `"../../server/db/migrations-events"` for `EVENTS_DB`.

## Better Auth

Use `drizzleAdapter(getDb(env.DB), { provider: "sqlite", usePlural: true, schema: authSchema })`. The tables are `users`, `sessions`, `accounts`, `verifications` and `rate_limits`. The JS property names match Better Auth's field names. `users.public_id` gets its value from Drizzle's `$defaultFn`, so Better Auth does not need to set it. For `advanced.database.generateId`, pass `() => uuidv7()` from `columns.ts`.

## Sample data

`seed/sample-data.ts` holds 28 invented programs. Together they cover all 31 in-scope opportunity types. The data also includes:

- cycles in the open, expected and closed states
- every deadline shape: exact, date-only, month-only, rolling, predicted window, applicant-local and campus
- requirements
- JsonLogic rule sets, including rules that read SensitiveAnswers. Those rules are marked `sensitive`, so only the browser evaluates them.

Every name says "Sample" or "Example", and every URL is on example.org. Each row is stored with `is_sample = 1`, and each rule set with `created_via = 'sample'`. Dates are relative to `--today`. None of this data describes a real program.

## Tests

Repositories run against real SQLite with the committed migrations. `testing/sqlite-d1.ts` adapts Node 24's built-in `node:sqlite` to the D1 API, so better-sqlite3 is not needed. The adapter matches D1 in these ways:

- foreign keys are always on
- `batch()` runs as one transaction
- booleans are stored as 0/1
- results come back as `{ results, meta }`

These parts still need the Workers pool (`*.worker.test.ts` with `@cloudflare/vitest-pool-workers`):

- D1's 100-parameter and 100 KB statement limits
- D1's error message format (`D1_ERROR: ...`). The `isStaleVersion` and `isConsentRequired` regexes match on the SQLite text inside it.
- read replicas and sessions
- the rollback of a stale publish on real D1

The migrations and the seed were also checked once by hand against local D1 through wrangler.
