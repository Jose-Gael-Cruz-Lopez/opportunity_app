# shared/resume

On-device resume parsing, redaction and matching signals for Novus onboarding (`/app/start`).

The resume file and its raw text never leave the device. This module turns them into three
things:

| Output | Where it may go |
| --- | --- |
| `ParsedResume` (JSON Resume–shaped, with contact details and links) | Stays on the device. Shown on the review screen. |
| `redactForAi(parsed).text` | To the server and Gemini, only after the student has seen the exact text and sent `consent: true`. |
| `toProfileSignals(parsed)` | To the matching route. It holds closed-vocabulary values only: no names, sentences, organizations or awards. |

`RedactionItem`, `SensitiveHit` and `PiiHit` hold the student's own words. They are for the
preview on the device and must never be sent, stored, logged or put in analytics.

## Public API (`@shared/resume`)

- `parseResumeText({ text, lines?, now?, hints? }): ParsedResume`. `lines` are reader fragments
  (`ResumeLine`: text, x, y, fontSize, bold, page, plus an optional `width`). `hints` are
  device-only name seeds: the PDF author, the file name, the account name, and link targets from
  the file.
- `redactForAi(parsed | text, { names?, maxChars? }): { text, removed }`. A `ParsedResume` goes
  through the section allowlist. A string is redacted line by line, for pasted or edited text.
- `scanAiText(text)`: the server-side recheck. It returns coarse issue kinds and never echoes text
  or a category.
- `detectSensitive(text)`, `detectPii(text, { names })`, `redactPii`
- `normalizeSkills(raw)`, `mineSkills(text)`, `lookupSkill`
- `toProfileSignals(parsed, { now? })`, `ProfileSignalsSchema` (strict zod, closed vocabularies),
  `inferClassYear`
- `findDates`, `parseDateRange`, `matchMajor`, `normalizeText`

Readers live in `@shared/resume/readers`. The server never imports them, and `index.ts` does
not re-export them.

- `createResumeReaders({ pdf: { workerSrc, loadPdfjs }, docx: { loadMammoth, parseHtml } })`
- `createPdfReader`, `createDocxReader`, `createTextReader`
- Pure helpers: `pdfItemsToLines`, `fragmentsToText`, `docxTreeToLines`, `looksScanned`

## Pipeline

1. **Read**, on the device and ideally in a Web Worker. PDFs use pdfjs-dist and emit one
   fragment per text item. The font name decides bold, and it is read after
   `getOperatorList()`. DOCX uses mammoth `convertToHtml`; the HTML is walked as an inert
   `DOMParser` tree and never rendered. Pasted text skips this step. Every failure returns a typed
   code, and the UI falls back to the paste box.
2. **Normalize** (`text.ts`). This step applies NFKC so ligatures expand, turns private-use
   bullet glyphs into `•`, removes soft hyphens and zero-width marks, reduces the dash and quote
   families to one spelling each, and converts line separators to newlines.
3. **Lay out** (`layout.ts`). Fragments are sorted by page, then top to bottom, then left to
   right. Fragments whose baselines are within half a font size share a row. Neighbours closer
   than the average character width are merged, with that width measured on non-bold items. A
   gutter check handles two-column templates and emits the `two-column-guess` warning.
4. **Section** (`sections.ts`, `lexicon/headings.ts`). The heading lexicon has 198 phrases, with
   one typo allowed in words of six letters or more. Head nouns and visual cues (caps, bold, a
   larger font, a colon, an underline, Markdown `#`) catch unlisted headings. Everything above
   the first heading is the profile.
5. **Split into entries** (`entries.ts`). A new entry starts at a vertical gap wider than 1.4
   times the typical line gap, at a blank line, at a header line that follows bullets, or at a
   second dated header. A line is a bullet when it has a glyph, indentation, an action verb or a
   past-tense sentence shape.
6. **Extract fields** by additive feature scoring:
   - `contact.ts`: name, email, phone, location and links.
   - `education.ts`: school, degree level, major and minor, GPA as written with its scale,
     dates with "Expected", coursework and honors.
   - `experience.ts`: role and organization chosen by head-noun scoring, dates, place, and an
     entry kind (internship, research, job, part-time, leadership, club, volunteer, teaching,
     insight, competition).
   - `projects.ts`: name, description and tools.
   - `lists.ts`: skills, coursework and awards.
   - `dates.ts`: a closed date grammar whose output is JSON Resume iso8601 (`YYYY`, `YYYY-MM`
     or `YYYY-MM-DD`).
