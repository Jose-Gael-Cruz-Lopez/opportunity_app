# server/api/v1/admin/metrics

The founders' metrics view (plan 10.10.3: one admin-only table on `curate.`, aggregates only).
The console page is `client/src/console/metrics/`.

| Route | Auth | Behaviour |
|---|---|---|
| `GET /api/v1/admin/metrics?days=28&weeks=8` | admin | `requireRole("admin")`: 401 signed out, 403 without the role, 403 `second-factor-required` until TOTP, `Cache-Control: no-store`. In staging and production the session must be on the console surface (`curate.`). `days` is 7, 28 or 90 (funnel window); `weeks` is 4 to 26 (retention and engagement series, current week included). Unknown query keys answer 400. |

## What it shows

| Section | Source | Definition |
|---|---|---|
| Activation funnel | `novus-events` `analytics_events`, `onboarding_step` events (`shared/onboarding/analytics.ts`) | Actors whose first `started` falls in the last `days` x 24 h; for each later step, how many of them reached it since. Actor = device id (the telemetry session id, rotated after 30 idle minutes), else user HMAC (onboarding starts before sign-in). `resume_parsed` counts only `ok: true` with a real source (not `none`), i.e. a resume read on the device. It is optional, so the step after it is compared with the quiz. |
| Server cross-check | `novus-main` `onboarding_records` | Records opened in the window: quiz saved (`preferences`), first door chosen (`first_door`), completed. Signed-in students only. |
| Retention by week (not measured today, see Gaps) | `analytics_events` with a user HMAC | Cohort = UTC week (Monday) of the actor's first active event ever; a cell = actors active again in that later week. Active events: `program_view`, `apply_click`, `tracker_add`, `readiness_open`, `ai_explain_open`, `onboarding_step` (page views, searches and filter changes are browsing). The running week is flagged `partial`. |
| Tracker and reminders | `tracker_items`, `reminders` | Per week: items added and students adding, reminders scheduled, sent and cancelled. Now: students with an item, students with an upcoming reminder, items by status, and the share of items that reached `applying` or later with and without a sent reminder (a comparison, not an effect). |
| Registry freshness | `programs`, `program_cycles` | Published, active programs; a program's last verification is the latest `last_verified_at` over its `verified` or `reverifying` cycles. Verified in the last 30 days, median days since verification (target under 14, REQ-022), never verified, age buckets. Sample and non-sample programs are separate slices. |

Counted students: live accounts (`deleted_at` null) with analytics on (`analytics_off_at` null),
not in minor mode, and no live non-student role, so staff test accounts never count. Minor mode
uses `adultFrom()`'s boundary (the start of the month after the birth month, 18 years on); a
profile with no birth month counts, as at ingest. No analytics consent for 16-17 exists, so
minors never count. Events carry the ingest path's guarantees (no rows for sensitive- or
identity-audience programs, nothing under GPC, nothing for an account in minor mode, nothing
after an under-16 answer in the tab); this module only reads them.

## Small cells (`suppress.ts`)

- k = 5. Every student-derived count is a `Cell` `{ n, hidden }`: shown when 0 or at least 5,
  hidden (`n: null`) when 1 to 4. Rates use shown counts only.
- Partitions (Tracker items by status; reminded vs. not reminded items; their progressed
  counts) get complementary suppression: when a hidden cell could be recovered from the total
  (one hidden cell, or several that must all be 1 or all be 4), every non-zero cell is hidden
  and only the total stays. A total under 5 hides the whole table, zeros included.
  `suppress.test.ts` enumerates every three-way table up to 30 and checks that an attacker who
  knows the rule, the released table and even the true total cannot pin any hidden cell.
- Funnel steps and retention weeks are nested counts of pseudonymous actors, suppressed cell by
  cell; a retention cohort under 5 hides its whole row.
- Registry counts describe programs, not people, and are exact.

Nothing returned names a person, device, HMAC, program or answer (the route test greps the body).

## Gaps

- Retention is **not measured**. `POST /api/v1/events` is built, but it stores a
  session-scoped id only and writes `user_hmac` as null on every row by design
  (docs/telemetry.md), so no actor can be followed across weeks. While no row carries a user
  HMAC, the view answers `retention: { measured: false, cohorts: [] }` and the page says "Not
  measured" rather than showing zeros. Founder decision: a consented, keyed user HMAC at ingest,
  or retention derived from novus-main activity (Tracker and reminder rows already counted
  here).
- The funnel actor is the telemetry session id (rotated after 30 idle minutes), not a person.
  An onboarding that spans two browsing sessions reads as a drop-off in the first and a new
  start in the second (the start page sends `started` again when the student picks up). The
  page says so under the funnel.
- Funnel events come from `/app/start` through `trackOnboarding()` (client/src/lib/telemetry),
  built by `onboardingEvent()`; the ingest allowlist accepts exactly that vocabulary (tested by
  piping every shape through the route into `funnelCounts`).
- Minor mode (16-17 by the birth month) is excluded from every novus-main count with the same
  boundary as `adultFrom()`, as at ingest.
- The route is not in `shared/contracts/routes.ts` yet and not mounted (see the registration
  list in the build notes). Once mapped, a `wiring.test.ts` like the Curator one can compare
  against `ROUTES`.
- Not built: the CSV export, `growth.weekly` e-mail, `metric_daily` (Phase 3), sign-ups and
  activation by channel, VEAS, deadlines met, weekly active students across all students
  (needs keyed events), and email click engagement (`emailClick` is unbuilt).
- Raw-event scans: the funnel and retention queries read `analytics_events` in full for the
  onboarding name and active names. Fine at Phase 0-2 volume (plan 10.9.2); Phase 3 moves to
  `metric_daily` aggregates.
