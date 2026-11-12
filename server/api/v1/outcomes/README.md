# server/api/v1/outcomes

Outcome reporting and the public outcome summary. Pure rules live in `shared/readiness/outcomes`. The jobs live in `server/jobs/kinds/{outcomes-quality,bands-fit}.ts`.

| Route (id) | Auth | Behaviour |
|---|---|---|
| `GET /api/v1/me/outcomes` (`listOutcomes`) | student | Returns the student's own reports. Public ids only, `no-store`. |
| `POST /api/v1/me/outcomes` (`createOutcome`) | student | One report per cycle (409 on a repeat), and the program must be on the student's Tracker (409 otherwise). Sensitive keys get 400. A status-defined program gets 404, the same answer as an unknown cycle. An identity-defined program without consent gets 409 `consent_required`, and so does an under-18 account without `minor_outcomes`. A Sponsor-affiliated account gets 403. Then the validators run: a refusal is 400 with field paths, and a flag stores the report as `flagged`. The tier is set server-side, and stays `self_reported` until edu verification exists. |
| `PATCH /api/v1/me/outcomes/:publicId` (`updateOutcome`) | student | Edits are allowed until 60 days after the decision, and the validators run again. Earlier flags are kept. `access_audit` records the changed field names under a pseudonymous key. |
| `GET /api/v1/programs/:slug/outcomes/summary` (`outcomeSummary`) | public | Every number comes from `release()` in shared/disclosure (`public`: totals of 5 or more, cells of 10, bands below 20, complements). Fixed daily windows: only reports created before today's UTC midnight count. A held cycle releases nothing, and a status-defined program gets 404. `bands.status` stays `official_base_rate_only` until a stored model passes every gate. |

Holds are rows in `outcome_cycle_holds` (plan 7.9.1, migration 0006): `outcomes.quality` opens
one with the over-count `outcome_anomaly` task, and a Curator approving or rejecting that task
lifts it (snoozed or escalated tasks keep it). `cycleHeld` reads the table through
`server/db/repos/bands.ts`, and during the transition a live `outcome_over_count` task still
counts as a hold too.

Fitted band models are also stored in D1 (`band_models`, one row per covered program), which
readiness reads (`server/api/v1/student/readiness-bands.ts`). The summary's `bands.status`
reads the same rows through the same read-time rule (`./band-status.ts`: `readProgramBandFacts`
plus `decideProgramBand`): a live founder approval of the model's fingerprint, a model under
62 days old, no held cycle, the program's own eligibility and the fitted gates. It is `live`
when any of the program's transitions decides live today (UTC). The R2 copy is no longer read
at request time. `bands.fit` leaves held cycles out of the fit and retires (band_models and R2)
every key a complete run did not store.

Band models are stored privately in R2 under `private/bands/models/{type}.{from}-{to}.json`, a
prefix the pages router never serves. They hold coefficients, cell aggregates and gate results,
and never a report, an account or a date.
