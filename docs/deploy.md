# Deploying Novus

Two Cloudflare Workers, two environments:

| Worker | Config | Environments |
| --- | --- | --- |
| `novus-app` (`novus-app-staging`) | `infra/wrangler/wrangler.toml` | `--env staging`, `--env production` |
| `novus-backup` (routeless) | `infra/wrangler/backup.toml` | `--env production` |

Routine deploys run in **Cloudflare Workers Builds**: `main` builds to staging, the protected `release` branch builds to production. GitHub Actions never deploys and holds no secrets. The manual commands below are for first-time setup and emergencies.

## 1. One-time setup

### Sign in

```bash
npx wrangler login
npx wrangler whoami
```

`wrangler login` grants broad account scopes. Use it for setup from a trusted machine. For emergency rollback, prefer a Cloudflare API token limited to **Workers Scripts: Edit**, exported as `CLOUDFLARE_API_TOKEN` in that shell only.

### Create resources

```bash
# Production
npx wrangler d1 create novus-main
npx wrangler d1 create novus-events
npx wrangler r2 bucket create novus-store
npx wrangler r2 bucket create novus-backups

# Staging
npx wrangler d1 create novus-main-staging
npx wrangler d1 create novus-events-staging
npx wrangler r2 bucket create novus-store-staging
```

Each `d1 create` prints a `database_id`. Paste each into `infra/wrangler/wrangler.toml` in place of the matching `REPLACE_WITH_..._ID`, and the production ids into `BACKUP_DATABASES` in `infra/wrangler/backup.toml`. D1 ids and bucket names are not secrets, but keep production ids out of the staging block: `npx tsx infra/scripts/ci-checks.ts config` fails if one appears there.

Set `APP_ORIGIN` for each environment and uncomment its `routes` line with your domain. Production keeps `workers_dev = false` and `preview_urls = false`.

Before the first production deploy, this must print `ok`:

```bash
npx tsx infra/scripts/ci-checks.ts deploy-gate --env production
```

### Email

Onboard the sending domain in **Email Sending** (Cloudflare dashboard, Email). Set up SPF, DKIM and DMARC as the dashboard shows. The `EMAIL` binding sends from addresses on that domain.

### Secrets

Secrets are stored per Worker and per environment. Never put them in `[vars]`, code, the client bundle or this repository.

```bash
CFG="--config infra/wrangler/wrangler.toml"

npx wrangler secret put GEMINI_API_KEY      $CFG --env production
npx wrangler secret put BETTER_AUTH_SECRET  $CFG --env production   # openssl rand -base64 32
npx wrangler secret put INTERNAL_HMAC_KEYS  $CFG --env production   # {"fetch":"...","clock":"..."}
npx wrangler secret put SENTRY_DSN          $CFG --env production   # optional
npx wrangler secret put TURNSTILE_SECRET_KEY $CFG --env production  # sign-in, Remind me

# repeat with --env staging, using DIFFERENT values
npx wrangler secret list $CFG --env production
```

`GEMINI_API_KEY` must come from a Google AI Studio project with billing linked (paid tier). Free-tier prompts may be used for product improvement. Without the key, AI features degrade to their deterministic fallbacks. Set `AI_DISABLED = "true"` in `[vars]` to stop all model calls at once.

Rotating a secret means running `secret put` again; it takes effect on the next request.

### Workers Builds

Connect the GitHub repository in the dashboard (Workers, `novus-app`, Settings, Builds):

| Setting | Staging (`novus-app-staging`) | Production (`novus-app`) |
| --- | --- | --- |
| Branch | `main` | `release` |
| Build command | `npm ci && npm run build` | `npm ci && npm run build` |
| Deploy command | see below with `--env staging` | see below with `--env production` |
| Root directory | `/` | `/` |
| Preview builds | off | off |

Deploy command (migrations first, then code, so new code never meets an old schema):

```bash
npx tsx infra/scripts/ci-checks.ts deploy-gate --env production \
 && npx wrangler d1 migrations apply novus-main   --remote --config infra/wrangler/wrangler.toml --env production \
 && npx wrangler d1 migrations apply novus-events --remote --config infra/wrangler/wrangler.toml --env production \
 && npx wrangler deploy --config infra/wrangler/wrangler.toml --env production
```

For staging, replace `--env production` with `--env staging` and the database names with `novus-main-staging` and `novus-events-staging`. Set the Node version to 24 in the build settings. Never build forks.

Migrations must be expand-only (add tables and columns, never drop or rename in the same release) so the previous Worker version keeps working during a rollback.

## 2. Manual deploy

```bash
npm ci && npm run build
npx wrangler deploy --dry-run --config infra/wrangler/wrangler.toml --env staging   # validate
npx wrangler d1 migrations apply novus-main-staging --remote --config infra/wrangler/wrangler.toml --env staging
npx wrangler d1 migrations apply novus-events-staging --remote --config infra/wrangler/wrangler.toml --env staging
npx wrangler deploy --config infra/wrangler/wrangler.toml --env staging
```

Check status:

```bash
npx wrangler deployments list --config infra/wrangler/wrangler.toml --env production
npx wrangler tail --config infra/wrangler/wrangler.toml --env production
```

Do not run production seeds. `infra/scripts/seed-local.ts` only ever targets `--local`.

## 3. Rollback

Code:

```bash
npx wrangler deployments list --config infra/wrangler/wrangler.toml --env production
npx wrangler rollback <version-id> --config infra/wrangler/wrangler.toml --env production \
  --message "rollback: <reason>"
```

Rollback does not undo migrations or data. Because migrations are expand-only, the previous version still runs on the newer schema. A bad registry release is rolled back in the app, not with Wrangler.

Data: D1 Time Travel restores any minute of the last 30 days. A restore is destructive and must follow [infra/runbooks/restore.md](../infra/runbooks/restore.md), which replays the deletion ledger so deleted accounts stay deleted.

## 4. Backups

`novus-backup` exports both production databases every Sunday at 08:00 UTC through a Cloudflare Workflow, encrypts each dump with AES-256-GCM under a fresh key wrapped to the founders' offline RSA key, and writes only ciphertext to `novus-backups/full/{date}/`.

```bash
# Offline, on a trusted machine. The private key never enters the repository or Cloudflare.
node --experimental-strip-types infra/scripts/backup-keys.ts keygen --out /path/to/offline/dir
# Put the printed public JWK in BACKUP_PUBLIC_KEY_JWK (infra/wrangler/backup.toml).

# A Cloudflare API token with D1 export permission, an expiry, rotated quarterly:
npx wrangler secret put D1_EXPORT_TOKEN --config infra/wrangler/backup.toml --env production
npx wrangler deploy --config infra/wrangler/backup.toml --env production

# 35-day lock on the ciphertext prefix, matching its lifecycle rule:
npx wrangler r2 bucket lock add novus-backups full-35d full/ --retention-days 35
npx wrangler r2 bucket lifecycle add novus-backups full-expire full/ --expire-days 35 --abort-multipart-days 1
```

The export token can run any SQL in the account, so it lives only in this Worker. Restoring from a backup: [infra/runbooks/restore.md](../infra/runbooks/restore.md).

## 5. Environments

| | local | staging | production |
| --- | --- | --- | --- |
| Data | sample seed | synthetic users | real |
| Access | 127.0.0.1 only | behind Cloudflare Access, `noindex` | public |
| Deploys | `wrangler dev` | Workers Builds from `main` | Workers Builds from `release` |
| AI key | optional, your own | staging key | production key (paid tier) |
