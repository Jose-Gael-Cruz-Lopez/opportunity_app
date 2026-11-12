# shared/readiness

How ready a student is for one program cycle, shown as **four visible parts** and never as one
score, percentage or "match" number:

| Part | What it shows | Never |
|---|---|---|
| 1. Eligibility | shared/eligibility's `EligibilityResult`, unchanged, with a reason per rule | re-evaluated rules, sensitive answers |
| 2. Requirements | a checklist that names each gap, its start-by date and severity | dates after the deadline |
| 3. Competitiveness | official k of n per stage; a band word only behind every gate | a probability about the student |
| 4. Next actions | dated steps linked to Roadmap items, each with a reason code | more than 5 (3 on cards) |

Everything here is a pure function: the clock is an input (`now`), nothing is fetched, stored,
logged or randomised (seeded generators exist only for simulations and bootstraps), and the same
inputs give byte-identical output in the browser, the Worker and Node. `purity.test.ts` checks
this statically and at runtime.

```ts
import { assessReadiness, assessReadinessDetailed } from "@shared/readiness";

const report = assessReadiness(input);          // ReadinessReport (shared/contracts/readiness)
const detail = assessReadinessDetailed(input);  // + today, zone, effective deadline, funnel,
                                                //   reason codes, weekly-load plan, suggested starts
```

`ReadinessInput` takes the program and cycle, its Deadlines and Requirements, the evaluator's
`EligibilityResult` (or `null` for "rules not checked yet"), the NominationProcess, the student's
**non-sensitive** profile fields, progress rows, official StageOdds, an optional approved band
model, the student's other tracked applications and `now`.

## Privacy by construction

- The profile is read through an allowlist (`timeZone`, `institutionId`, `weeklyPrepHours`,
  `classYear`, `gpaBand`, `priorExperience`). Anything else on the object, including a smuggled
  citizenship, Pell, first-generation or identity answer, is ignored: a property test adds such
  keys and asserts byte-identical output, and `findSensitiveKeys(report)` is always empty.
- Sensitive eligibility rules arrive already evaluated in the browser, or stay `unknown` with
  resolver `student` on the server. Readiness never evaluates them; it only adds the next action
  "Answer the private eligibility questions on this device".
- Band features are an allowlist of three (class standing, GPA band, a generic prior-program
  answer). School, institution type, location, demographics, Pell and SensitiveAnswers cannot be
  features (`assertAllowedSpecs` throws), so competitiveness never depends on the student's school.
- `sensitiveAudience` programs show official counts only: no report count, no band.

## Part 1: eligibility

The evaluator's result is copied into the report unchanged, so every surface agrees.
`summarizeEligibility` only splits rules by verdict and pending items by resolver (`student` or
`novus`) and writes a one-line headline. A program without verified rules gets
`missingEligibilityResult`: status `unknown` with a `rule_set_missing` item, never "eligible".

## Part 2: requirements checklist

### Effective deadline (s06 6.4.5, `deadline.ts`)

Planning dates are local calendar dates (`YYYY-MM-DD`, never `new Date("YYYY-MM-DD")`). A
fixed-zone deadline plans to the earlier of its date in its own zone and in the student's zone; an
applicant-local deadline ("11:59 pm, your time zone") resolves in the student's zone, else the
browser's, else America/New_York. Month-only rows plan to the 1st; predicted windows to p10.

1. Known campus dates (the student's private date, an official campus row for their
   Institution, an attested row): the earliest one still upcoming and not after the national date.
2. Nomination-gated, none known: **E1 = national − L80** (70 days until five leads are known):
   "Estimated: confirm with your campus representative".
3. After E1: **E2 = national − L50** (42 days).
4. After E2 or a known campus date: the national date, labelled "may have passed".
5. Otherwise the next unexpired priority round, then the final national deadline.

Golden: Goldwater 2027 (last Friday in January, 17:00 America/Chicago) gives E1 = 20 Nov 2026.

### Lead times and the per-item formula (plan 7.4.2)

