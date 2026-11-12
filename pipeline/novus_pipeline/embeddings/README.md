# novus_pipeline.embeddings

Offline program vectors for Phase 3 hybrid search (plan 6.5; design and gates in
[shared/matching/README.md](../../../shared/matching/README.md)). Public program text only: the
input is the card list of a published client-core release. Gemini is reached only through
`novus_llm`. With no key, or until `novus_llm` exposes `Gateway.embed` (below), the build writes
nothing and search stays lexical.

```sh
cd pipeline
.venv/bin/python -m novus_pipeline.embeddings status
.venv/bin/python -m novus_pipeline.embeddings build \
    --cards client-core.json --out embeddings.json \
    [--previous embeddings.prev.json] [--queries labelled.json] [--max-new 200] [--upload]
.venv/bin/python -m pytest novus_pipeline/embeddings -q
```

- `--previous` reuses every vector whose model, dimensions, text version and text hash still
  match, so a normal run embeds only programs whose text changed.
- `--queries` is a JSON list of team-written labelled queries (strings or `{ "query": ... }`).
  Generated known-item texts (names, aliases, scripted misspellings) are always added. Never pass
  student queries or logs: none are kept, and none may be.
- `--max-new` caps fresh program embeddings per run (spend guard); the Worker's coverage gate
  (80%) decides whether a partial file is usable.
- `--upload` posts the file to `POST /internal/v1/embeddings` (HMAC, idempotent on the file
  digest). Output is counts only, never text or secrets.

| File | Purpose |
| --- | --- |
| `text.py` | `embedding_text`, hashes, query normalization, `scripted_misspelling`: ports of shared/matching, pinned by `shared/matching/fixtures/embedding-parity.json` |
| `codec.py` | int8 base64 encoding (half away from zero), decoding, cosine |
| `file.py` | `ProgramEmbeddingsFile` (mirrors the zod schema), model and dimension list |
| `embedder.py` | `NovusLlmEmbedder` (adapter over `Gateway.embed`), `embedder_from_env`, `HashingEmbedder` (tests only) |
| `build.py` | `build_embeddings_file`: reuse, batching (50 texts per call), query vectors |
| `upload.py` | `upload_embeddings` over `InternalApi.post` |

## novus_llm contract (to be added in novus_llm by its owner)

`NovusLlmEmbedder` calls, and `status` reports whether it exists:

```python
Gateway.embed(texts: list[str], *, task_type: Literal["RETRIEVAL_DOCUMENT", "RETRIEVAL_QUERY"],
              model: str, dims: int, route_id: str = "embed.program.v1") -> EmbedResult
# EmbedResult: status "ok" | "unavailable" | "killed" | "budget_deferred" | "error";
#              vectors: list[list[float]] | None (one per text, each `dims` long)
```

- Route `embed.program.v1`: data class `public_registry`, its own budget class (e.g. `embeddings`,
  a small monthly cap), kill switch `NOVUS_LLM_KILL=embed.program.v1`, records counts only.
- Embedding model allowlist separate from the generation one: `gemini-embedding-001` with
  dimensions 768, 1536, 3072 (mirrors `file.EMBEDDING_MODELS` and `MATCHING_CONFIG.dense.models`).
- Provider: `GeminiProvider.embed` over google-genai 3.1.0,
  `client.models.embed_content(model=..., contents=texts,
  config=types.EmbedContentConfig(task_type=..., output_dimensionality=dims))`, values from
  `resp.embeddings[i].values`. Same error mapping and no SDK retries as `generate`.
- Price: check the current Gemini price page for `gemini-embedding-001` and add a dated row to
  `prices.py`. At 600 programs of about 120 tokens, a full re-embed is about 72k input tokens.

## Evaluating with Gemini (before turning hybrid on)

1. Build with a billed key: `build --cards client-core.json --queries labelled-dev.json`.
2. Upload; the next `release.build` runs `decideDenseRelease` and logs recall@10 and MRR for both
   legs on every labelled query that has a vector. It ships vectors only if hybrid loses no recall,
   stays within 0.02 MRR and beats lexical on one of them.
3. Calibrate `MATCHING_CONFIG.dense.minSimilarity` on the dev half only; report on the test half.
