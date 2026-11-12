# Local development

Everything runs on your machine: `wrangler dev` uses local D1, R2 and email simulators, so you need no Cloudflare account and no keys. Data is SAMPLE data.

## 1. Tools

- Node 24 (`nvm use` reads `.nvmrc`). Wrangler 4.160.0 is a dev dependency, so use `npx wrangler`.
- Python 3.12.4 or newer for the pipeline (3.14 is used in CI).

```bash
npm ci
python3 -m venv pipeline/.venv
pipeline/.venv/bin/python -m pip install -e "pipeline[dev]"
```

## 2. Local secrets

```bash
cp .dev.vars.example .dev.vars
```

`.dev.vars` is git-ignored and lives at the repository root. Wrangler only looks for `.dev.vars` next to the config file it is given (`infra/wrangler/`), so every `wrangler dev` here passes the file explicitly:

```bash
npx wrangler dev --config infra/wrangler/wrangler.toml --env-file .dev.vars
```

Without `--env-file .dev.vars` the Worker starts with none of these values (no `BETTER_AUTH_SECRET`, so sign-in fails). Every value in it is optional locally:

| Name | Without it |
| --- | --- |
| `GEMINI_API_KEY` | AI features return their deterministic fallback (`meta.status: "unavailable"`). Use a key from Google AI Studio; with a free-tier key, use sample data only (see [ai.md](ai.md)). |
| `BETTER_AUTH_SECRET` | Sign-in needs it. Generate one: `openssl rand -base64 32`. |
| `INTERNAL_HMAC_KEYS` | The pipeline cannot call `/internal/v1`. JSON object `{"keyId":"secret"}`. |
| `SENTRY_DSN` | Errors are only logged locally. |
| `TURNSTILE_SECRET_KEY` | The server asks for no Turnstile token. To exercise the widget locally, set Cloudflare's always-pass test secret `1x0000000000000000000000000000000AA` (or always-fail `2x0000000000000000000000000000000AA`); `GET /api/v1/turnstile` then hands the sign-in page the matching test site key (`server/auth/turnstile.ts`). Test keys outside `local` are reported as a deploy mistake. |

Non-secret settings (`APP_ORIGIN`, `ENVIRONMENT`, `GEMINI_MODEL`, `AI_DISABLED`, and the public `TURNSTILE_SITE_KEY` for staging and production) live in `infra/wrangler/wrangler.toml` under `[vars]`; `.dev.vars` may override them.

## 3. Databases

Two local D1 databases, both under `.wrangler/state` (git-ignored):

```bash
npm run db:migrate:local
npx wrangler d1 migrations apply novus-events --local --config infra/wrangler/wrangler.toml
npm run db:seed:local                 # add -- --reset to reload, -- --today 2026-11-11 to pin dates
```

Inspect them:

```bash
npx wrangler d1 execute novus-main --local --config infra/wrangler/wrangler.toml \
  --command "select slug, name from programs limit 5"
```

Start again from nothing by deleting `.wrangler/state`.

After changing `server/db/schema.ts`, generate a migration with `npm run db:generate` (and `npx drizzle-kit generate --config server/db/drizzle.events.config.ts` for `novus-events`). See [server/db/README.md](../server/db/README.md).

## 4. Run

Worker with the built SPA (closest to production):

```bash
npm run build                                                              # client -> dist/public
npx wrangler dev --config infra/wrangler/wrangler.toml --env-file .dev.vars   # http://localhost:8787 (127.0.0.1 only)
```

`npm run dev:worker` is the same command once its script carries `--env-file .dev.vars`; until then pass it yourself: `npm run dev:worker -- --env-file .dev.vars`.

Fonts are self-hosted from `client/public/fonts` (DM Mono, Doto and Urbanist, SIL OFL 1.1, licenses next to the files), so the Worker's CSP keeps `font-src 'self'` and nothing loads from a font CDN. `npx tsx infra/scripts/ci-checks.ts fonts` checks the files, licenses and references.

SPA with hot reload: `npm run dev` (Vite). Point it at the Worker for API calls.

Cron triggers do not fire on their own in `wrangler dev`. Start it with `--test-scheduled` and trigger one by hand:

```bash
npx wrangler dev --config infra/wrangler/wrangler.toml --env-file .dev.vars --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"   # tick
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"     # hourly
curl "http://localhost:8787/__scheduled?cron=0+8+*+*+*"     # daily slot
```

## 5. Test

```bash
npm run typecheck
npx vitest run                                           # or npx vitest run server/db for one module
npx vitest run --config infra/vitest.config.ts           # CI guards, backups, eligibility gate (Node)
npx vitest run --config infra/vitest.workers.config.ts   # *.worker.test.ts inside workerd
pipeline/.venv/bin/python -m pytest pipeline
npx tsx infra/scripts/ci-checks.ts all
npx tsx infra/scripts/release-gates.ts                   # eligibility release gates (node, workerd, python)
```

### Eligibility golden cases in every runtime

`shared/eligibility/golden/` holds the hand-labelled cases. They run in:

| Runtime | Runner | Command |
| --- | --- | --- |
| Node (with device answers) | `shared/eligibility/golden.test.ts` | `npx vitest run shared/eligibility` |
| Node (server path) | `infra/eligibility/golden-runner.ts` | `npx vitest run --config infra/vitest.config.ts infra/eligibility` |
| workerd | `infra/workers/eligibility-golden.worker.test.ts` | `npx vitest run --config infra/vitest.workers.config.ts` |
| Python | `pipeline/novus_eligibility` | `pipeline/.venv/bin/python -m pytest pipeline/tests/test_eligibility_golden.py` |

workerd and Python compare every result in full with the Node output in `pipeline/novus_eligibility/data/node-results.json`. After changing the engine, the field catalogue, reason copy or the golden files, regenerate that file and `catalogue.json` (the Python port's copy of the TypeScript tables) and review the diff:

```bash
UPDATE_GOLDEN=1 npx vitest run --config infra/vitest.config.ts infra/eligibility
```

`infra/scripts/release-gates.ts` is the release gate: the three runtimes above, freshness of the generated files, and generated boundary profiles over every rule set (`--rule-sets file.json` adds a release's rule sets; `--only node|workerd|python` runs one gate). The Workers pool's own workerd supports compatibility dates up to 2026-08-22, so `infra/vitest.workers.config.ts` pins that date instead of production's 2026-11-01.

`ci-checks.ts` runs the same guards as CI: `secrets` (no `.dev.vars`, keys or private keys in files git would commit), `config` (Wrangler rules), `sensitive` (no status or identity terms in migrations, contract schemas or log calls), `content` (no prototype branding or readiness percentages in public UI) `workflows` (SHA-pinned actions) and `fonts` (self-hosted fonts with licenses, no font CDN, CSP `font-src 'self'`). Run one with its name, for example `npx tsx infra/scripts/ci-checks.ts secrets`.

## Rules worth knowing before your first change

- SensitiveAnswers (citizenship or immigration status, income, disability, race or ethnicity, gender, sexual orientation, first-generation, veteran, foster care and similar) stay in the browser. Never add them to a request schema, a table, a log line, an analytics event or a prompt.
- Readiness is four parts, never one number about a student.
- Model calls go only through `server/ai` (TypeScript) or `pipeline/novus_llm` (Python).
- Sample data stays labelled as sample.