| Kind | Effort hours | Lead days (hard / comfortable) | Third party |
|---|---|---|---|
| recommendation | 1 per letter | 21 / 35 | yes |
| essay | 6 each | 14 / 14 (21 when campus-reviewed) | yes |
| campus_nomination | 3 | to the campus deadline (0 once campus-scoped, else 70) | yes |
| test_score | 10 | 30 | no |
| portfolio | 10 | 14 | no |
| resume | 3 | 3 | no |
| transcript | 0.5 | 7 | yes |
| interview | 3 | 2 (never scheduled before selection) | no |
| fee; other | 0.25; 2 | 0; 7 | no |
| coursework; gpa_floor | informational | none | no |

Curators override effort and lead per Requirement. With `D` the effective deadline (or the
requirement's own earlier deadline) and `h = 1` hour a day:

```
taskDue(r)      = D − lead(r)
isolated(r)     = taskDue(r) − ceil(effort(r) / h)
prepDays(cycle) = max over curated r of lead(r) + ceil(effort(r) / h)     null (never 0) if none
startBy(r)      = min(isolated(r), capacity-aware latest start)
severity(r)     = late if today > startBy; soon if startBy − today ≤ 14 d; else planned
```

Fixture (S07-012): two letters need 23 days, so a 15 Jan deadline reads "start by 23 Dec".
States: `met`, `in_progress` and `not_applicable` come from the student's progress rows (a
résumé or transcript marked met once counts for every program); `gpa_floor` reads the
evaluator's GPA rules; everything else open is a `gap`, informational kinds are `unknown`.

### Capacity-aware scheduling (`schedule.ts`)

The per-item formula assumes each item has its days to itself. Readiness also plans every open
task across **all** of the student's tracked applications at one capacity: `weeklyHours`
(the profile's `weeklyPrepHours`, else 7 h/week, which equals the plan's 1 h/day so a lone item
keeps exactly its per-item date), spread over 7 days.

- **backwardFill** (reverse-time EDF, as late as possible): walk days backward from the last due
  date; each day's hours go to the unfinished task with the *latest* due date among those due
  after that day. A task's capacity-aware latest start is the earliest day it receives hours;
  hours that land before today are "late". Removing a task or adding hours never moves another
  task's latest start earlier (property-tested).
- **demandBoundCheck** (processor-demand criterion, exact for preemptive single-resource EDF
  with all tasks available now): feasible iff for every due date `d`,
  `Σ effort(due ≤ d) ≤ Σ capacity on [today, d)`. The first violation is the overload warning.
- **levelledLoad** (YDS critical interval): `density = max_d Σ effort(due ≤ d) / (d − today)`,
  the smallest steady load that meets every deadline, shown rounded up to 0.5 h/week.
- **whatFits** (Moore-Hodgson, pinned applications never dropped): the most applications that
  fit; offered as a hint, never applied. Exhaustively checked on small instances.

Study fixture (today 16 Nov 2026, 1 h/day; T1 8 h due 4 Dec, T2 6 h due 11 Dec, T3 20 h due
18 Dec): the per-item formula calls all three "planned"; backwardFill gives T3 28 Nov, T2 22 Nov,
T1 14 Nov (2 h late); demand 34 h vs 32 h by 18 Dec; levelled load 34/32 h/day ≈ 7.5 h/week.

Capacity metrics count a task whose comfortable lead has passed against the deadline itself
(it is already "late", but its hours still need a place before the deadline).

**Suggested start** (shown on next actions): the same fill with effort × 1.5 (planning fallacy:
Buehler et al. 1994 measured 55.5 vs 33.9 predicted days) and comfortable leads; third-party leads
count only available days, skipping Thanksgiving Wednesday-Sunday and 22 Dec-2 Jan (a 21-day lead
before 8 Jan 2027 starts 6 Dec, not 18 Dec). It is clamped to `[today, startBy]` and to the cycle's
opening when that still fits. Severity always comes from the unpadded `startBy`.

## Part 3: competitiveness

Stored band models and the read-time gates that decide whether readiness may use one are in
[bands-store/README.md](bands-store/README.md).

### Official counts first (`odds.ts`)

Only `official_publication` count rows feed odds (owner-reported pools cannot make a program look
less crowded). For consecutive official stages `campus_applicants → applicants → nominees →
finalists → awards` in a year: `k of n`, the year, the source, and a natural frequency:

```
p = k / n
about round(10p) in 10      when p ≥ 0.1          ("about 3 in 10")
about round(100p) in 100    when p < 0.1          ("about 7 in 100")
at most ceil(...)           when n is a lower bound (rounded up so the bound is never understated)
```

