# Novus pipeline

Python side of Novus: it keeps the opportunity registry true by watching official program pages,
proposing changes with evidence, and sending every change to a Curator. It handles public
program-side facts only and never reads student data.

```
pipeline/
  novus_pipeline/   fetching, Snapshots, change detection, evidence, validators, jobs, CLI
  novus_llm/        the LLM gateway (Gemini provider), budgets, prompts, call records
  docintel/         PDF text layers and OCR (separate owner)
  modal_app.py      Modal functions (modal is imported lazily)
  tests/            pytest; no network, HTTP mocked with respx
```

## How a page is checked

1. **Lease.** `drain` calls the Worker's catch-up watchdog, then leases `fetch` jobs from
   `POST /internal/v1/jobs/lease`. Payloads hold ids and public Source facts only.
2. **Gate every hop** (`fetcher.py`): host policy (`policy.py`; `never`, `manual_only` and
   `link_only` hosts get no request at all), robots.txt under RFC 9309 with stricter status rules
   (`robots.py`; 429 and 5xx mean "unreachable, fully disallowed", 401/403 mean "blocked"),
   Cloudflare Content Signals (`ai-input=no` keeps a page away from every model, `search=no` makes
   the host manual), the address guard (`netguard.py`; only global addresses, embedded IPv4
   unwrapped, connections pinned to the validated IP), and per-host spacing of at least 2 seconds
   (`limiter.py`). Requests are conditional and identify `NovusBot` with its `/bot` page. Bot
   challenges are reported, never evaded or retried. Bodies are capped by decoded bytes.
3. **Normalize** (`normalize.py`, run in a no-network Modal function in production): the
   canonical text (main content, including accordions and tab panels), the watch text (everything
   visible except navigation and footers, so "Deadline extended" banners are seen) and the hidden
   channel (inline-hidden text, which never reaches a model).
4. **Upload** the Snapshot to `POST /internal/v1/snapshots` (content-addressed; large bodies use
   `PUT /internal/v1/snapshots/raw/{sha256}`).
5. **Classify** against the Source's baseline (`detect.py`): `new`, `none`, `invalid`, `cosmetic`,
   `minor` or `key`. The reopen rule (`triage`) decides the Curator task: `quote_missing`,
   `urgent_recheck` (an earlier deadline within 21 days, or a new "paused"/"closed" status) or
   `key_change`. Machines never publish a value.
6. **Report** the outcome, hashes, window diff and `next_check_at` (`schedule.py`) through
   `POST /internal/v1/jobs/{id}/complete`, and request a task through
   `POST /internal/v1/review-tasks`.

## LLM extraction (Gemini)

`novus_llm.Gateway.run(request, output_model)` is the only way Python code calls a model.
`extract.page.v1` drafts the `extraction.v1` contract from the canonical text; the model only
pre-fills a Curator's form. Deterministic code then decides what the page says:

- `evidence.py` accepts a quote only if it occurs on the page exactly, or aligns within a 0.05 edit
  ratio with identical words and identical critical tokens (digits, months, AM/PM, zones, URLs,
  amounts, and words such as "not", "only", "ineligible", "at least"). Eligibility and status
  quotes must match exactly.
- Values are parsed from the located page span (`dates.py` reads dates, times and zones, including
  "your time zone" wording), never from the model's `value`.
- `validators.py` adds 4.8's findings (`QUOTE_ALTERED`, `HIDDEN_TEXT`, `CLOSE_BEFORE_OPEN`,
  `NO_RESTRICTION_UNSUPPORTED`, `DEADLINE_IN_PAST`, `OUT_OF_CYCLE_WINDOW`, `CONFLICTING_DEADLINES`,
  `SENSITIVE_AUDIENCE_SUGGESTED`, ...) and confidence labels derived from them, never from the model.
- `risk.py` emits quoted, deterministic risk signals (fees, gift cards, SSN requests, lookalike
  domains); the Worker scores them.

The gateway refuses, at no cost: student content, a Snapshot from a non-fetchable host or with
`ai-input=no`, and variables whose names look like sensitive attributes. It degrades to
`unavailable` without a key, so every path still works by hand. It reserves budget before each
call, handles refusals and `MAX_TOKENS`, validates JSON with pydantic, and records one call row per
attempt with token counts and cost but no prompt or output text.

Use a billing-enabled Google Cloud project for `GEMINI_API_KEY`: Google may use content sent on
free-tier projects to improve its products. Only public page text is ever sent.

## Configuration

All secrets come from the environment (Modal secrets in production). None has a default and none
belongs in the repository.

| Variable | Used by | Notes |
|---|---|---|
| `NOVUS_INTERNAL_BASE_URL` | internal client | e.g. `https://internal.novus.example` |
| `NOVUS_INTERNAL_KEY_ID`, `NOVUS_INTERNAL_KEY_SECRET` | internal client | one key per function family; the Worker holds `INTERNAL_HMAC_KEYS` |
| `NOVUS_ACCESS_CLIENT_ID`, `NOVUS_ACCESS_CLIENT_SECRET` | internal client | optional Cloudflare Access service token |
| `GEMINI_API_KEY` | novus_llm | placeholder: `your-gemini-api-key` |
| `GEMINI_MODEL` | novus_llm | allowlisted ids only (mirrors `server/ai/config.ts`); default `gemini-3.5-flash-lite` |
| `NOVUS_INTERNAL_CLOCK_KEY_ID`, `NOVUS_INTERNAL_CLOCK_KEY_SECRET` | drain | a `clock.*` key, the only drain key allowed to call the catch-up watchdog; unset skips it |
| `ENVIRONMENT` (or `NOVUS_ENVIRONMENT`) | novus_llm | `local`, `staging` or `production`; production with no shared budget store refuses model calls |
| `NOVUS_LLM_MONTHLY_CAP_USD`, `NOVUS_LLM_KILL` | novus_llm | monthly cap; `all` or route ids to kill |
| `NOVUS_BOT_PAGE_URL`, `NOVUS_BOT_FROM` | fetcher | crawler identity, never a person |

### Internal request signing

Every `/internal/v1` request carries `x-novus-key-id`, `x-novus-timestamp` (unix seconds),
`x-novus-nonce` (single use), `x-novus-content-sha256` and `x-novus-signature`, the hex
HMAC-SHA256 of:

```
NOVUS-HMAC-SHA256\n{METHOD}\n{path?query}\n{timestamp}\n{nonce}\n{sha256(body)}\n{keyId}
```

POST and PUT requests also carry `Idempotency-Key`; retries reuse it with a fresh nonce.

## Running

```bash
cd pipeline
.venv/bin/python -m pytest tests                      # all tests, no network
.venv/bin/python -m novus_pipeline policy check https://www.example.org/x
.venv/bin/python -m novus_pipeline normalize page.html --show
.venv/bin/python -m novus_pipeline classify old.html new.html
.venv/bin/python -m novus_pipeline validate page.html proposal.json --url https://www.example.org/x
.venv/bin/python -m novus_pipeline extract page.html --url https://www.example.org/x   # needs GEMINI_API_KEY
.venv/bin/python -m novus_pipeline import-list README.md --csv rows.csv
.venv/bin/python -m novus_pipeline drain --kinds fetch                                  # needs NOVUS_INTERNAL_*
```

Test fixtures under `tests/fixtures/` are synthetic sample data on `example.org` hosts.
