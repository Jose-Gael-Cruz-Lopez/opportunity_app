# Registry candidate import

Researchers write candidate programs to files. The import turns each file into **unverified
draft Programs** with **ReviewTasks** for Curators (plan 04 4.4, 4.9 and 4.10; plan 01 F-16).
The import never publishes anything. A draft stays `is_published = 0` until a Curator publishes it.

| Part | Path |
| --- | --- |
| Parsing, validation, de-duplication, planning and writing | `server/api/v1/curator/import/` |
| Curator upload route | `POST /api/v1/curator/import` (`routes.ts`) |
| Local CLI | `infra/scripts/import-candidates.ts` |
| Tests (sample fixtures only) | `server/api/v1/curator/import/*.test.ts` |

**Keep real data out of the repository.** This is a public repository, and the curated program
registry is a business asset. Real candidate files live in
a private folder outside the repository. Point the CLI at them
there, and never copy them in. Every fixture in the tests is invented: the names say "Sample" or
"Example", and the hosts are `example.org`, `example.net` or `example.edu`. The CLI writes its SQL
to `.wrangler/novus-import/`, which is gitignored.

## Candidate files

A file is either JSON or CSV. The format is detected from the file name or content type, and
otherwise from the first character. One file holds at most 2,000 rows and 2 MB for the CLI, and
100 rows and 512 KB for the route.

**JSON** is either an array of candidates or an object with a `candidates` array (`programs` and
`rows` also work). The wrapper object can set `researcher` and `checked_on` for every row:

```json
{
  "researcher": "Novus Researcher AB",
  "checked_on": "2026-11-10",
  "candidates": [
    {
      "name": "Sample Coastal Ecology Fellowship",
      "organization": "Example Ocean Institute",
      "organization_kind": "nonprofit",
      "official_url": "https://ocean.example.org/fellowship",
      "types": ["undergraduate_fellowship"],
      "term": "Summer 2027",
      "deadlines": [{ "date": "2027-01-15", "kind": "application", "time_zone": "America/New_York", "quote": "Apply by January 15, 2027." }],
      "eligibility": ["First- and second-year undergraduates"],
      "evidence": [{ "field": "deadline", "url": "https://ocean.example.org/fellowship", "quote": "Apply by January 15, 2027." }]
    }
  ]
}
```

**CSV** has one header row and one row per candidate. The delimiter can be a comma, a semicolon or
a tab. Quoted cells may contain delimiters and new lines. List cells (`types`, `tags`,
`eligibility`, `identity_audience`) split on `;` or `|`. Each CSV row can carry one deadline and
one quote. A program with more deadlines goes in a JSON file.

Column names are matched loosely. `Official URL`, `official_url` and `officialUrl` are the same
column. Unknown columns are ignored, and the report lists them.

| Column | Required | Aliases | Notes |
| --- | --- | --- | --- |
| `name` | yes | `program`, `program_name`, `title` | Up to 200 characters |
| `organization` | yes | `org`, `org_name`, `sponsor`, `provider` | In JSON this can also be an object: `{ "name", "kind", "url", "country" }` |
| `official_url` | yes | `url`, `link`, `website`, `program_url` | The program's own page. Must be http(s) on a public domain. Tracking parameters and the fragment are dropped |
| `types` | yes | `type`, `opportunity_type`, `category` | 1-5 slugs from `shared/taxonomy/opportunity-types.ts` (`research_program`), or their labels. Out-of-scope types are refused |
| `organization_kind` | no | `org_type` | One of `federal_agency`, `state_agency`, `foundation`, `nonprofit`, `company`, `university`, `national_lab`, `professional_society`, `other`. A new Organization without a kind is created as `other`, with a note in the report |
| `organization_url`, `organization_country` | no | `org_url`, `country` | The country is a two-letter code (default `US`) |
| `application_url` | no | `apply_url`, `application_link` | Proposal only |
| `recurrence` | no | | `annual` (default), `biannual`, `rolling`, `one_time`, `irregular` |
| `term` | no | `cycle`, `season` | Proposal only, for example "Summer 2027" |
| `deadlines` | no | `deadline` | JSON: a list of `{ date, kind, time, time_zone, label, quote, evidence_url }`. CSV: `deadline`, `deadline_kind`, `deadline_time`, `deadline_time_zone`, `deadline_label`, `deadline_quote`, `deadline_url`. `date` is free text. An ISO `YYYY-MM-DD` date also sets the review priority |
| `eligibility` | no | `eligibility_notes`, `who_can_apply` | Free-text notes (proposal only). Write eligibility as text and never as status-shaped keys such as `citizenship`. The app-wide sensitive-key guard refuses a JSON body that contains such a key |
| `evidence` | no | `quotes` | JSON: a list of `{ field, url, quote, page }`. CSV: `quote`, `quote_field`, `quote_url`, `quote_page` |
| `sensitive_audience` | no | | yes/no. `yes` is stored on the draft, the stricter setting |
| `identity_audience` | no | | Categories from `shared/taxonomy/sensitive.ts` (`race_ethnicity`, ...), stored on the draft. These describe the program, never a person |
| `tags`, `notes` | no | `summary`, `description` | Proposal only. `notes` never becomes the program summary, which is Novus's own prose |
| `researcher` | no | `researched_by`, `added_by` | A public handle such as "Novus Researcher AB". Email addresses are refused |
| `checked_on` | no | `checked_at`, `last_checked` | `YYYY-MM-DD` |
| `id` | no | `external_id`, `list_id` | A stable id that is unique across **all** files, such as a list UUID. Without one, the row's key is `sha256(org|name|host)[:16]`. Never use row numbers |

