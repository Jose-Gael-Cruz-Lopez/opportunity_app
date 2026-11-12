# Telemetry: first-party events and client error reports

Novus measures itself without a vendor, a pixel, a cookie or an account key. This page explains
what the browser sends, what the Worker keeps, and what it never sees. Plan references: s10
10.9.1-10.9.3 (analytics), s02 2.3.12 (client errors), s09 N11 (Global Privacy Control).

| Part | Where |
| --- | --- |
| `POST /api/v1/events`, `POST /api/v1/error-reports` | [server/api/v1/events](../server/api/v1/events/README.md) |
| SPA and console sender, error boundary hooks | `client/src/lib/telemetry/` |
| Program-page Remind me island (sends one event of its own) | [server/pages/islands](../server/pages/islands/README.md) |
| Tables | `novus-events`: `analytics_events`, `program_daily_counts`, `client_error_daily` (proposed) |

## What is sent

**Events** are batches of `{ name, deviceId, at, path, props }` (`AnalyticsBatchSchema`):

- `name` is one of the ten contract names (`page_view`, `program_view`, `apply_click`,
  `remind_me_submit`, `tracker_add`, `onboarding_step`, `search`, `filter_change`,
  `readiness_open`, `ai_explain_open`).
- `deviceId` carries a **session-scoped id**, the only identifier telemetry ever sends: 22
  random url-safe characters in `sessionStorage` (one tab), replaced after 30 idle minutes. It
  is never a cookie, never in `localStorage`, never derived from or joined to the account. The
  contract field keeps its historical name; a rename to `sessionId` is a contracts change.
- `path` is a route template (`/app/programs/:slug`), computed in the browser and again on the
  server from a closed list; anything unknown is stored as `other`.
- `props` are allowlisted per event: ids, closed codes, small integers, booleans. There is no
  free-text property, so a search query, a filter key, a message, an answer or an address
  cannot be declared. `search` sends only a result-count bucket (`0`, `1-9`, `10+`) computed
  before filters; `filter_change` sends nothing about which filter changed.

| Event | Properties |
| --- | --- |
| `page_view` | `surface` (`public`, `app`, `console`) |
| `program_view`, `apply_click` | `programId`, `cycleId`, `entry` (where the visit started) |
| `remind_me_submit` | `cycleId`, `outcome` (`accepted`, `consent_required`, `rate_limited`, `unavailable`, `verification_failed`, `failed`) |
| `tracker_add` | `programId`, `cycleId`, `source` (`self`, `list`, `email_action`, `onboarding`) |
| `onboarding_step` | `step` (the funnel of `shared/onboarding/analytics.ts`: `started`, `quiz_completed`, `resume_parsed`, `matches_shown`, `first_door_chosen`, `first_step_done`, `tracker_created`) plus only that step's keys, as `onboardingEvent()` builds them: counts (`asked`, `skipped`, `seconds`, `strong`, `good`, `stretch`, `explore`, 0-999), closed codes (`source`, `tier`, `kind`) and flags (`ok`, `relaxed`, `deviceOnly`). The client sends them through `trackOnboarding()` |
| `search` | `resultBucket` |
| `filter_change` | none |
| `readiness_open`, `ai_explain_open` | `cycleId` |

**Client error reports** are `{ kind, surface, errorClass, route, release, browser, file, line,
column }`: the constructor name (`TypeError`), the route template, the build id, a browser family
(`chrome`, `safari`, `firefox`, `edge`, `samsung`, `in_app`, `other`) and the first stack frame
inside a first-party bundle (`/assets/<file>.js` on this origin) as a bare file name with line
and column. Never the message, the stack text, a URL, a query string, component props or state,
and no identifier at all.

## When nothing is sent or stored

| Case | Browser | Worker |
| --- | --- | --- |
| Global Privacy Control (`navigator.globalPrivacyControl`, `Sec-GPC: 1`) | sends nothing | `204`, stores nothing |
| Account with analytics off, or in minor mode | app calls `setTelemetryConsent(false)`: queue dropped, nothing sent | signed-in check: `204`, stores nothing |
| Bot or headless user agent | n/a | `204` |
| A status- or identity-looking key anywhere in the body | event dropped before sending | `400`, stores nothing, alert line |
| Undeclared key or wrong value type | n/a | that event dropped whole (never trimmed and stored) |
| Session outside an event's sample | not sent | dropped |
| Event dated over 24 h ago or 5 min ahead | n/a | dropped |

