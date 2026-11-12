# Curator console and review-task API

Console v0 for Curators (plan 01 F-16, plan 04 section 4.10, runbook 14.4): the review queue,
evidence shown side by side, the publish step that writes ChangeEvents, the ops pipeline view and
release rollback.

| Part | Path |
| --- | --- |
| API (Worker, Hono) | `server/api/v1/curator/` |
| Console (React, separate Vite entry) | `client/src/console/` (entry `client/src/console/index.html`) |
| Tests | `server/api/v1/curator/*.test.ts`, `client/src/console/console.test.ts` |

Everything in local databases and tests is **sample data** (`is_sample = 1`). The console labels
sample records with a "Sample" chip and a banner.

## Access

Every route runs these checks in order:

1. `requireRole("curator", "admin")` from `server/auth`. Signed out gets 401. A user without the
   role gets 403. A staff session that has not passed TOTP gets 403 with type
   `/problems/second-factor-required`, because every non-student role needs the second factor
   (plan 2.3.10). The console reads that type and asks for the authenticator code, or for
   first-time setup.
2. The console surface. In `staging` and `production`, the session must come from `curate.`,
   which has a Strict cookie, a fixed 12-hour session and sits behind Cloudflare Access. A curator's
   session from the main app origin gets 403. Local development accepts both surfaces.
3. A Curator identity. Task routes also need an active `curators` row linked to the account,
   because approvals are signed with the public handle (`verified_by`). An admin with no handle
   can read the ops view and roll a release back, but cannot work tasks.

Rollback needs the `admin` role and the matrix row `registry.release.rollback`. The ops view
checks `ops.pipeline.read`.

## Routes (mounted under `/api/v1`)

| Route id | Method and path | What it does |
| --- | --- | --- |
| `listReviewTasks` | `GET /review-tasks?view=&kind=&cursor=&limit=` | Lists tasks. Views: `queue`, `mine`, `second_review`, `escalated`, `snoozed`. Order is due time, then severity (error report 1.0 down to hint 0.3), then the wedge flag, then priority and age. Items are contract `ReviewTask`s, plus `context` (program name, term, sample flag, severity, overdue, first approver) and `viewer` (handle, roles) |
| (unmapped) | `GET /review-tasks/:id` | The task with its evidence side by side (below) |
| `claimReviewTask` | `POST /review-tasks/:id/claim` | Claims the task for 15 minutes. An expired claim can be taken over. Second review is never offered to the first approver. Escalated tasks go to admins only |
| `releaseReviewTask` | `POST /review-tasks/:id/release` | Returns the task to `open`, or to `second_review` if it already has a first approval |
| `resolveReviewTask` | `POST /review-tasks/:id/resolve` | `approve` (optional `edits`), `reject` (needs `rejectReason`), `snooze` (needs `snoozeUntil` and a reason), `escalate` (needs a note). Also takes `activeSeconds` from the console timer |
| (unmapped) | `POST /review-tasks/:id/recheck` | Adds a `fetch` job for each approved Source of the program (priority 1 if `urgent`) |
| (unmapped) | `POST /review-tasks/:id/official-opened` | Logs that the Curator opened the live official page |
| `opsPipeline` | `GET /ops/pipeline` | Queue depth and lateness by job kind, failures, the last run of each Worker kind, heartbeats, review SLA counts, median active time and releases |
| (unmapped) | `POST /ops/jobs/:id/retry` | Puts a dead job (or a pending job that already failed) back in the queue with a fresh attempt budget |
| `releaseRollback` | `POST /registry/release/rollback` `{release}` | Admin only. Points `releases/current.json` back at an earlier built release |

The request schemas in `server/api/v1/curator/schemas.ts` are strict supersets of the route-map
schemas. Every contract-valid body is still accepted, and a unit test checks this.

## Evidence side by side

`GET /review-tasks/:id` returns:

- **Verified values.** The cycle fields (status, opening date, application link, fee, and when
  and by whom it was last verified), the live Deadlines, the Requirements, and every live
  FieldEvidence quote.
- **Snapshots.** Up to four, each as plain text read from R2 (`snapshots/...` text key): the
  task's own Snapshots, the extraction's Snapshot, and the latest and baseline Snapshot of each
  Source. Every quote is located in the text, both verified quotes and draft quotes, and returned
  as highlight ranges. Matching ignores whitespace, case and curly versus straight quotes, never
  different words. A verified quote missing from the newer page is listed in `missingQuotes`.
  PDFs link to the official file at `#page=N`.
- **Window diff.** A line diff of the baseline against the latest Snapshot, changed lines first
  with one line of context.
