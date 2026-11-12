# `server/api/v1/events`: first-party analytics and client error reports

Two public, unauthenticated write routes. Both accept `text/plain` bodies (what
`navigator.sendBeacon` sends) as well as JSON, so they parse and check the body themselves:
the global `sensitive-guard` only reads JSON and form bodies.

| Route | Route map | Body | Answers |
| --- | --- | --- | --- |
| `POST /api/v1/events` | `postEvents` | `AnalyticsBatchSchema` (shared/contracts/api.ts), at most 20 events and 16 KB | `200 {accepted}`; `204` under GPC, for bots and for signed-in accounts with analytics off or in minor mode; `400`, `413`, `429` |
| `POST /api/v1/error-reports` | `clientErrors` | `ClientErrorBatchSchema` (shared/contracts/api.ts), at most 5 reports | `202 {received}`; `204` for bots; `400`, `413`, `429` |

`POST /api/v1/error-reports` is for **client crashes**. It is not the program-page "Report an
error" form, which is `reportError` at `/api/v1/programs/:slug/error-reports` (still unbuilt).

Full design and the privacy argument: [docs/telemetry.md](../../../../docs/telemetry.md).

## Files

| File | What it holds |
| --- | --- |
| `allowlist.ts` | Per-event property allowlist (`EVENT_PROPS`: ids, closed enums, bounded ints, booleans; no free text), `checkProps`, and the closed list of route templates (`routeTemplate`). |
| `sampling.ts` | Session-level sampling by FNV-1a bucket and per-event rates (`SAMPLE_RATES`), mirrored in `client/src/lib/telemetry/sampling.ts`. |
| `client-errors.ts` | The client error report schema (class, route, release, browser family, first-party file and line; no message, stack, URL or id) and the counter key. |
| `store.ts` | D1 ports: program audiences, the signed-in analytics check, inserts into `analytics_events`, `program_daily_counts` increments, `client_error_daily` upserts. |
| `index.ts` | The routes (`createEventsRoutes`, `eventsRoutes`). |
| `events.test.ts` | 32 tests against real SQLite with the committed migrations and the sample seed. |

## What is stored

- `analytics_events`: name, the session-scoped id (in `device_id`), the time to the second, the
  route template, the allowlisted props (plus `sampleRate` when below 1). `user_hmac` and
  `hmac_key_id` are always null: this route never keys an event to an account.
- `program_daily_counts`: one increment per event about a sensitive- or identity-audience
  program (resolved from `programId` or `cycleId` against `programs`), never a row. An event
  naming an unknown program, or a cycle of another program, is dropped.
- `client_error_daily` (`novus-events` migration 0002): day counters by crash site, kept 90 days.
  Where the migration is not applied yet, each report is logged as a structured `client_error`
  line instead.

Alerts (log lines for the on-call founder): `events.sensitive_key_rejected`,
`events.restricted_in_batch`. Drops are counted in one `events.dropped` line per batch.

## Registration (done in the wave 4 integration pass)

- `server/app.ts` mounts `eventsRoutes` in `registryRoutes`. Route map ids: `postEvents` and
  `clientErrors` (`POST /api/v1/error-reports`, auth `public`, body `ClientErrorBatchSchema`, which
  now lives in `shared/contracts/api.ts`; `client-errors.ts` re-exports it). `wiring.test.ts`
  checks the router against the map.
- Migration `server/db/migrations-events/0002_client_error_daily.sql` (Drizzle table
  `clientErrorDaily` in `server/db/events-schema.ts`). `sweep` deletes rows older than 90 days
  (`sweepClientErrorDaily` in `server/db/repos/events.ts`). Apply it with
  `npm run db:migrate:events:local` locally and `wrangler d1 migrations apply` on staging and
  production; until then the route keeps logging one `client_error` line per report.
- Limits (`LIMITS` in `index.ts`). The session id is client-chosen, so the per-session limits
  only pace honest clients. What holds against a deliberate client is keyed by network
  (`networkOf()`: IPv4 /24, IPv6 /64): an in-isolate per-minute window, the `RATE_LIMIT_PUBLIC`
  binding under `events:<network>` / `errors:<network>`, and a durable daily window in
  novus-main `rate_limits` (50,000 event batches and 500 crash-report batches per network per
  day, keyed by an HMAC of the network under a `BETTER_AUTH_SECRET` subkey; skipped without the
  secret). Crash reports also have one global daily cap (10,000 batches), so counter rows stay
  bounded whatever strings clients send. Sampling is still by the client-chosen session id, so
  a deliberate client can stay inside the `search` and `filter_change` samples; the caps bound
  how much that can add.
- Crash reports become rows only from the deployed build: set the Worker var `RELEASE_ID` to the
  `VITE_RELEASE` the client was built with (registration for the deploy workflow and
  `wrangler.toml`). Unset, any well-formed release is accepted. Island reports must carry an
  island's own release and file; SPA files must be null or named like a Vite hashed bundle.
  Checking the file against the build's asset manifest is not built.
