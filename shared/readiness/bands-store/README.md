# shared/readiness/bands-store

How stored band models reach readiness. `bands.fit` fits one model per opportunity type and
stage transition (`../bands.ts`); this folder defines how that model is stored per program and
which gates are re-checked every time readiness reads it. Pure, like the rest of
shared/readiness: the day is an input, and the folder imports only its own files (the purity
test's rule), so the shapes are restated structurally and `bands-store.test.ts` checks them
against `BandModel` and `allBandGatesPass`.

| File | What it does |
|---|---|
| `rows.ts` | `bandModelKey(type, from, to)` (`{type}.{from}-{to}`, the key approval tasks name), `splitModelByProgram`: one `band_models` row per covered program, holding the same coefficients with only that program's entry. |
| `gates.ts` | `decideProgramBand(rows, ctx)`: the model readiness may use, or every reason there is none. |
| `config.ts` | `maxModelAgeDays` 62 (judgment: one missed monthly refit is tolerated, two are not). |
| `testing.ts` | TEST ONLY: a hand-built model with invented ids (`fixtureBandModel`). |

## Gates checked at read time

All must hold, otherwise readiness gets no model and shows the official base rate:

| Check | Failure code |
|---|---|
| The program is not status-defined | `sensitive_program` |
| The student's official transition is known (`transitionForStudent`) | `no_transition` |
| A live row covers this program and exactly that transition | `no_model` |
| Row and model agree (key, type, stages, version, one program, the right id) and the fit day parses | `malformed_model` |
| The model's type is still one of the program's types | `type_mismatch` |
| Fitted at most 62 days ago, and not in the future | `stale_model`, `fitted_in_future` |
| A founder approval (`band_model_approval` approved or applied, `payload.modelKey`) is live **now** | `not_approved` |
| No live hold on any cycle of the program | `cycle_held` |
| The program's own n_eff ≥ 30 and ≥ 8 reports of each outcome | `program_ineligible` |
| Every fitted gate passed, in the indexed columns **and** in the stored JSON | `pooled_sample_size`, `held_out_*`, `representativeness`, `fairness`, `usefulness` |

Approval is taken from the read, not the fit: approving after the fit turns a band on without a
refit, and revoking turns it off at once. A failed skill or usefulness gate would let
`bandForStudent` say "same for everyone at this stage"; read time is stricter and shows the
official base rate until every gate passes. A campus applicant of a nomination-gated program is
matched to the national transition shown "if nominated", never to a campus-stage model.

## Where it is used

- `server/db/repos/bands.ts`: `band_models` and `outcome_cycle_holds`, plus `readProgramBandFacts`
  (live rows, live approvals, held cycles, the counted report total).
- `server/api/v1/student/readiness-bands.ts`: `resolveReadinessBands` and
  `loadBandedReadiness`, the readiness route's loader with bands. `reportsBanded` is the
  program's counted report total released through shared/disclosure (`public`), filed before
  today's UTC midnight, held cycles left out.