- **Draft proposals** from the pipeline's `extract.page.v1`. These are plain text with links,
  tags and control characters removed.
- **Validator findings**: path, code, blocked and flags. Model confidence is never included.
- **Risk signals**, the first approval if there is one, whether this Curator opened the official
  link, and the cycle's audit history.

## Approve and publish (`server/api/v1/curator/publish.ts`)

`edits` can change the cycle `status`, `applicationUrl`, `applicationFeeCents` and `opensOn`.
Each changed field needs a quote in `cycleEvidence`. Edits can also hold up to 20 Deadline
operations (`upsert` into a slot, or `withdraw`), each with its quote. `verify` defaults to true:
approving is the human statement "verified as of now". An approval with no edits is a
reconfirmation.

Checks run before anything is written:

- Snapshot evidence must name a Snapshot of the same program, and the quote must appear in its
  stored text (400 otherwise). The stored quote is the canonical Snapshot text at the located
  span, with `html` or `pdf_text` offsets and `match: exact`. A `manual_note` quote is stored with
  `match: manual`.
- Status changes must be allowed transitions (`canTransitionCycle`).
- A changed deadline, status or application link needs the official page opened during the claim
  and logged within the last 12 hours. Otherwise the answer is 412.
- `subjectVersion` (the cycle version the Curator reviewed) is required whenever something
  publishes.
- A `community_hint` is approved only with at least one quote from an official Snapshot
  (REQ-063). A hint with no Snapshot behind it is rejected, or re-checked first.

**High-impact changes** need a second, different Curator:

- status set to `paused` or `ended`
- a deadline moved more than 3 days earlier
- a new application-URL host
- an attested change: a URL or fee backed by a note, or an attested campus date

The first approval stores the edits on the task and moves it to `second_review`. Another Curator
claims it and approves with no edits (or with identical edits) to publish. Different edits make
theirs the new first approval.

**The publish batch** is one D1 batch, in this order:

1. assertion that the approver still holds the claim
2. publish guard on the task id and cycle version
3. cycle update (changed fields, verification, version + 1)
4. Deadline inserts, revisions or withdrawals (ICS `SEQUENCE` + 1)
5. old FieldEvidence superseded and new FieldEvidence inserted
6. registry_audit rows with before and after values
7. ChangeEvents: `deadline.changed` (with `previousLocalDate`, so the alert priority is right),
   `cycle.status_changed` and `program_cycle.verified`
8. each cited Source's baseline moved to the cited Snapshot
9. a pending RegistryRelease, unless one is already pending
10. the task set to `applied`, with its audit row

`alerts.match` fans the ChangeEvents out to students' Alerts. `release.build` picks up the pending
release on its next tick.

If the cycle version is stale, nothing is written. The task re-opens (`lastApplyFailure`) so the
next claim sees a fresh diff, and the answer is 409 `version_conflict`. A repeated approval of the
same task fails on the guard key, so ChangeEvents are never duplicated.

## Audit

Everything goes through the AuditLog service (`server/services/audit`):

- **Task actions** (claim, release, first approval, approve, reject, snooze, escalate, recheck,
  official link opened, apply failed) are registry_audit rows on the task's subject, with field
  `review_task.{action}` and the task id. Each one is in the same batch as the change it records.
  A batch starts with an assertion (`SELECT json(...)` over the task row, which throws when the
  claim is no longer held), so a lost claim rolls back the change and its audit row together.
  These rows also go into the daily digest chain.
- **Ops actions** (job retry, release rollback) are access_audit rows with action `update`,
  purpose `console.job_retry` or `console.release_rollback`, field names only, and subject key
  `job:{id}` or `release:{from}->{to}`. A rollback also logs an alert-level line
  (`release_rolled_back`) for the founders, which is the "notify founders" duty.

The actor is the Curator's public handle, or `admin:{publicId}` for an admin with no handle.
Emails never appear.

## Ops pipeline view

The view shows, per job kind, how many jobs are pending, leased or dead, and how late the oldest
pending job is. It lists failures with attempts, the error class and the **names** of the payload
keys (never the values). It also shows the last run of each Worker kind, heartbeats (stale after
15 minutes), review SLA counts and the median active seconds of tasks applied in the last 24 hours
(the F-16 metric), and the last 12 releases with `canRollBackTo`.

## Release rollback

A rollback moves the pointer only. The target must have been built (client-core key, sha256,
`built_at`), be older than the live release, and still have its artifact in R2. Releases above
the target are marked `failed`, so `latestPublishedRelease` agrees with the pointer. The response
uses the public path `/data/client-core/{n}.json`. The next Curator publish builds a new release
from the current D1 registry, so the fix for whatever caused the rollback ships the normal way.

