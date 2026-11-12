# server/services/reminders

The two hourly cron kinds that turn followed program cycles into scheduled mail (plan 01 F-08,
plan 02 2.3.7 and 2.3.11, plan 06 6.7.1-6.7.3), plus the pure rules they share.

| File | What it does |
| --- | --- |
| `policy.ts` | Timing rules: sending zone (profile, then Institution, else the 22:30 UTC rule), quiet hours (sends move earlier, never later), spread weekday `hash(id) mod 7`, ISO week keys, the weekly window, the T−2 merge rule, lateness. Pure. |
| `plan.ts` | Reminder drafts per recipient and cycle: T−2 at 09:00 local on the effective deadline (campus date, E1, E2 or national, from `shared/readiness` `resolveEffectiveDeadline`), "Confirm your campus deadline now" the day after E1 passes, and first-door plan steps from `reminders` rows. Neutral copy for status-defined programs and recipients who chose no names. Pure. |
| `weekly.ts` | The weekly email composer: deadlines and requirement start-by dates in the next 14 days, merged T−2 items, and change alerts that waited for the weekly email. Plain text plus minimal HTML; no tracking pixel, no remote images. Pure. |
| `store.ts` | D1 reads and writes (audience, settings, cycle facts, progress, step reminders, the weekly record). |
| `schedule.ts` | `reminders.schedule`: writes due reminders as `deadline.reminder` Alerts at their exact send instant; `notify.dispatch` sends them on the tick with every send-time rule. |
| `digest.ts` | `digest.send`: sends the weekly email itself on the digest stream with RFC 8058 one-click unsubscribe for the `weekly` list. |
| `context.ts` | Builds a recipient's sending context from an audience row and their settings. |

Job adapters: `server/jobs/kinds/reminders-schedule.ts`, `server/jobs/kinds/digest-send.ts`.

## Who gets what

- **Audience.** Live tracker items with status `interested` or `applying`; account Remind-me
  subscriptions for cycles the account does not track; confirmed Contacts' Remind-me
  subscriptions (`delete_after IS NULL`). A tracked status of `submitted`, `decided` or
  `not_applying` stops every reminder for that cycle.
- **T−2.** 09:00 local two days before the effective deadline, keyed
  `t2:{deadlineId or step:cycleId}:{date}`, so a revision that keeps the date never re-sends and a
  moved date gets a new reminder. Written up to one hour ahead with `scheduled_for` at the send
  instant (dispatch never sends before it). Not sent for an item tracked after its send time, for
  month-only, rolling or predicted deadlines, or once the deadline has passed.
- **Campus confirmation.** One P1 message the day after E1 passes for nomination-gated cycles
  with no known campus date (`campus:{cycleId}:{e1}`).
- **Plan steps.** `reminders` rows from onboarding's first door: sent at their local date and
  time (moved out of quiet hours), cancelled once the application is no longer being prepared
  or the row is more than 24 hours late.
- **Weekly email.** On the recipient's weekly day (`notification_prefs.weekly_day`, else the
  spread day) from 18:00 local until quiet hours begin, or from 09:00 when a T−2 falls that day
  (the T−2 then rides in it instead of going separately). "That day" is the recipient's local
  date of the T−2's actual send instant (quiet hours can move it to the evening before), and the
  planner and the email use the same date. A sent weekly email records each T−2 it carried as an
  Alert under the T−2's own key with an already-sent Notification; `reminders.schedule` skips
  exactly those, and sends any other merged T−2 on its own once the weekly email went without
  it, failed, expired, or is more than 2 hours late (`MERGE_GRACE_MS`). Skipped when empty; off with `weekly_email` or the email channel; held by
  the exam pause; held at 50% of the daily quota unless it carries a T−2; suppressed addresses
  are marked and skipped. One per recipient and ISO week: the record is an Alert
  `weekly:{isoWeek}` (visible in the notification center) with a digest-stream Notification
  that `notify.dispatch` never sends; the provider key is `digest:{hmac(recipient)}:{isoWeek}`.
  Without `BETTER_AUTH_SECRET` the kind defers, so no weekly email ever goes out without its
  unsubscribe link.
- **Contacts** have no stored zone yet, so their mail goes at 22:30 UTC (between 08:00 and 22:00
  in every US zone) and deadlines resolve in America/New_York.

## Privacy

Reads public registry facts and each recipient's own settings only. No SensitiveAnswers, résumé
text or eligibility answers are read; sensitive rules are never evaluated here. Copy for
`sensitive_audience` programs, and for recipients with `name_in_messages = 0`, names no program,
slug or official host. Logs carry counts only.

## Known gaps (listed for the owners of the shared pieces)

- `contacts.time_zone` (plan 6.7.1) does not exist, so Contacts use the no-zone rule.
- Per-cycle reminder opt-out for tracked items needs a column; the `cycle_reminders`
  unsubscribe list removes Remind-me subscriptions only.
- Minor mode for Remind-me (16-17) needs a column; the route refuses under-16 when the form sends
  `birthYearMonth`.
- The weekly email does not yet pause on a 0.1% complaint rate or show `cycle.predicted_soon`
  and peer lines (plan 6.7.3, Phase 2 flags).
- The audience is loaded in one pass per run; past about 20,000 followed items it should page by
  recipient key across runs.
