# Runbook: common incidents

Each entry: how it shows up, what to do, how to confirm. Commands assume `CFG="--config infra/wrangler/wrangler.toml --env production"`.

## Bad deploy

- **Shows up as:** error rate up after a deploy, failing smoke checks.
- **Do:** `npx wrangler deployments list $CFG`, then `npx wrangler rollback <version-id> $CFG --message "<reason>"`. Prefer a token scoped to Workers Scripts: Edit over `wrangler login`.
- **Confirm:** `npx wrangler tail $CFG` shows clean requests. Migrations stay applied; they are expand-only, so the old version works.

## Cron Triggers late, skipped or doubled

- **Shows up as:** `heartbeats.last_tick_started_at` older than 10 minutes, jobs waiting.
- **Do:** nothing first: Modal's `drain` calls `POST /internal/v1/tick:catch-up`, which runs the tick only when the last one is stale. Idempotency keys absorb doubled runs. If Modal is also down, run the catch-up with the break-glass key (below).
- **Confirm:** the heartbeat moves and the oldest pending job per kind falls under its `max_lateness`.

## Modal down

- **Shows up as:** Modal heartbeat 30 minutes stale while jobs wait.
- **Do:** enable the `breakglass` key through the two-admin `breakglass.enabled` flag (24 hours), then from a laptop: `python -m novus_pipeline drain`. It can lease fetch kinds and call `tick:catch-up` only.
- **Confirm:** fetch jobs complete; disable the flag and rotate the key afterwards; log the use in the postmortem.

## Gemini unavailable or over budget

- **Shows up as:** AI responses with `meta.status: "unavailable"`.
- **Do:** nothing urgent. Every AI feature has a deterministic fallback, and pipeline LLM jobs defer without using attempts. To stop all calls at once, set `AI_DISABLED = "true"` in the environment's `[vars]` and deploy.
- **Confirm:** readiness pages still show eligibility, requirements, band and next actions.

## A secret leaked

- **Do:** rotate it at the provider first (Google AI Studio, Cloudflare, Sentry), then `npx wrangler secret put <NAME> $CFG`. For `INTERNAL_HMAC_KEYS`, add the new key id, move Modal to it, then remove the old id. Google blocks keys reported as leaked, so expect a 403 until rotation.
- **Confirm:** `npx tsx infra/scripts/ci-checks.ts secrets` passes, and the old value no longer works. Removing a secret from git history does not un-leak it; rotation does.

## D1 errors

- **Shows up as:** 5xx on pages, `D1_ERROR` in logs.
- **Do:** pages serve last-good copies with an "as of" banner; writes return 503 with `Retry-After`. Check the Cloudflare status page. If data is wrong rather than unavailable, follow [restore.md](restore.md).
