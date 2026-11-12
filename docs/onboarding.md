# Onboarding: five minutes to matches, then a first application

`/app/start` is Novus's first-run experience. It borrows the idea from Duolingo's onboarding, where you practise during the first session. In about five minutes a first- or second-year student reaches their matches, and about four minutes later has started one application. Along the way the student:

1. answers a short quiz about what they want,
2. adds a resume (PDF, Word or pasted text), read **on their own device**,
3. sees the programs that fit them best, as tiers with plain reasons,
4. picks one program and finishes the first real steps toward applying.

No account is needed until the student chooses to save their plan.

## Where the code lives

| Path | What it holds |
| --- | --- |
| `client/src/pages/start/index.tsx` | The page (default export). It runs the stage machine, autosave and wiring. Integration serves it at `/app/start` and redirects `/app/onboarding` there. |
| `client/src/components/start/` | Screens (`*-step.tsx`, `door-panels.tsx`), the Ember styles (`start.css`) and pure helpers, each with tests. |
| `client/src/components/start/engine.ts` | The one seam to `@shared/onboarding` (quiz, matching, first door, plan). |
| `client/src/components/start/resume-engine.ts` | The one seam to `@shared/resume` (parse, redact, signals). |
| `client/src/components/start/readers/` | On-device PDF and DOCX readers that output `ResumeLine[]`. |
| `client/src/components/start/fixtures.ts` | SAMPLE programs, used when the catalogue API is unreachable. |
| `shared/onboarding`, `shared/resume`, `server/api/v1/onboarding` | Built in parallel. This page only calls them through the seams and the HTTP routes. |

## The flow