Each row is validated on its own, and a bad row never sinks the file. Errors name the row (the
array position for JSON, the line for CSV) and the field. They use fixed messages and never repeat
the submitted value.

## What the import writes

For each valid row it reaches one of these outcomes:

| Outcome | When | Writes |
| --- | --- | --- |
| `created` | No exact match | Below |
| `duplicate` | A Program has the same **normalized name**, **normalized Organization** and **official host** (`www.` ignored) | Nothing |
| `already_imported` | An earlier import holds this row's `id` (or hash key). Re-running a file creates nothing new. A reused id with a different program name adds a note | Nothing |
| `duplicate_in_file` | An earlier row of the same file has the same key, or matches it exactly | Nothing |
| `rejected` | The official URL is on a `never` host (LinkedIn, Indeed, Handshake and similar, from `server/internal/host-policy.ts` or a Curator's stricter stored policy) | Nothing |
| `invalid` | The row failed validation | Nothing |
| `failed` | The registry changed while the import ran (a slug was taken). Run the import again | Nothing for that row |

Names are compared after NFKD folding, lowercasing, `&` to "and", removing punctuation and a
leading "the". So "The Example Foundation, Inc." and "example foundation inc" are equal, while
"REU Site Chemistry" and "REU Site Chemistry and Biochemistry" are not.

A `created` row writes one D1 batch:

- **Organization**: reused when one with the same normalized name exists. Otherwise a new one is
  created with a unique slug, written in its own batch before the programs.
- **Program**: `is_published = 0`, `summary = NULL`, a unique slug (a redirect's slug is never
  reused; on a collision the Organization's slug is appended, then a number), its types (the
  first one is primary), `recurrence`, and the two audience flags. `is_sample` is set only with
  `--sample` or `?sample=1`.
- **No ProgramCycle, Deadline, Requirement, rule set or FieldEvidence.** Everything else the
  researcher wrote (term, deadlines, eligibility, quotes, application URL, notes) travels on the
  task as `payload.proposal` with `verified: false`. The import creates no cycle on purpose: with
  an empty cycle, a console approval would stamp it verified with no evidence (`edits.verify`
  defaults to true).
- **Source**: the official URL as an `official_page` (or `official_pdf`) Source with
  `approval = pending_approval` and no `next_check_at`, so nothing fetches it until a Curator
  approves it (plan 04: untrusted URLs). If the host has no `source_hosts` row, one is added from
  the seed policy. An existing host row is never changed, so a Curator's stricter policy stays.
  `link_only` hosts (Google Forms, Qualtrics and similar) get no Source. A URL that is already a
  Source is left alone.
- **ExternalRef** `novus-research:{id or key}`, the anchor for re-imports (`row_kind` is `json`
  or `hand` for CSV).
- **ReviewTask `new_program`** on the program, with reason `list_row` (plus `slug_collision` when
  the slug was taken), a due time 7 days out (the plan 04 4.10 SLA), and priority 5, or 4 when a
  proposed ISO deadline falls within the next 30 days. The payload holds `import` (batch id, file
  SHA-256, row, key, importer, time), `proposal` and the row's notes.
- **ReviewTask `possible_duplicate`** when the row is close to an existing Program, or to an
  earlier row of the file, but not an exact match. Close means the same name and Organization on
  another host, the same name on the same host, or the same official URL (an existing Source URL
  counts). `payload.matches` lists up to three candidates with their reasons. Sibling programs of
  one Organization at one host (REU sites) are not flagged, which follows plan 04 4.9's hard
  negatives.
- **registry_audit** `import.created` on the program (and on a new Organization), signed by the
  Curator's handle (route) or `local-cli:import-candidates` (CLI).

The drafts do not appear on public pages, in the client-core index, in MCP, in feeds or on
Organization pages, because every public read filters on `is_published = 1` and an Organization
with nothing published has no page.

## Upload route

`POST /api/v1/curator/import` takes one of two body forms:

- `multipart/form-data` with a `file` field, and optional `dryRun` and `sample` fields.
- The file itself as the body, with `Content-Type: application/json` or `text/csv`, and
  `?dryRun=1`, `?sample=1` or `?filename=` in the query.

Access follows the Curator console. The route needs `requireRole("curator", "admin")` with TOTP,
the `curate.` surface in staging and production, and an active Curator handle, which signs the
audit rows and `payload.import.importedBy`. It also checks the matrix row `review_tasks.work`.
`sample` is refused in production. Limits are 100 rows and 512 KB per upload. Each created row is
one D1 batch of about 8 statements, and a Worker invocation may run 1000 D1 queries.

The response is `200` with the report, whether the call was a dry run or not:

```json
{
  "batchId": "…", "dryRun": false, "format": "json", "fileSha256": "…",
  "summary": { "rows": 4, "created": 2, "duplicates": 1, "alreadyImported": 0, "invalid": 1, "rejected": 0, "failed": 0, "newOrganizations": 1, "reviewTasks": 3, "possibleDuplicates": 1 },
  "rows": [{ "row": 1, "status": "created", "programId": "…", "slug": "…", "taskIds": ["…"], "warnings": ["…"] }]
}
```

A file that cannot be read at all (not JSON, no rows, too many rows) returns `400
validation_failed` with one `detail`. The log line `curator.import` carries counts and the batch
id only, never names, URLs or file content.

## Local CLI

```sh
npm run db:migrate:local                       # once
npx tsx infra/scripts/import-candidates.ts --file <private-registry-folder>/<file>.json --local --dry-run
npx tsx infra/scripts/import-candidates.ts --file <private-registry-folder>/<file>.json --local
```

| Flag | Meaning |
| --- | --- |
| `--file PATH` | Candidates file (`.json` or `.csv`) |
| `--local` | Required. The CLI only ever writes to the local D1, and there is no remote mode. Staging and production imports go through the upload route, so a Curator's handle signs them |
| `--dry-run` | Plan, write the SQL file and print the report, but change nothing |
| `--sample` | Mark every row `is_sample = 1` (invented development data) |
| `--format json\|csv` | Override format detection |
| `--json` | Print the report as JSON |
| `--config`, `--database`, `--persist-to` | wrangler config (default `infra/wrangler/wrangler.toml`), D1 name (default `novus-main`), and local state directory |

The CLI reads the local registry with one `wrangler d1 execute --local --json` call, plans with
the same code as the route, writes `.wrangler/novus-import/import-<batch>.sql` and applies it
with `wrangler d1 execute --local --file`. The exit code is 0 when every row was created or
skipped as a duplicate, 1 when any row was invalid, rejected or failed, and 2 on bad arguments.

## After the import: what Curators do, and what is not built

The `new_program` and `possible_duplicate` tasks appear in the console queue (`kind=new_program`)
with the program name and the proposal in the payload. Approving a `new_program` task with no
edits records the review and publishes nothing, because the task's subject has no cycle.

The flow from draft to published program is not finished in console v0:

- **No create-cycle step.** The console's approve edits need an existing cycle (`edits.cycleId`),
  and the import deliberately creates none. Until a create-cycle action exists, a Curator's
  verified cycle, deadlines and evidence reach the registry through the Phase 0 curation path
  (`POST /internal/v1/curation-patches`, still answering 501) or by hand.
- **No publish-program step.** Nothing in the console sets `programs.is_published = 1`. That
  needs a Curator action guarded like the publish batch, which checks the "P0 verified" minimum
  (plan 04 4.4) and the audience answers, and requests a release.
- **No merge (M)** for `possible_duplicate`. A Curator rejects the draft (`duplicate`) for now.
- **The console does not render `payload.proposal` yet.** The queue and task API return it, but
  `client/src/console/` only shows pipeline extraction drafts.
- The plan's `.xlsx` per-Curator workbook with personal ingest keys and row hashes (backlog S04-006
  to S04-012) is a separate path. This import is the researcher-to-draft step that comes before
  it.