Ratio kinds: exact/exact is exact; exact over a lower-bound pool is an upper bound ("at most");
anything else is approximate. An internal 80% Jeffreys interval `Beta(k + ½, n − k + ½)` is kept
for audits (about ±1.5 points at 454 of 1,485) and never shown.

**Funnels.** Stages are shown separately. The program-level product
`P(nominated) × P(award | nominated) = (nominees / pool) × (awards / nominees) = awards / pool`
appears only as that official ratio ("at most 1 in 10 campus applicants won" for Goldwater 2026:
454 of an estimated pool of over 5,000), never as a personal probability. A campus applicant sees
the national stage "if nominated" and "Your campus decides its own nominations; Novus does not
estimate those odds."

Statuses: `official_odds_only` (counts shown), `insufficient_data` (`no_official_counts`,
`new_program`, `sensitive_program`), `not_applicable` (programs that do not select), and
`available` only with a band.

### Level 0: next-cycle official odds (`level0.ts`, program level)

```
ℓ_y = logit((k + ½)/(n + 1)),   v_y = 1/(k + ½) + 1/(n − k + ½)
τ²  = max(0, pooled within-program var of ℓ − mean v)   (programs with ≥ 3 cycles; else 0.09)
w_y = 0.7^age / (τ² + v_y),     θ̂ = Σ w ℓ / Σ w,   Var θ̂ = Σ w²(τ² + v) / (Σ w)²
v_next = 1 / (n̂ p̂ (1 − p̂))     next ~ N(θ̂, Var θ̂ + τ² + v_next)
80% interval = expit(θ̂ ± q·sd),  q = 1.2816, or the split-conformal |z| at rank ⌈(m + 1)·0.8⌉
```

Gate: forward chaining (fit on earlier years, forecast the next; never leave-one-year-out), at
least 60 pooled forecasts, coverage in [0.70, 0.90] and 0.80 inside the 90% Wilson interval.

### Pooling similar programs (`pooling.ts`, priors only)

Outcome-derived rates are selection-biased, so they are never shown as a program's odds; they
serve as priors for unannounced cycles and applicant bounds. Official counts are never shrunk.

```
k_j ~ Bin(n_j, p_j),  p_j ~ Beta(μM, (1 − μ)M),  p(a, b) ∝ (a + b)^(−5/2)  ⇔  p(μ, log M) ∝ M^(−1/2)
```

The hyperposterior is evaluated on a 60 × 60 grid (μ ∈ (0, 1), log M ∈ [−1, 8]); each p_j's
posterior is the grid-weighted Beta mixture, summarized by its 10th/90th percentiles (logit-scale
Simpson integration, Newton inversion). Inputs are Kish-rescaled: `n* = n_eff = (Σw)²/Σw²`,
`k* = (Σ w·y / Σ w)·n_eff`. At least 5 programs per type and stage, else unpooled Jeffreys.
**Prior-data conflict:** a program whose leave-one-out posterior-predictive two-sided p-value is
below 0.05 keeps its own Jeffreys interval. Plug-in empirical Bayes (method of moments) is provided
for comparison only: it treats (a, b) as known and undercovers (0.57 at 5 programs in the same simulation).

Measured (tests): 80% intervals cover 0.797, 0.775 and 0.773 of true rates at 5, 10 and 20
programs (8-40 reports each); an outlier at 0.6 among
peers at 0.25 (40 reports each) is flagged at least 80% of the time.

### Personal bands (`bands.ts`, Phase 4, behind every gate)

A continuation-ratio logit per stage transition, fitted on weighted cell aggregates of verified
reports (never row by row):

```
logit P(pass s | reached s, x) = α_ps + β_s'(x − x̄_ps)
```

- β is shared within one OpportunityType and stage (never per program, never across stages),
  prior `β ~ N(0, 0.5²)` on centred 0/1 columns (lighter-tailed than Cauchy(0, 2.5) on purpose).
- Ordinal features use cumulative indicators `1[level ≥ k]` with non-negative increments
  (projected Newton), so **raising the GPA band never lowers the band**, even if noisy data point
  the other way.