| Stage | Budget | What happens |
| --- | --- | --- |
| Welcome | 15 s | The screen says what the student gets: matches in about five minutes, then about four minutes of first steps. A saved session offers "Pick up where you left off". |
| Quiz | 3.5 min, including the resume | One question per screen. Keys 1-9 pick an option, Enter continues, Backspace goes back. Every question can be skipped. The order and the adaptive "this or that" pairs come from `@shared/onboarding`'s `nextQuestion`. |
| Resume (the quiz's third step) | inside the quiz | The student uploads, pastes, or uses "I don't have one", which asks three quick questions instead. The parsed fields are shown for correction. A preview shows the exact text AI would read. AI reading is **off by default**. Afterwards the quiz continues, and questions the resume answered show as "Is this right?" confirmations. |
| Matches | 30 s | Three matches show first, then "See more". Each card has a tier, 2-3 reasons, a start-by line, "You meet N of M listed requirements" and "Why this?". Filters cover tier, paid only, remote and category. An empty or failed result always offers a way on: "Widen my search" (skips the paid-only, location and timing answers and clears filters), "Change my answers" (reopens the last question), "Try again" and "Browse Explore". |
| First door | 4 min | The student picks one of up to three options; Novus never picks automatically. Readiness shows in four parts. Three quick steps fit the budget (save 1 min, eligibility 1 min, two sentences 2 min); `flow.test.ts` checks that the planner's quick-step minutes fit `STAGE_BUDGET_SECONDS.door`. Nomination email, recommenders, a reminder (with an `.ics` file) and opening the application are dated steps: optional now, and they reach the roadmap and reminders when skipped. `doneDuringOnboarding` means "can be done now", never "was done"; completion comes only from the student's `completedStepIds`. The draft can be copied, downloaded as `.txt`, or kept on this device by opt-in. |
| Done | – | A short celebration, "N/M steps done", the next step's date, "Open the official application" and a soft "Save your plan" sign-up wall. |

The progress bar starts partly filled (endowed progress). The "About N min left" estimate is computed from the budgets in `flow.ts`; a test checks that welcome, quiz and matches fit in 300 seconds and that the door budget equals the quick-step minutes. Each stage is a browser history entry, so the system back button steps back inside onboarding (back to a finished quiz reopens the last question). Each new screen sets `document.title` and moves focus to its heading.

## Privacy guarantees (by construction)

- **The resume file and its raw text never leave the device.** Readers take the file into memory, turn it into lines and drop it. Parsed fields live only in React state. Nothing about the resume is written to `localStorage`.
- **Only redacted, allowlisted text can be sent, and only with consent.** The preview shows `redactForAi`'s output, character for character. Placeholders (`[email]`, `[removed]`, ...) are highlighted. A device-only list ("What was taken out, only you can see this") shows what was removed. The text is sent only when the student turns on "Let AI read this text" **and** presses "Send this text". The request body is `{ redactedText, consent: true }` and nothing else. The server re-runs detectors and answers 422 on any hit: `scanOutgoingText` in `server/api/v1/onboarding/guard.ts` is the union of its own lexicon and `@shared/resume`'s `scanAiText`, and `isCleanTerm` (used on model output) uses the same union. `shared/resume/__fixtures__/leaks.sample.ts` lists every known miss; the device tests and the route test both run it. If redaction throws, the page fails closed: nothing can be sent.
- **Sensitive answers stay in memory.** The private eligibility questions (citizenship, Pell, first-generation) appear only when the chosen program's rules need them. The quiz's device-only question (`target`) is handled the same way. Both are evaluated in the browser by a three-valued evaluator in `readiness-view.ts`, which never turns an unknown into "eligible". They are never autosaved or sent, and the view never repeats the answer.
- **The draft stays local.** The "Why this program?" text is never sent. It lives in memory, unless the student turns on "Keep my draft on this device", which stores only that text under its own key (`novus.start.draft.v1`); turning it off or "Forget this on my device" removes it.
- **Autosave has an allowlist.** `storage.ts` keeps only the stage, non-private quiz answers, the chosen program id, finished step ids, filters and the reminder slot. It sanitizes on every write and on every read. It also drops any question id that looks sensitive (`isSensitiveKey`) and anything the quiz marks device-only. "Forget this on my device" clears it.
- **Third-party names stay local.** A recommender's name is optional, typed into memory only and used only in the email template the student copies.
- **No score about the student.** Matches show a tier (`Strong fit`, `Good fit`, `Stretch: worth a try`), plain reasons and counts. The normalizers drop any numeric field an engine might add. Tests check outputs against `FORBIDDEN_STUDENT_SCORE_FIELDS` and reject `%` values.
- **Network calls.** `GET /onboarding/state` reports the session and whether AI is enabled. `POST /onboarding/quiz` (signed in) sends `toServerPreferences`, which carries no device-only answers. `POST /onboarding/resume/extract` is sent only after consent. `POST /onboarding/first-door` (signed in) runs on "Save my plan". The catalogue uses public `GET /api/v1/programs` and `/programs/:slug`. Bodies are never logged, and error results carry codes only.
- **Without `GEMINI_API_KEY`** everything still works. Parsing, matching and the plan are deterministic and on device. The AI toggle says AI reading is switched off.

## Algorithm overview

Matching runs in the browser through `@shared/onboarding`'s `findMatches`. It is documented in that module. In summary:

- **Hard filters:** eligibility (facet evaluator, or `shared/eligibility` once wired), deadlines that have passed, and starting dates that are no longer feasible.
- **Four ranked lists:** MiniSearch BM25+ lexical match (k=1.2, b=0.7, d=0.5), skill coverage over a normalized skill vocabulary, quiz-preference facets, and feasibility slack (days left minus preparation days).
- **Reciprocal Rank Fusion** with k = 60 (Cormack, Clarke and Büttcher, SIGIR 2009). The fused value is internal only.
- **Rule-based tiers.** Tiers come from rules, not from thresholds on the fused value.
- **Diversity within each tier:** Maximal Marginal Relevance with λ = 0.7 (Carbonell and Goldstein, SIGIR 1998), and at most two results per organization.
- **First door:** feasible strong and good items, with quick first steps and 14-60 days left preferred. The student chooses.
- **Plan:** steps derived from the program's requirements and scheduled backward from the deadline (letters 21 days ahead, submission at T-2). These are the same rules as plan 07, so onboarding's start-by matches the Tracker's.

Resume parsing in `@shared/resume` follows the approach OpenResume documents publicly: group text into lines, detect sections, score fields by features. It is original code, because OpenResume is AGPL-3.0 and none of its source was used. Redaction is modelled on Microsoft Presidio's recognizers (MIT). The readers here group PDF text items into lines by y-position and merge fragments closer than the average character width. Bold comes from the real font name, read after `getOperatorList()`.

If the engine throws or is unavailable, the page falls back without inventing tiers. The quiz uses the spec order. The first door takes the first feasible matches. The plan uses a minimal backward schedule (`door-logic.ts`).

## Dependencies (installed)

| Package | Version | License | Use |
| --- | --- | --- | --- |
| `pdfjs-dist` | 6.4.299, legacy build (6.5.438 was under two weeks old; plan 05 asks for ≥ 6.5.438 on a sandboxed origin) | Apache-2.0 | PDF text with positions |
| `mammoth` | 1.13.0 | BSD-2-Clause | DOCX to semantic HTML |

`readers/index.ts` wraps `@shared/resume/readers`: it imports the worker with
`pdfjs-dist/legacy/build/pdf.worker.min.mjs?url` (same origin, never a CDN) and loads both
libraries with dynamic imports, so they are separate chunks fetched only when a student picks a
file. The legacy build is used because the modern one needs very recent engines. Fragments go to
`parseResumeText` unmerged, so two-column layouts are detected there.
`shared/resume/readers/smoke.test.ts` reads SAMPLE PDF (two-column) and DOCX files with the real
libraries.

The PDF reader passes `isEvalSupported: false` (the CVE-2024-4367 mitigation), loads no fonts or cMaps, reads at most 4 pages, rejects files over 5 MB, times out after 10 s, detects scanned PDFs and handles password-protected ones. The DOCX reader parses mammoth's HTML with `DOMParser` into a detached document and never renders it.

## Server side

`/api/v1/onboarding/*` stores answers in the shared vocabulary (`ServerPreferencesSchema`,
`MatchSignalsSchema`), matches with the same `@shared/onboarding` engine over the registry
catalog, and first door creates the TrackerItem, roadmap rows and reminders. Private eligibility
on the device goes through `device-eligibility.ts` (`evaluateWithAnswers`). See
[build-status.md](build-status.md) for the integration notes and the smoke test.

## Data licenses and attributions

- **Sample programs** (`fixtures.ts`) are fictional. Every name starts with "Sample", every URL is on `example.org`, and every card has `isSample: true`. The UI labels them.
- **Skill and field lists** in `shared/onboarding` and `shared/resume` are original to Novus. Their groupings were informed by O*NET's Technology Skills and ESCO's skills pillar, both CC BY 4.0, and no rows were copied. If a list derived from either source ships later, it must carry these notices:
  - O*NET: "This page includes information from the O*NET 31.0 Database by the U.S. Department of Labor, Employment and Training Administration (USDOL/ETA). Used under the CC BY 4.0 license. O*NET® is a trademark of USDOL/ETA. Novus has modified all or some of this information. USDOL/ETA has not approved, endorsed, or tested these modifications."
  - ESCO: "This service uses the ESCO classification of the European Commission" (ESCO v1.2, CC BY 4.0), marked as a modified subset. Check the exact wording against the ESCO FAQ before shipping.
  - Lightcast Open Skills and SkillNER's skill database are deliberately not used, because their terms restrict commercial reuse.
- **Third-party software and references:** MiniSearch (MIT), pdf.js (Apache-2.0), mammoth (BSD-2-Clause), JSON Resume schema 1.7.1 (MIT, shape only), Microsoft Presidio (MIT, used as a reference), OpenResume (AGPL-3.0, documented approach only, no code).

## Tests

```
npx vitest run client/src/components/start
```

These tests cover progress and time budgets, autosave sanitizing, the tolerant normalizers, quiz keyboard and selection rules, the on-device readiness evaluator, backward scheduling, ICS generation, the draft tips and letter templates, filters and wording, PDF line grouping and DOCX walking, the API error mapping, the catalog fallback, fixture validity against the shared contracts, and an end-to-end run through the real `@shared/onboarding` engine. That run goes quiz, then matches, then first door, then plan, with no score fields.
