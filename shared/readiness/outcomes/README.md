# shared/readiness/outcomes

The pure half of Outcome reporting (plans 7.5-7.8, 9.5). Browser, Worker and tests share it.
Like the rest of shared/readiness it reads no clock, storage or network, and imports only its
own files, `../calendar` and zod (`purity.test.ts`). The enum lists are mirrored in `vocab.ts`;
`outcomes.test.ts` fails if they drift from shared/taxonomy or shared/disclosure.

| File | What it does |
|---|---|
| `window.ts` | `inDecisionWindow(cycle, date, today, roundDeadline)`: 7 days before a curated window to 21 days after its end, never in the future; without one, round deadline to today. Reads curated cycle facts only, never an Outcome-derived event. Also the prompt date (+3 days), window close and the 60-day edit window. |
| `stages.ts` | Plan 7.5.1 mapping. Selected means `accepted` or `declined_offer`. Not selected means `rejected`, or `no_response` once the window has closed. `withdrew` and undecided reports count in neither rate. `transitionResult(facts, from, to)` serves bands, calibration and validators. |
| `validate.ts` | Refusals: no `submitted` stage, duplicate stages, dates in the future or out of order, both campus outcomes, a decision without its date. The messages are fixed and never echo input. Flags: award without a nomination, a decision before the round closed, a decision outside the window, a class standing the rules do not admit, the seasonal cap. |
| `quality.ts` | `assessCycleQuality`: re-runs the validators. It holds a cycle on the over-count rule, flags decisions far from the modal week when the cycle has no curated window, and drafts a decision week once 10 distinct counted accounts report one. |
| `aggregate.ts` | Counted (institution_email and up), unflagged reports become `CountRow`s for `release()`: the total, a decision split, the furthest stage and a monthly timeline. |
| `summary-contract.ts` | Zod shape of `GET /programs/:slug/outcomes/summary`, and `bandDisplayStatus(gates)`. That status stays `official_base_rate_only` until every gate passes, approval included. |
| `give-to-get.ts` | Access lasts 12 months after any contribution, or until 30 days after the window for a pledge. What the report says is never an input. |
| `config.ts` | Public values: tier weights (self_reported 0, institution_email 0.6, letter_checked 0.8, email_authenticated and official_list 1.0), window pads and the edit window. Anti-abuse cut-offs (over-count fraction, seasonal cap) are **not** here. They come from the private D1 `config` table (`outcomes.anomaly.freeze_ratio`, `outcomes.anomaly.seasonal_cap`), and every check that needs one is skipped when it is unset. |

Weekly timelines: shared/disclosure has no `week` grain yet, so the timeline is released per
calendar month. A week grain there would let `aggregate.ts` switch to weeks.
