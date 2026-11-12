# shared/matching

Search, order and plain-language reasons for the browser, the Worker and MCP (plan 06). Pure:
no I/O, no storage, no network. Nothing here returns a fit, match or relevance number about a
student, and nothing accepts SensitiveAnswers.

| File | What it does |
| --- | --- |
| `search.ts` | MiniSearch 7.2.0 BM25+ lexical search with aliases, filters and why-shown codes |
| `order.ts`, `timing.ts`, `facets.ts` | Order v0 for Explore (lexicographic keys, weekly rotation, diversity) |
| `why-shown.ts` | Reason codes and their sentences |
| `fusion.ts` | Reciprocal Rank Fusion, k = 60, with optional exposure boosts |
| `embeddings.ts` | Program text for embedding, the release vectors file, int8 decoding, cosine ranking |
| `query-screen.ts` | Decides whether a search query may be embedded at all |
| `hybrid.ts` | `hybridSearch`: lexical + embeddings legs, lexical-only on any failure |
| `dense-release.ts` | `decideDenseRelease`: whether a release ships vectors (alignment and gates) |
| `eval.ts` | Retrieval eval (recall@10, Wilson interval, MRR), lexical-vs-hybrid comparison and gates |
| `exposure.ts` | Merit-weighted exposure boosts (plan 6.6.2) |

## Hybrid retrieval (Phase 3)

MiniSearch stays the lexical leg. The embeddings leg ranks programs by cosine similarity between a
query vector and program vectors. The two rankings are fused with Reciprocal Rank Fusion.

### Reciprocal Rank Fusion, k = 60

`RRF(d) = Σ over legs 1 / (k + rank_leg(d))`, 1-based ranks over each leg's top 50
(`MATCHING_CONFIG.fusion`). k = 60 is the constant Cormack, Clarke and Buettcher (SIGIR 2009) fixed
and found robust across collections. It needs ranks only, so BM25 and cosine scales never need
calibrating. A large k flattens the curve: a program both legs rank 10th (2/70 = 0.0286) beats one
a single leg ranks 1st (1/61 = 0.0164), so agreement between legs wins over one leg's opinion.
Ties keep first-seen order with the lexical leg listed first. Lexical hits past the cut of 50
follow the fused list in lexical order, so paging never loses a lexical result; dense-only hits
past the cut are dropped. The fused values are never stored, returned or shown.

### Reasons stay transparent

