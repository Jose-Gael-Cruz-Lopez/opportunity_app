# `server/pages/islands`: public-page islands

Small scripts that enhance server-rendered public pages. Each page is complete without its
island; the island's markup ships with a no-JavaScript fallback and the interactive part
`hidden`. Islands are served as content-hashed files under `/p/i/` (the public-page CSP allows
no inline script or style), read no cookies, and write nothing to cookies or Web Storage.

## Remind me (`remind-me.tsx`, `remind-me-js.ts`)

The program-page email reminder for visitors without an account (s01 F-08, plan 6.7.1), posting
to the existing `POST /api/v1/remind-me` (server/api/v1/remind).

- **Markup** (`RemindMeIsland`): email, birth month and year (two selects), an explicit opt-in
  checkbox for status- or identity-defined programs (`restricted`), a Turnstile container, a
  status line (`role="status"`) and a confirmation panel. It links its own stylesheet and script,
  so the Program page only renders the component.
- **Script**: shows the form once wired; loads Turnstile only on first focus (config from
  `GET /api/v1/turnstile?action=remind-me`; with Turnstile off it says reminders are unavailable
  and disables the button); runs the age screen on the device first (under 16 sends nothing and
  clears the typed address); posts the request; maps every answer to fixed copy; resets the
  widget after any non-202 (tokens work once); sends one `remind_me_submit` event alone, without
  cookies, with a one-time id and the day only (skipped under GPC); reports its own crashes as a
  content-free error report.
- The birth month goes only to `/api/v1/remind-me`, which never stores it.

Checked in Node (`islands.test.ts`: the pure helpers evaluated without a DOM, age parity with
the server, schema parity with the events and remind routes, markup, assets, CSP) and in the
system Chrome against stubbed endpoints (happy path, under 16, restricted with and without
opt-in, 429 with widget reset, Turnstile off).

## Files

| File | What it holds |
| --- | --- |
| `remind-me.tsx` | `RemindMeIsland` (Hono JSX), `birthYears`. |
| `remind-me-js.ts` | `REMIND_CORE_JS` (pure helpers as one object expression) and `REMIND_JS`. |
| `islands-css.ts` | `ISLANDS_CSS`, built on site.css tokens. |
| `assets.ts` | Hashed paths (`islandAssetPath`), `islandAssetRoutes` (`GET /p/i/:file`), `REMIND_PAGE_CSP`. |

## Registration (done in the wave 4 integration pass)

1. `server/app.ts`: `islandAssetRoutes` sits in `pageRoutes` after the email-link routers and
   before the pages router.
2. `server/pages/views/program.tsx` renders `RemindMeIsland` in the aside above "See something
   wrong?" unless the cycle is `ended` or `paused`.
3. `server/pages/index.tsx` sends `content-security-policy: REMIND_PAGE_CSP` on the Program page.
   Still to verify on staging: Turnstile renders under this policy, which has no
   `'unsafe-inline'` for styles.
