# Novus

Novus helps first- and second-year students find and prepare for early opportunities: internships, fellowships, research programs, apprenticeships, scholarships, insight weeks, sprints and conferences. Every program record carries its sources, and a Curator verifies deadlines before they are published.

> The data in this repository is **sample data**. Every sample program, organization and date is invented, labelled "Sample" or "Example", and stored with `is_sample = 1`.

## Architecture

```
Browser ──► Cloudflare Worker (Hono) ──► D1  novus-main    registry, students, notifications, jobs
             │  public pages (Hono JSX)  ──► D1  novus-events  analytics, LLM ledger, email ledger
             │  /app/*  React SPA shell  ──► R2  novus-store   snapshots/ releases/ cards/ ledger/ backups/
             │  /api/v1  REST            ──► Email Sending (codes, reminders, alerts)
             │  /internal/v1  pipeline API (Access + HMAC)
             │  /cal  ICS feeds   /mcp  MCP server
             └─ Cron Triggers: 5-minute tick, hourly, daily 08:00 UTC

Modal (Python) ── leases jobs over /internal/v1 ──► fetch, verify, extract, predict
Gemini         ◄── server/ai and pipeline/novus_llm only (explain, extract; never decide)
novus-backup   routeless Worker: weekly encrypted D1 export to R2
```

- **One Worker** serves public pages, the SPA shell for `/app/*`, the REST API, calendar feeds, the internal pipeline API and MCP. Its scheduled handler is the only clock.
- **D1 is the queue.** Jobs, leases and run records live in `novus-main`. The Python pipeline on Modal leases its job kinds through signed internal routes.
- **Eligibility runs in the browser** for any rule that depends on status or identity answers. Those answers (SensitiveAnswers) never reach a server route, table, log, analytics event or model prompt.
- **Readiness has four parts:** eligibility with reasons, a requirements checklist that names each gap, a competitiveness band, and next actions linked to the Roadmap. There is never a single score, percentage or match number about a student.
- **AI (Google Gemini)** explains and gives feedback with citations to program sources. Deterministic code decides eligibility, requirements, bands and dates. With no key, every AI feature degrades to its deterministic fallback. See [docs/ai.md](docs/ai.md).

## Repository

| Path | What it holds |
| --- | --- |
| `client/` | React 18 + Vite SPA (`/app/*`), Tailwind, shadcn/radix, wouter |
| `server/` | Worker entry, Hono app, pages, `api/v1`, `internal`, `auth`, `cal`, `mcp`, `jobs`, `ai`, `db` (schema, migrations, repos, seed) |
| `shared/` | zod contracts and route map, eligibility, readiness, matching, taxonomy, policy |
| `pipeline/` | Python pipeline (`novus_pipeline`), LLM gateway (`novus_llm`), document intelligence (`docintel`), Modal app |
| `infra/` | Wrangler configs, backup Worker, CI guards, runbooks, local seed script |
| `legacy/` | The previous Express prototype, kept for reference only |

## Quick start

Requires Node 24 (`.nvmrc`) and, for the pipeline, Python 3.12.4 or newer.

```bash
npm ci
cp .dev.vars.example .dev.vars          # optional: add your own GEMINI_API_KEY
npm run db:migrate:local                 # novus-main
npx wrangler d1 migrations apply novus-events --local --config infra/wrangler/wrangler.toml
npm run db:seed:local                    # SAMPLE programs
npm run build && npm run dev:worker      # http://localhost:8787
```

Full instructions: [docs/dev-setup.md](docs/dev-setup.md). Deploying: [docs/deploy.md](docs/deploy.md).

## Checks

```bash
npm run typecheck
npx vitest run                                   # shared, server, client
npx vitest run --config infra/vitest.config.ts   # infra guards and backup encryption
pipeline/.venv/bin/python -m pytest pipeline     # pipeline
npx tsx infra/scripts/ci-checks.ts all           # secrets, config, sensitive terms, content, workflows
```

CI runs all of these on GitHub Actions with no secrets ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Security and privacy

This repository is public. Keys live only in Worker secrets (`wrangler secret put`) and in your local, git-ignored `.dev.vars`. Never commit real keys; the `secrets` guard fails CI if it finds a credential-shaped string or a local secret file. Report a vulnerability privately to the maintainers rather than in a public issue.

## License

[MIT](LICENSE).