## Console (`client/src/console/`)

- `index.html` and `main.tsx` are the separate entry. `ConsoleApp.tsx` uses wouter with base
  `/curate`. There are two screens: the review workspace (queue on the left, task on the right)
  and Pipeline.
- Surfaces are solid. The glass gate never runs on this entry, and `console.css` uses the Ember
  tokens with no blur or translucency behind text. Status chips always show an icon and a word.
- Keys (plan F-16): C claim, O open the official page (logged), A approve, E edit, R reject,
  S snooze, X escalate, L release, J/K next or previous. Keys are ignored while typing in a
  field. Merge (M) and bulk approve (Shift+A) are **not built** in v0.
- Active time is counted only while the tab is visible and focused, and for at most 90 seconds
  after the last input. It is capped at one hour per task and sent with each decision.
- Sign-in uses the emailed-code helpers from `client/src/pages/sign-in/model.ts`, then the TOTP
  step-up or first-time setup through `/api/auth/novus/second-factor/*`.
- AI: the console makes no model calls. Pipeline drafts are shown as plain text when they exist.
  When drafting is off or found nothing, the console says so, and approval never depends on a
  draft.

## Privacy

Tasks concern registry records and public official pages only. No route reads or returns
StudentProfile, SensitiveAnswers, tracker rows, resume text or analytics. Logs carry counts and
codes only. Job payload values and emails stay on the server.

## Registration (integration agent)

Done in the wave 3 integration pass: the router is mounted, `/curate/*`
serves the console shell, Vite builds the console entry, the four extra routes are mapped
(`getReviewTask`, `recheckReviewTask`, `reviewTaskOfficialOpened`, `retryJob`), and the schemas
live in `shared/contracts/curator.ts`. Only the Cloudflare route and Access application remain.
The original hand-off follows for reference.

1. **Worker mount** in `server/app.ts`: add `curatorRoutes` from `server/api/v1/curator` under
   `/api/v1`. It can be combined with the registry router the same way student and onboarding
   are combined: `new Hono().route("/", registryRoutes).route("/", curatorRoutes)`.
2. **Console shell route** in `server/lib/app-factory.ts`: `app.get("/curate", consoleShell)` and
   `app.get("/curate/*", consoleShell)`. This is a copy of `spaShell` that fetches
   `/src/console/index.html` from ASSETS, with `no-store` and a strict CSP:
   `buildCsp({ turnstile: false, inlineStyles: false })`. React sets styles through the CSSOM,
   which CSP allows. In staging and production, answer 404 unless the hostname starts with
   `curate.`. Add `/curate` to `isSpaPath` (or its equivalent) in `security-headers.ts`.
3. **Vite entry** in `vite.config.ts`: set `build.rollupOptions.input = { main:
   "client/index.html", console: "client/src/console/index.html" }` (absolute paths). This was
   checked with a throwaway config: the build succeeds and writes
   `dist/public/src/console/index.html` plus `assets/console-*.js` (38.6 kB, 11.9 kB gzip).
4. **Route map** in `shared/contracts/routes.ts`. Map the four extra routes:
   - `GET /api/v1/review-tasks/:id`
   - `POST /api/v1/review-tasks/:id/recheck`
   - `POST /api/v1/review-tasks/:id/official-opened`
   - `POST /api/v1/ops/jobs/:id/retry`

   Also widen `resolveReviewTask.body` to `CuratorResolveSchema`, `listReviewTasks.query` to
   `QueueQuerySchema` and its response to `QueueResponseSchema` (all exported from
   `server/api/v1/curator`; move them to `shared/contracts/ops.ts` if the map must not import
   server code). Then remove `listReviewTasks`, `claimReviewTask`, `resolveReviewTask`,
   `releaseReviewTask`, `opsPipeline` and `releaseRollback` from `KNOWN_UNBUILT` in
   `server/routes-map.test.ts`. `server/api/v1/curator/wiring.test.ts` checks the router
   against the map.
5. **Cloudflare**: a `curate.<domain>` route to the same Worker, behind a Cloudflare Access
   application (staff emails only).

## Not built in v0

- Merge (M) for `possible_duplicate`.
- Shift+A bulk approve and its weekly re-check log.
- Editing eligibility rule sets, Requirements and counts in the console. Rule sets still publish
  through `registry.publishRuleSet`.
- Gold mode.
- Owner-update and sponsor flows.
- Notifying every verified advisor of a confirmed campus deadline.