- Tier weights are rescaled to Kish's n_eff; standard errors are robust (sandwich).
- **King-Zeng prior correction** pins each program's intercept to its official stage rate τ:
  `α* = α̂ − ln[((1 − τ)/τ)·(ȳ/(1 − ȳ))]`, with ȳ the tier-weighted admit share among reporters.
  x̄ is the applicant mix recovered with weights τ/ȳ (admits) and (1 − τ)/(1 − ȳ) (others); a
  program passes only if the mix-average probability is within 0.1 logit of τ.
- **The band is decided on the contrast alone** (intercept noise cannot create labels):

```
Δ(x) = β'(x − x̄),   sd = sqrt(max((x − x̄)'Σ_sandwich(x − x̄), (x − x̄)'Σ_posterior(x − x̄)))
above_typical  if Δ − 1.2816·sd >  ln 1.5
below_typical  if Δ + 1.2816·sd < −ln 1.5
typical        otherwise
```

Gates, all required (`bandForStudent`): approval after a shadow cycle; pooled n_eff ≥ 250, van
Houwelingen shrinkage ≥ 0.9 and Riley criterion 1; held-out skill and calibration;
representativeness; fairness; per program n_eff ≥ 30 with ≥ 8 reports of each outcome. A failed
calibration, representativeness or fairness gate shows official odds only; failed skill or
usefulness (< 5% of held-out students non-typical) shows "Same for everyone at this stage".
**Disclosure:** a student whose feature cell has fewer than 10 counted reports reads "typical";
n_eff is shown rounded down to a multiple of 5; model-card coefficients are rounded to 0.05 and
published once per completed cycle.

Copy: "Above typical for nominees." + "Typical here means about 3 in 10 nominees win; most
applicants at this stage are not selected." + "it is not a prediction"; "Below typical" adds
"Many students apply to several programs." Factors carry a direction only (helps, hurts, neutral).
No percentages, no Reach/Target/Safety.

Sample-size formulas (`samplesize.ts`):

```
van Houwelingen   S = (LR χ² − P) / LR χ²                  (S ≥ 0.9 ⇔ χ² ≥ 30 for P = 3)
Cox-Snell         R² = 1 − exp(−LR χ² / n)
Riley crit. 1     n ≥ P / ((S − 1)·ln(1 − R²_adj / S))       P = 3: 240, 525, 1,335 at R² 0.106, 0.05, 0.02
Riley crit. 3     n ≥ (1.96 / δ)² φ(1 − φ)                   met by official counts, not reports
```

### Calibration utilities (`calibration.ts`, offline only)

```
Brier         BS  = Σ w (p − y)² / Σ w
Skill         BSS = 1 − BS / BS_ref,  BS_ref uses the official stage rate τ as everyone's forecast
CORP          BS  = MCB − DSC + UNC with the PAV (isotonic) recalibration (Dimitriadis et al. 2021)
Spiegelhalter z   = Σ w (y − p)(1 − 2p) / sqrt(Σ w² (1 − 2p)² p (1 − p))
Weak calib.   logit P(y) = a + b·logit p  (slope b; intercept with logit p as offset)
AUC           weighted Mann-Whitney, ties count half
```

Plus quantile or uniform reliability bins, two-parameter Platt recalibration (isotonic is for
diagrams only: it overfits below about 1,000 outcomes), log loss and a seeded program-clustered
percentile bootstrap. `heldOutGates`: BSS 90% lower bound > 0, AUC lower bound > 0.6, slope 90%
interval inside [0.5, 1.5], |z| < 1.645. `fairnessGate`: each audit group's calibration gap
`Σw(y − p)/Σw` needs a one-sided 90% upper bound under 0.10; a group too small to assess fails.
Audit groups come from aggregate, non-sensitive data (institution type, selectivity tier).
`observedRateByBand` gives the model card's observed vs predicted rate per band.

## Part 4: next actions (`next-actions.ts`)

Built from nomination steps (confirm an estimated campus date; "Your campus deadline may have
passed: contact your fellowship office today"), eligibility items the student resolves (private
questions stay on the device), checklist gaps (ask recommenders, request a transcript, start by),
letters already requested (a check-in 7 days before they are due), an overload warning and the
submission itself. A closed cycle shows only "follow the program for its next cycle"; a
not-eligible result shows none.

- Dates: gap actions show the suggested start; eligibility questions are due at the first
  suggested start (check before investing effort). Every date is clamped to `[today, deadline]`.
