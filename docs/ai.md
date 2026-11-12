# AI layer (Google Gemini)

`server/ai` is the only TypeScript code that calls a language model. Python pipeline calls go through `pipeline/novus_llm`. Both use Google Gemini.

The model explains and gives feedback. It never decides anything. Deterministic code decides eligibility, requirement states, competitiveness bands and dates (`shared/eligibility`, `shared/readiness`). Every AI method returns a valid response even when there is no key, so the app works without AI.

## Setup

1. Create a Gemini API key in Google AI Studio, in a project with **billing linked (Tier 1 or higher)**. The free tier may use prompts for product improvement, with human review. Its terms say not to submit personal information. Use a free key only for local development with sample data.
2. Local development: copy `.dev.vars.example` to `.dev.vars` (git-ignored) and set:

   ```
   GEMINI_API_KEY=your-key-here
   GEMINI_MODEL=gemini-3.5-flash-lite
   ```

3. Staging and production: store the key as a Worker secret. Never put it in `wrangler` vars, code or the client bundle.

   ```
   npx wrangler secret put GEMINI_API_KEY --env staging
   npx wrangler secret put GEMINI_API_KEY --env production
   ```

   This repository is public. Google blocks keys reported as leaked (403 "Your API key was reported as leaked").
4. Optional kill switch: set the var `AI_DISABLED=true` to stop every model call. Responses then come back with `meta.status: "unavailable"`.

If `GEMINI_API_KEY` is missing, `createAi(env)` uses a stub that never calls out. Every response is the deterministic fallback, with `meta: { status: "unavailable", degradedReason: "no_api_key", fallback: true }`.

## Using it from a route

```ts
import { createAi } from "@server/ai";

const ai = createAi(c.env);
const viewer = { userId: user.id, birthYearMonth: profile.birthYearMonth };
const gate = ai.checkAccess(viewer); // 18+ only; see "Minimum age" below
const res = await ai.explainReadiness({ viewer, report, profile, request, programSources });
return c.json(res); // always ReadinessExplainResponse, whatever happened
```

| Method | Contract (shared/contracts/ai.ts) | Student data in the prompt |
|---|---|---|
| `explainReadiness` | `ReadinessExplainResponse` | The deterministic report, with sensitive rules reduced to a neutral line, plus allowlisted profile facts |
| `statementFeedback` | `StatementFeedbackResponse` | The redacted statement and essay prompt |
| `ask` | `AskResponse` | The redacted question only (no profile) |
| `extractRequirements` | `RequirementsExtractResult` (server/ai) | None; public page text, for Curators |

Routes should still call `ai.checkAccess(viewer)` first, so they can show the right copy. Every student method also enforces the gate itself.

## Model choice

| Use | Model | Why |
|---|---|---|
| Default (`GEMINI_MODEL`) | `gemini-3.5-flash-lite` | Stable since July 2026. Cheapest current model with structured output and thinking. $0.30 in / $2.50 out per 1M tokens. |
| Availability fallback (hard-coded) | `gemini-3.1-flash-lite` | A different stable model, used once after retries run out, on a 404, on a daily quota or when the circuit is open. No thinking config is sent to it. |
| Pipeline escalation only | `gemini-3.8-flash` | Used when a hard extraction fails validation twice. It rejects `thinking_level: "minimal"`. Its price doubles on 2027-01-01. |

`GEMINI_MODEL` must be on the allowlist in `server/ai/config.ts`. Otherwise the default is used and `ai.model_not_allowlisted` is logged. These are deliberately not on the allowlist:

- `gemini-2.5-*`: rerouted and rebilled on 2026-12-01.
- Preview ids.
- Gemini 4: no free tier, and its price doubles on 2026-12-01.

The model facts were checked on 2026-11-11 at aistudio.google.com/docs/models and /pricing. The old ai.google.dev links now redirect there. Check them again before changing models, and update `MODELS` (capabilities and dated prices) at the same time.

## How a call works

`server/ai/run.ts` runs every feature through one path:

1. **Precheck.** Questions that ask Novus to judge a status or identity criterion are answered without a model (`declined_sensitive`). So is anything with nothing to cite.
2. **Minimum-age gate**, then the **key and kill switch**.
3. **Per-user daily cap.** Taken from `PRODUCT.ai.dailyRequestsPerStudent`.
4. **Build the prompt.** The static system instruction comes first, then the sources, then the deterministic facts, then the student's own data and question. This order keeps the prefix stable for Gemini's implicit cache. Untrusted text sits inside per-request 96-bit nonce fences, and role tags and our own markers are stripped from it.
5. **Monthly route cap.** The cost is estimated before the call at the dearest model in the chain.
6. **Transport** (`server/ai/gemini.ts`). Plain `fetch` to the Interactions API (`POST /v1beta/interactions`). The key goes in the `x-goog-api-key` header. The request sets `store: false`, because this surface stores interactions by default for 55 days on paid and 1 day on free; a test checks this. It also sends structured output (`response_format` with a JSON Schema derived from the zod contract), explicit safety thresholds (`block_medium_and_above`) and the per-model thinking level. `generateContent` is implemented behind the same function (`transport: "generate_content"`) if the founders prefer that surface.
7. **Retries** (`server/ai/provider.ts`):
   - Retried with backoff `min(4s, 1s·2^n)·U(0.5,1.5)`, at most 2 retries, inside the route's time budget (about 9 s for student routes): 408, 429 `rate_limit_exceeded`, 5xx and network errors.
   - Go straight to the fallback model: 429 `quota_exceeded`, which resets at midnight Pacific, and 404.
   - Never retried: 400 (schema, `safety`, `jailbreak`, location), 401 and 403.
   - A per-isolate circuit breaker skips a model for 60 s after 5 consecutive availability failures.