Lexical hits keep their field codes (`NAME_MATCH`, `ALIAS_MATCH`, `ORG_MATCH`, `TOPIC_MATCH`). A
program only the embeddings leg found carries the new code `MEANING_MATCH` ("Close in meaning to
your search, though none of your words appear in it."), never a borrowed `TOPIC_MATCH`.

### Exposure boost

`search()` and `hybridSearch()` accept `exposureBoosts` (b_fair from `fairnessBoosts`, in
[0, 0.08]). Each adds `b_fair / (k + 1)` to an id already retrieved: at most 8% of one leg's rank-1
contribution. A boost never adds a result, negative or non-finite boosts are ignored, values above
0.08 are clamped, and at k = 60 a boosted single-leg hit can never pass a hit both legs rank in their
top 10 (1/61 + 0.08/61 = 0.0177 < 0.0286). With no dense ranking and no boosts, the order is the
lexical order, unchanged.

### Where vectors come from

- **Program vectors**: offline, in the pipeline (`pipeline/novus_pipeline/embeddings`), through
  `novus_llm`, from public card text only (`embeddingText`: name, aliases, Organization, type,
  field and topic slugs, summary). Model `gemini-embedding-001`, 768 dimensions (Matryoshka
  truncation, renormalized), task `RETRIEVAL_DOCUMENT`, stored as int8 base64 (about 1 KB per
  program). Each vector carries the SHA-256 of the text it was made from; `alignEmbeddings` keeps a
  vector only while the card's current text hashes the same, so an edited summary never keeps an
  old meaning.
- **Labelled query vectors**: the pipeline also embeds the generated known-item queries (names,
  aliases, scripted misspellings) and any team-written labelled set, keyed by `queryTextHash`.
  They let the release build run the lexical-vs-hybrid gate with no network, and let a search
  that exactly matches one of them use the stored vector with no model call.
- **Student query vectors**: only from the Worker route below, only for screened queries, only
  when a key exists and the AI access gate allows it.

### Query screen

`screenQueryForEmbedding` refuses (and the leg falls back to lexical, never failing the search):
empty or under 3 characters, over 80 characters or 8 words, anything with `@`, a link or a run of
4+ digits, first-person words (I, I'm, me, my...), and status or identity vocabulary
(`SENSITIVE_KEY_STEMS` as word prefixes plus a word and phrase list: DACA, first-gen, low-income,
women, LGBTQ, veteran...). The Worker also runs `server/ai` `mentionsSensitiveTerm` and
`redactStudentText` and refuses when either fires. Refusing costs recall, never privacy.

### Fallback

`hybridSearch` returns `{ results, mode: "hybrid" | "lexical", reason }`. Every failure is exactly
`search()` without a dense ranking: no vectors for the release (`no_index`), no key or AI off
(`no_embedder`), a screened query (the screen's reason), a timeout (800 ms), an error, a vector of
the wrong length (`bad_vector`), or nothing above the cosine floor (`no_dense_hits`, floor 0.55
for `gemini-embedding-001`, judgment to calibrate on the dev half). `mode` and `reason` are
categorical and safe to count; the query is never returned, logged or stored.

### Release

`decideDenseRelease(latestVectorsFile, cards, { labelledQueries })` runs inside `release.build`
with no network and never fails a release. It ships `releases/{n}/embeddings.json` only when:

1. the file aligns: allowlisted model, 768 dimensions, the current text version, and at least 80%
   of shipped cards with a fresh vector (`MATCHING_CONFIG.dense.minCoverage`);
2. at least 20 labelled queries have precomputed vectors;
3. `hybridGate` passes: no recall@10 loss against lexical, MRR at most 0.02 below lexical;
4. hybrid beats lexical on recall@10 or MRR (S08-312: adopted only if it beats MiniSearch).

Generated known-item queries alone cannot satisfy rule 4 (lexical already finds names), so
adoption waits for the team-written dev/test half, which lives with the registry outside the
repository.

### Retrieval evaluation (fixtures)

`hybrid.test.ts` compares lexical and hybrid on the sample cards with a deterministic concept
embedder (`fixtures/concept-embedder.ts`) standing in for Gemini. The stand-in is not a language
model: these numbers test the fusion, gates and fallbacks, not Gemini's quality. Rerun the
comparison with recorded Gemini vectors before turning hybrid on (pipeline README, "Evaluating").

| Set (sample cards) | n | Lexical recall@10 | Hybrid recall@10 | Lexical MRR | Hybrid MRR | Hybrid wins / losses |
| --- | --- | --- | --- | --- | --- | --- |
| Generated known-item | 52 | 1.000 | 1.000 | 1.000 | 0.990 | 0 / 0 |
| Provisional team-written | 25 | 1.000 | 1.000 | 1.000 | 1.000 | 0 / 0 |
| Paraphrase (`fixtures/hybrid-queries.ts`) | 20 | 0.863 | 1.000 | 0.755 | 0.908 | 3 / 0 |
| All | 97 | 0.972 | 1.000 | 0.949 | 0.976 | 3 / 0 |

The one known-item MRR drop is the misspelt "Keystone Software Apprenticceship": the stand-in
cannot read the typo, ranks another software program first, and RRF moves the right program from
1st to 2nd. `hybridGate` tolerates that (within 0.02 MRR, no recall loss); a hybrid that buries
known items fails it (tested).

`fixtures/embedding-parity.json` pins program text, hashes, query normalization, int8 encoding and
scripted misspellings for the Python port; regenerate it from `fixtures/embedding-parity.ts` only
together with the pipeline.