- Severity comes from the hard `startBy`, so the date and the urgency never disagree.
- Order: date shown, then severity, then source (nomination first, since every other date rests
  on the campus deadline), then slack (the hard start), then deadline, then id. Late items all
  show today, so slack orders them, as plan 7.4.2 specifies.
- At most 5 (Tracker detail) or 3 (cards). Each action links to `apply:{programId}:{cycleKey}` or
  `prep:{programId}:{cycleKey}:{requirementId}` (Roadmap item keys) and has a reason code in
  `detail.actionReasons` (`NEXT_ACTION_REASONS`).

## Cycle prediction (`predict.ts`)

`predictCycleEvent(inputs, event, year)` returns p10 / p50 / p90 dates, a label and κ. The first
method that applies wins:

| Method | p50 | 80% width |
|---|---|---|
| official_rule | a Curator-verified rule (fixed date, nth or last weekday, Thanksgiving offset) | 0 restated; 6 and at most medium when carried over |
| inferred_rule | the same rule read from ≥ 3 consistent exact cycles (never 2) | 6, at most medium |
| fixed_date | the two latest midpoints share month and day | 6 + pad |
| seasonal (opt-in) | recency-weighted circular mean of day-of-year, slope prior sd 3 d/yr | Student-t, 2 + n df, 3 pseudo-cycles of type variance |
| weekday_shift | same weekday nearest the same date | 14 (tight) or 42 + pad |
| curator_month | an evidenced month | its first to last day |
| curator_estimate | an unevidenced month | ±7 days, always low |

`pad = 2 × mean half-width` of interval observations; left-censored rows are dropped. Labels:
high ≤ 14 days, medium ≤ 42, else low, capped at medium for every method until it has ≥ 50 scored
predictions with a one-sided 90% Wilson lower bound on coverage ≥ 0.70. `κ = 1 − min(1, width/90)`.
Golden: Goldwater closes 29 Jan 2027 17:00 CT (23:00Z) and reopens 7 Sep 2027; URI's internal
Truman deadline is Thanksgiving + 5 = 1 Dec 2026.

**Calibrated widths:** Mondrian split conformal per method × opportunity type (pooled fallback,
≥ 20 residuals): `Q_lo` = the ⌊(n + 1)·α/2⌋-th and `Q_hi` the ⌈(n + 1)(1 − α/2)⌉-th smallest
residual, `p10 = p50 + Q_lo`, `p90 = p50 + Q_hi`. Interval-censored residual: 0 when p50 is inside
the observed interval, else the signed distance to the nearer edge. Scoring: covered when
[p10, p90] overlaps the observed interval; Gneiting-Raftery interval score
`IS = (u − l) + (2/α)(l − y)⁺ + (2/α)(y − u)⁺` at α = 0.2.

## Simulation results (synthetic, seeded; see the tests)

All synthetic worlds are labelled `synthetic` and use round base rates (0.1-0.35), selective
reporting with admits reporting twice as often, and tiers weighing 0.6, 0.8 and 1.0.

| Check | Result (measured) | Test asserts |
|---|---|---|
| No real effect, 30-300 reports (1,000 replicates each) | ≤ 0.05% of students labelled (all wrongly) | ≤ 1% labelled, ≤ 0.5% wrong |
| Real effect (GPA step 0.7 logit), 30 / 150 / 300 / 600 reports | 0.3% / 15% / 32% / 42% labelled, ≤ 0.02% wrong direction | non-decreasing, ≤ 0.5% wrong |
| King-Zeng with h(1)/h(0) = 2 | pool average within 0.1 logit of τ (≈ 0.69 without) | < 0.1 corrected, > 0.4 uncorrected |
| Held-out gates, calibrated world (50 seeds) | 50/50 pass, mean Brier skill 0.063 | ≥ 85% of seeds |
| Held-out gates, true slope 0.5 (50 seeds) | 45/50 fail | ≥ 80% of seeds |

## Configuration and versions

`config.ts` holds every methodology value (all judgment unless a comment names a source) and
`READINESS_ALGO_VERSION`. Product constants (hours a day, caps, the 14-day "soon" window) come from
shared/config/product.ts. Anti-abuse cut-offs never live in this public module.

## Tests

`npx vitest run shared/readiness`: unit tests per module, seeded property tests (no NaN, schema
validity, dates never after the deadline, monotonicity in hours, progress and GPA band, order
independence, privacy invariance), the band simulations above and the purity checks.
