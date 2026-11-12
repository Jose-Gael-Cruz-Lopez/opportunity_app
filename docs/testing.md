# Testing

Novus has four layers of tests. All of them run on your machine with no Cloudflare account, no
Gemini key and no network calls to real services. Every program in the local database is
**sample data**.

| Layer | Where | Command |
| --- | --- | --- |
| Unit and route tests (TypeScript) | next to the code: `server/**`, `shared/**`, `client/src/**` | `npx vitest run` |
| Infrastructure scripts | `infra/**` | `npx vitest run --config infra/vitest.config.ts` |
| Pipeline (Python) | `pipeline/tests` | `pipeline/.venv/bin/python -m pytest pipeline` |
| End to end (browser) | `e2e/**`, `playwright.config.ts` | `npx playwright test` |

Types: `npm run typecheck` covers the client, shared and server code. The end-to-end suite has its
own project: `npx tsc -p e2e/tsconfig.json`.

See [dev-setup.md](dev-setup.md) for installing the tools.

## End-to-end tests

The suite drives the real product in Google Chrome: the Worker from `server/worker.ts` running
under `wrangler dev`, the built SPA from `dist/public`, a brand-new local D1 database with the
SAMPLE seed, and Better Auth sign-in with emailed codes.

### Requirements

- Node 24 and `npm ci` (installs `@playwright/test` 1.64.1, pinned).
- Google Chrome installed in the usual place. The suite uses Playwright's `chrome` channel, so
  **no Playwright browser download is needed**. To use Playwright's own Chromium instead:
  `npx playwright install chromium`, then run with `E2E_CHANNEL=chromium`.
- Port 8788 free (the suite leaves `npm run dev:worker` on 8787 alone). Change it with
  `E2E_PORT`.

No `.dev.vars` is needed and none is read: the suite writes throwaway secrets for each run.

### Run

```bash
npx playwright test                        # everything, about 1 minute
npx playwright test --project public       # public pages and accessibility only (no sign-in)
npx playwright test e2e/onboarding.spec.ts # one file
npx playwright test -g "four parts"        # tests whose title matches
E2E_HEADED=1 npx playwright test           # watch it in a visible Chrome window
npx playwright test --ui                   # Playwright's UI mode
```

Useful environment variables:

| Variable | Effect |
| --- | --- |
| `E2E_SKIP_BUILD=1` | Skip `vite build` when `dist/public` is already current (saves about 5 s). |
| `E2E_KEEP_SERVER=1` | Leave the Worker running after the run, at `http://localhost:8788`. |
| `E2E_REUSE_SERVER=1` | Run against the Worker a `E2E_KEEP_SERVER=1` run left behind, without rebuilding or reseeding. Good for iterating on one spec. |
| `E2E_PORT` | Port for the Worker (default 8788). |
| `E2E_CHANNEL` | `chrome` (default), `msedge`, or `chromium`. |
| `E2E_HEADED=1` | Show the browser. |

A failing test keeps a screenshot and a trace under `.wrangler/e2e/results/`. Open a trace with
`npx playwright show-trace <path>/trace.zip`.

### What global setup does

`e2e/global-setup.ts` builds a fresh environment for every run. Everything it writes lives in
`.wrangler/e2e/`, which git ignores:

1. `vite build` into `dist/public`, unless `E2E_SKIP_BUILD=1`.
2. Deletes `.wrangler/e2e/` and creates an empty D1 state directory, so a run never touches your
   own local data in `infra/wrangler/.wrangler/state`.
3. Writes `.wrangler/e2e/e2e.vars` with a random `BETTER_AUTH_SECRET` and `INTERNAL_HMAC_KEYS`
   for this run only, `APP_ORIGIN=http://localhost:8788` and `ENVIRONMENT=local`. There is
   **no `GEMINI_API_KEY`**, so every AI feature runs on its deterministic fallback, and the suite
   checks that the page says AI is off.
4. Applies the `novus-main` and `novus-events` migrations with `--persist-to`.
5. Generates the SAMPLE seed with today's date as the anchor
   (`npx tsx server/db/seed/cli.ts sample --today <today>`), so sample deadlines are always in
   the future, and loads it.
6. Starts `wrangler dev --config infra/wrangler/wrangler.toml --persist-to ... --env-file ...
   --port 8788 --test-scheduled`. Its output goes to `.wrangler/e2e/wrangler.log`.
7. Waits for `/readyz`, then fires one scheduler tick (`/__scheduled`) so release 1 is built.

Teardown stops the Worker's whole process group. If a run is interrupted, the next run stops the
stale Worker using `.wrangler/e2e/wrangler.pid`.

### How sign-in codes are read

There is no test-only hook in the Worker. In `wrangler dev`, the `EMAIL` (`send_email`) binding
never sends mail: Miniflare saves each message to a temp file and logs a block like this, which
lands in `.wrangler/e2e/wrangler.log`:

```
send_email binding called with MessageBuilder:
From: Novus <no-reply@localhost>
To: e2e-student-...@example.org
Subject: 123456 is your Novus code
```

`e2e/support/email.ts` finds the newest code sent to an address. Each test signs in with its
own address on the reserved `example.org` domain.

Better Auth allows **2 code sends a minute per IP**, and the D1 store that counts them is new
on every run. The suite sends two codes: the `setup` project and the onboarding spec. If a send
is refused, `signInThroughUi` waits out the window and tries once more.

### What the specs cover

| Spec | Project | Covers |
| --- | --- | --- |
| `e2e/public.spec.ts` | `public` | Landing page: headers (CSP, nosniff), hero, the five doors with live counts, sample labels, closing-soon list. Public Explore: list and server-side search form. Public program page: title, canonical link, eligibility "checked in your browser", requirements, key dates, Track hand-off to the app, a real `.ics` calendar file, the breadcrumb, a 404 for an unknown slug. |
| `e2e/auth.setup.ts` | `setup` | Sign-in through the UI: age step, a bad address refused before any send, the emailed code, a wrong code refused, the real code accepted. A new account lands on `/app/start`. The session cookie is `__Host-novus.session`, `HttpOnly` and `Secure`. Saves the session for `student`. |
| `e2e/onboarding.spec.ts` | `onboarding` | `/app/start` as a newly signed-in student: welcome, the adaptive quiz (answered by question heading, not by position), a pasted resume parsed on the device, the review screen, the redaction preview (no name, email, phone or school in "exactly what AI would read", consent off by default, "AI reading is switched off on this server", Send disabled), matches with a tier and reasons on every card and **no percentage or score anywhere**, the first door with readiness in four parts, the three quick steps (save, eligibility, two sentences), the done screen, "Save my plan" (`POST /api/v1/onboarding/first-door`), `onboarded: true`, and the program on the Tracker. It then checks every request the page sent: no resume contact detail or raw text in any body or URL, and no call to the resume-extract route without consent. Browser storage holds none of it either. |
| `e2e/student.spec.ts` | `student` | Signed in: app Explore and its live search, a program page, readiness as exactly four parts (eligibility rules, the requirements checklist with start-by dates, competitiveness "never a score about you", next actions) with no percentage, the full readiness page, the readiness API body (four parts, no `score`, `percent` or `match` keys), Track, and the Tracker board's Interested column. A retried run untracks first, so the add is always real. |
| `e2e/a11y.spec.ts` | `public` | For nine public and app pages: `lang`, a title, exactly one `h1` and one `main`, no button, link, field, switch or image without an accessible name (read from Chrome's accessibility tree), and no `img` without `alt`. Keyboard only: the skip link is the first Tab stop and moves focus into `main`; app Explore's search is reachable, filters, and a result opens with Enter and shows a focus indicator; the onboarding quiz works with Tab, digits, arrows, Space and Enter, and each new question moves focus to its heading. |

Every test also fails on an uncaught page error or an unexpected console error. The few that
are expected (signed-out 401s from `/api/v1/*`, a rate-limited send, the missing favicon) are
listed in `e2e/support/fixtures.ts`. A single test can allow another with `allowConsoleError`.

### Known issues the suite records

- **Enter in a multi-choice quiz question** (`a11y.spec.ts`, marked `test.fail`). The quiz tip
  says "Enter continues", but the answers are buttons. Enter on a focused answer toggles it, and
  the panel's Enter handler ignores events from buttons
  (`client/src/components/start/quiz-step.tsx`, `onPanelKeyDown`). Keyboard users must Tab to
  Continue. When this is fixed, the test starts passing unexpectedly and Playwright reports it;
  then remove `test.fail`.
- **No favicon.** The SPA shell links `/favicon.png` and browsers request `/favicon.ico`. Both
  return 404.
- **Misleading sample note in matches.** When the live catalogue answers with sample programs
  (always true locally), the matches screen says "The live catalogue isn't reachable from here
  right now". The data did come from the live API; only the sample flag is set.

### Writing a new end-to-end test

- Import `test`, `expect` and the helpers from `e2e/support/fixtures.ts`, not from
  `@playwright/test`, so the console guard and request recorder apply.
- Select by role and accessible name (`getByRole("button", { name: "Track" })`). If a control
  cannot be found that way, that is usually an accessibility bug worth fixing in the app.
- Do not depend on the order of quiz questions or matches. Both adapt to answers and data. Use
  `answerQuizUntil` from `e2e/support/onboarding.ts`.
- Anything shown about a student must pass `expectNoStudentScore` (no `%`, no "percent", no
  match score).
- Use only invented data: `example.org` or `example.com` addresses, "Sample" names, and
  `555-01xx` phone numbers.
- Sign-in costs a code send. Prefer the `student` project's saved session (`storageState`).
  Sign in a new account only when the test needs a fresh one.