7. **Redact for AI** (`redact.ts`). Only these parts are sent:
   - field of study, degree level and graduation year
   - role titles and bullets of experience, research, activity and volunteer entries
   - project names, bullets and tools
   - skills

   Names, contact details, links, schools, organizations, awards, GPA, coursework, summaries,
   publications and references stay on the device. A sensitive statement removes its whole
   unit. For an entry, that is the role, the organization and every bullet. The removal leaves
   one neutral `[removed]`, and adjacent removals collapse. Contact details become `[email]`,
   `[phone]`, `[link]`, `[address]`, `[id]` and `[name]`. A final gate re-runs every detector
   over the finished text.
8. **Signals** (`signals.ts`). Signals carry:
   - curated skill names
   - major families and canonical majors
   - coursework keywords
   - experience kinds from the taxonomy (club membership is not counted as leadership)
   - degree level and graduation year
   - the class year, inferred from the graduation date's academic year (August rollover), or
     taken from an explicit "Sophomore"
   - the number of experience months, with overlaps counted once

   On 2026-11-11 a class of 2030 is first-year and a class of 2029 is second-year.

## Privacy rules this module enforces

- No category label appears in outgoing text or in `RedactionItem`. Every sensitive removal
  gives the same reason, `SENSITIVE_REASON`, which names no category.
- Contact details listed in `removed` have an empty `placeholder`. They were never put into the
  text.
- `ProfileSignalsSchema` is `.strict()` and enum-only for skills, majors and coursework. A
  free-text value such as a name, an organization or "Intro to Islam" fails validation.
- Readers never fetch anything. pdf.js runs with `isEvalSupported: false`, no font faces, no
  system fonts, no cMap or standard-font URLs, and a worker URL the caller must supply from the
  same origin. Without that URL the reader reports `reader-unavailable`. Library messages are
  reduced to typed warning codes because they can quote the document.

## Wiring the readers

Installed: `pdfjs-dist@6.4.299` and `mammoth@1.13.0` (pdfjs-dist 6.5.438 was released on
2026-11-01, less than two weeks before, so it is not used yet). The client wires them in
`client/src/components/start/readers/index.ts` with pdf.js's **legacy** build
(`pdfjs-dist/legacy/build/pdf.mjs` and its worker), because the modern build needs very recent
engines. The pattern:

```ts
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { createResumeReaders, READER_MESSAGES } from "@shared/resume/readers";

const readers = createResumeReaders({
  pdf: { workerSrc, loadPdfjs: () => import("pdfjs-dist") },
  docx: { loadMammoth: () => import("mammoth").then((m) => m.default ?? m) },
});
```

Pass `result.lines` straight to `parseResumeText`. Do not pre-merge rows: the layout step needs
fragment-level x and width to detect two-column templates. Drop the ArrayBuffer after reading.
If a parsed resume is kept, put it in IndexedDB behind a visible "Forget my resume" control,
never in localStorage.

## Evaluation (SAMPLE data, `__fixtures__/`)

All fixtures are invented and labelled SAMPLE:

- emails at example.com or example.edu
- US phones in the 555-01xx range, which is reserved for fiction
- a UK number in Ofcom's drama range
- fictional street addresses

The tuned suite (`resumes.sample.ts`) has 10 resumes:

- pasted text with caps headings and pipes
- Markdown
- a single-column PDF with right-aligned dates
- a two-column PDF
- a table-based DOCX
- a high school senior with education placed last
- sensitive statements mixed with confounders
- a Canva-style PDF split into glyphs, with private-use bullets and a ligature
- obfuscated contact details with a non-Anglo name
- the onboarding mini builder's output

The held-out suite (`holdout.sample.ts`) has 4 resumes, written after tuning:

- a Google Docs export
- a research CV with numeric dates and publications
- colon headings with no blank lines
- a PDF whose headings differ only by size, with dates on the left

Measured with `npx vitest run shared/resume` on 2026-11-11:

| Measure | Result |
| --- | --- |
| Tuned suite, all fields (246 field instances) | P = 1.000, R = 1.000 |
| Held-out suite, first run before any fix (101 instances) | P = 0.950, R = 0.950 |
| Held-out suite after fixing the general bugs it exposed | P = 0.990, R = 0.990 |
| Redaction leaks: 14 resumes × 2 modes (allowlist, text) | 0 (emails, phones, addresses, names, sensitive terms) |
| Sensitive recall on 57 statements, 3+ for each of 14 categories | 1.000 |
| False positives on 46 benign look-alikes (Old Navy, React Native, double-blind and others) | 1 / 46 = 2.2% |
| Date grammar | 55 forms and 14 negatives, all passing |

The first held-out run exposed three bugs: a run of spaces read as part of a city name, an
institution cell that ran on past a comma, and a "Name:" label left on the name. The one
remaining held-out miss is a vocabulary choice: "social media" maps to "Social Media Marketing".

CI gates in `parse.test.ts` and `redact.test.ts`:

- contact, education and experience fields reach precision and recall of at least 0.95
- institution, degree and graduation date each reach F1 of at least 0.9
- the held-out suite reaches at least 0.95
- redaction lets nothing leak
- every sensitive statement in the set is caught
- the confounder false-positive rate stays at or under 5%

Real resumes, used with consent, stay local, are never committed, and serve only for manual
spot checks.

## Known limits

- Scanned PDFs have no text layer. The reader returns `scanned-pdf` and the student pastes the
  text instead; OCR is deferred.
- DOCX headers and footers are not read, which is mammoth's limit. Text boxes come after their
  anchor paragraph.
- The sensitive lexicon is explicit and auditable, not exhaustive. Extend it, with a test, every
  time a case is missed. Recall is preferred over precision: a false positive costs one line of
  AI help, while a miss would send a protected trait.
- Name redaction relies on seeds from the document (the name line, PDF author, file name, email
  and profile slugs, the account name) and on honorific, role-label and author-list patterns.
  There is no NER, so another person's name with no honorific ("worked with Sam Okoro") is not
  caught unless the caller passes it in `names`.
- "City, ST" inside a bullet is redacted as an address, which favours recall.

## Sources and licenses

- **OpenResume parser write-up** (<https://www.open-resume.com/resume-parser>). The documented
  approach was used as a design reference: items to lines, the average-character-width merge,
  feature scoring, the 1.4× subsection gap, and the name-scoring weights. The OpenResume code is
  AGPL-3.0. None of its source or feature tables was copied; everything here is original.
- **JSON Resume schema 1.7.1** (MIT, <https://github.com/jsonresume/resume-schema>). Its shape
  and iso8601 date pattern were followed, with renames and Novus extensions. There is no runtime
  dependency.
- **Microsoft Presidio** (MIT, <https://github.com/microsoft/presidio>). It was a design
  reference for pattern-plus-validator recognizers, SSN validity rules and context words. The
  patterns here were written for this module, and no Presidio code was ported.
- **NegEx**, from Chapman et al. 2001, *J. Biomed. Inform.* 34(5), doi:10.1006/jbin.2001.1029.
  It is the model for the sensitive lexicon's context windows and exclusions.
- **Wilson and Caliskan**, AIES 2024 (arXiv:2407.20371). This study of name-based bias in
  retrieval is the reason names and institutions never reach the AI.
- **Skills list** (`lexicon/skills.ts`: 332 skills, 301 aliases). It is Novus's own list. Its
  categories were informed by the groupings in O*NET Technology Skills and ESCO's skills pillar.
  No rows, codes or descriptions were copied from either. Acknowledged:
  - O*NET® is a trademark of USDOL/ETA. The O*NET database is © USDOL/ETA under CC BY 4.0
    (<https://www.onetcenter.org/database.html>).
  - ESCO is © European Union under CC BY 4.0 (<https://esco.ec.europa.eu>).

  If rows from either are ever imported, that file must carry the attribution and a statement
  of changes.
- **Majors** (`lexicon/majors.ts`, 80 entries) map to shared/taxonomy's major families. That
  crosswalk follows CIP 2020, an NCES publication and a US government work in the public domain.
  Identity-related fields of study map to neutral canonical names.
- **Heading lexicon, coursework keywords (79), role vocabulary and sensitive rules (94)** are
  Novus's own lists.
- **pdfjs-dist** (Apache-2.0, <https://github.com/mozilla/pdf.js>) and **mammoth** (BSD-2-Clause,
  <https://github.com/mwilliamson/mammoth.js>) are loaded at runtime through the reader adapters
  and are not vendored.