8. **Spend.** Each attempt's tokens are written to the ledger. Thinking tokens are billed as output, and cached tokens are priced as input, which is conservative.
9. **Validation** (`server/ai/validate.ts`): JSON and zod, then route checks:
   - Cited ids must exist.
   - Excerpts must be verbatim.
   - Any date must appear in a source.
   - No score, percentage, rating, grade or chance about the student.
   - Lengths are clamped, because Gemini ignores `maxLength`.

   A failure is retried once with the issues appended. After that the deterministic fallback is used, with `degradedReason: "validation_failed"` or `"citation_check_failed"`.

## Privacy rules

- **SensitiveAnswers never reach a prompt.**
  - No server schema accepts them.
  - `server/ai/allowlist.ts` copies only named profile fields: class year, graduation term, institution level, enrollment, transfer intent, major family and CIP, interest tags, preferred types, prior experience kinds, weekly prep hours, and GPA band only when the program states a GPA rule.
  - `assertPromptSafe` throws on any status or identity key.
- **Readiness reports** are rendered with every sensitive rule and pending item reduced to "checked only on the student's device". There is no dimension, verdict or text. The overall status is withheld if sensitive answers were ever evaluated.
- **Free text** (statements, questions, interest tags) goes through `redactStudentText` before it is placed in a prompt:
  - It masks emails, phones, links, SSN and A-numbers, street addresses, "my name is ...", and a deny-list of status and identity vocabulary.
  - Interest tags that touch the vocabulary are dropped.
  - The deny-list over-masks on purpose. The privacy owner should review it.
- **Logs** carry event names, route, model, HTTP status, error code, counts and cost only. They never carry prompt text, output text or error messages. Tests assert this.
- **Embeddings:** student text is never embedded.

## Minimum age (needs a founder and counsel decision)

The Gemini API Additional Terms (effective 2026-03-23) say "You must be 18 years of age or older to use the APIs". They also bar use in a service "directed towards or is likely to be accessed by individuals under the age of 18".

- Until the founders decide, `ai.minAge` is 18. Only students whose `birthYearMonth` shows them certainly 18 get model output. We assume the birthday is the last day of the birth month.
- Unknown age, under 18 and minor mode all get the deterministic output (`degradedReason: "disabled"`), which already shows all four readiness parts.
- The wider point, that the app as a whole may be "likely to be accessed" by minors, is not solved by this gate. Options include an 18+ attestation for all AI features or Vertex AI's enterprise terms; we have not checked whether those terms carry the same clause.

## Region

Gemini rejects some locations with 400 "User location is not supported for the API use". Workers run at the colo nearest the user. Pin the Worker with `[placement] region = "gcp:us-central1"` in wrangler config, and confirm with the `cf-placement` header in staging. That header is the only confirmation that outbound fetches leave from there.

## Spend and caps

- Per route, per month, in micro-USD (judgment; revisit after a month of data): readiness, statement feedback and ask $15 each, requirements extraction $10. Over the cap, the route returns the fallback with `budget_exceeded`.
- Per student, per day: the caps in `PRODUCT.ai.dailyRequestsPerStudent` (30, 10 and 30).
- Storage: D1 `EVENTS_DB` tables `ai_spend_monthly` and `ai_user_daily`. The DDL is in `AI_LEDGER_DDL` in `server/ai/ledger.ts`, and the schema owner adds the migration. `user_key` is a SHA-256 of the user id. Prune rows older than 7 days with `pruneUserDailySql`.
- If D1 fails, an in-isolate memory ledger still bounds spend. Google Cloud billing alerts are the hard backstop.
- Rough cost of one readiness explanation on flash-lite: 3k tokens in and 400 out, about $0.002.
- Per-project rate limits (RPM, TPM, RPD) appear only in AI Studio. Read them there after billing is linked.

## Tests

```
npx vitest run server/ai
```

The tests make no network calls:

- `createMockProvider` scripts model outputs.
- `fixtures/recorded/*.json` are hand-written in the documented Interactions, generateContent and error response shapes. They were not captured from the live API, so before launch check one real staging response against them.
- `fixtures/sample.ts` is labelled sample data on example.org.