Minor mode on the server: under 18 by the youngest reading of the profile's birth month. No
analytics consent for 16-17 exists yet (s09 S09-029), so it counts as "No". An account with no
birth month is not treated as a minor.

## Restricted programs (counter path)

Events about a program with `sensitive_audience` or a non-empty `identity_audience` never become
rows. The browser sends each one alone (`track(name, props, { restricted: true })`), with
`credentials: "omit"`, a one-time random id and the start of the UTC day as its time; the
Worker resolves the program, increments `program_daily_counts(program_id, day, event_name, n)`
and stores nothing else. If such an event arrives inside a multi-event batch (a client bug), the
counter still increments, no row is stored and `events.restricted_in_batch` is logged. The
server decides from `programs`, not from the client's flag, so a missing flag cannot leak a row.
The Remind me island sends all its events this way.

## Sampling, limits and batching

- Sampling is per session and per event: FNV-1a of the session id into 10,000 buckets, the same
  function in the browser and the Worker (a shared test vector keeps them equal). Rates (judgment
  at launch volume): 1 for every event except `search` (0.5) and `filter_change` (0.25); stored
  rows carry `sampleRate` when it is below 1, so counts are reweighted as `n / sampleRate`.
  Client errors: every session (`ERROR_SAMPLE_RATE = 1`), at most 5 distinct reports a page and
  20 a session, deduplicated by crash site.
- Batches: at most 20 events and 16 KB; the browser flushes every 5 s, at 20 events, and when the
  page is hidden (`visibilitychange`, `pagehide`), by `navigator.sendBeacon` with a
  `text/plain` body (CORS-safelisted), falling back to `fetch` with `keepalive`.
- Limits (judgment, in-isolate, behind the global per-IP API limit): 60 event batches a minute
  per IP and per session, 2,000 stored events a day per session (the excess is dropped and
  counted), 20 error batches a minute per IP.

## What is stored, and for how long

| Table | Row | Keys | Retention |
| --- | --- | --- | --- |
| `analytics_events` | name, time (to the second), route template, allowlisted props | session id only; `user_hmac` always null | s09 `raw_events` class, 13 months |
| `program_daily_counts` | program, day, event name, count | none | aggregate |
| `client_error_daily` (proposed migration) | day, kind, surface, class, route, release, browser, file, line, count | none | 90 days (judgment) |

Until `client_error_daily` is migrated, each report is a structured `client_error` line in
Workers Logs (7 days), with the same fields.

## Using it in the app

```ts
import { track, setTelemetryConsent, reportBoundaryError, useGlobalErrorCapture, usePageViews, resultBucket } from "@/lib/telemetry";

track("tracker_add", { programId, cycleId, source: "self" });
track("program_view", { programId, entry: "explore" }, { restricted: program.sensitiveAudience || program.identityAudience.length > 0 });
track("search", { resultBucket: resultBucket(textResults.length) });
setTelemetryConsent(!(profile.analyticsOff || profile.minorMode));
```

In an error boundary: `componentDidCatch(error, info) { reportBoundaryError(error, info); }`.
In the app root: `useGlobalErrorCapture("spa")` and `usePageViews(location)`; in the console
root, `useGlobalErrorCapture("console")` and `usePageViews(location, "console")`.

## Wiring (done in the wave 4 integration pass)

- `eventsRoutes` is mounted; route map ids `postEvents` and `clientErrors`; the
  `client_error_daily` migration is `novus-events` 0002, swept after 90 days.
- `PageErrorBoundary.componentDidCatch` calls `reportBoundaryError(error, info)`. `App.tsx`
  renders `TelemetryWiring`: `useGlobalErrorCapture("spa")`, `usePageViews(location)` and
  `setTelemetryConsent(analyticsAllowedFor(session))` (`client/src/lib/telemetry/consent.ts`:
  minor mode by the youngest reading of the birth month). The session payload does not carry the
  account's own "analytics off" switch, so the server enforces that one (204, nothing stored).
  The console root renders `ConsoleTelemetry` (`"console"` surface).
- `vite.config.ts` defines `import.meta.env.VITE_RELEASE` on builds: `VITE_RELEASE` from the
  environment, else the short `GITHUB_SHA`, else `git rev-parse --short HEAD`.
- Icons: `client/index.html`, the console shell and the public-page `<Head>` link the SVG and
  32 px favicons, the apple-touch icon and `/manifest.webmanifest`; `client/public/favicon.ico` is a
  copy of `/icons/favicon.ico`; `isStaticAssetCandidate` allows extensions up to 11 characters.