## Registration (done in the wave 4 integration pass)

- `server/app.ts` mounts `curatorImportRoutes` in the `registryRoutes` chain after `curatorRoutes`.
- Route map id `curatorImport` (`POST /api/v1/curator/import`, mount `registry`, phase 0, auth
  `curator`); `server/api/v1/curator/import/wiring.test.ts` checks the router against it. The
  route takes a file, so `shared/contracts/routes.test.ts` lists it with the bodiless routes.
- Body limit: `API_BODY_LIMIT_OVERRIDES` in `server/config/security.ts` gives this exact path
  `ROUTE_MAX_BYTES` (512 KB) plus 64 KB for multipart framing; every other `/api/v1` path keeps
  `API_BODY_LIMIT_BYTES` (128 KB). Tested in `server/middleware/middleware.test.ts`.
- `npm run registry:import:local -- --file <path>` runs the CLI against the local D1.
- Still open (founder decision): a dedicated `registry.import` matrix row if import rights should
  be narrower than `review_tasks.work`.

## Tests

```sh
npx vitest run server/api/v1/curator/import
```

- `import.test.ts`: normalization, the CSV reader, the schema (aliases, flat CSV columns, errors
  that never echo values), and the planner (exact, near and in-file duplicates, earlier imports,
  host policies, slugs, priority, sample marking).
- `routes.test.ts`: access (401, 403, TOTP, surface, handle), dry run, drafts that stay
  unpublished, the Curator queue, approval without publishing, idempotent re-runs, multipart and
  CSV bodies, the sensitive-key guard, and limits.
- `cli.test.ts`: argument parsing, wrangler JSON, and the rendered SQL applied to SQLite with the
  real migrations, then re-planned.
