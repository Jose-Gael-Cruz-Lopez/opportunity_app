"""Builds the release vectors file from the public release cards (offline, in the pipeline).

Input: the cards of a published client-core release (public program text only). Output: a
ProgramEmbeddingsFile the Worker aligns with each new release (shared/matching/dense-release.ts).

- Vectors are reused from the previous file whenever model, dimensions, text version and the
  program's text hash all match, so a normal day embeds only programs whose text changed.
- Query vectors are made only for labelled eval queries: generated known-item texts (names,
  aliases, scripted misspellings) and a team-written set the operator passes in. Never for student
  queries; those are embedded at search time by the Worker, if at all.
- Sample cards (`isSample`) are embedded like any other: they are fictional and public.
- Nothing is logged except counts.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from .codec import encode_int8
from .embedder import Embedder, EmbeddingError
from .file import DOC_TASK, EMBEDDING_MODELS, QUERY_TASK, ProgramEmbeddingsFile, ProgramVector, QueryVector
from .text import TEXT_VERSION, embedding_text, embedding_text_hash, known_item_query_texts, normalize_query_text, query_text_hash

log = logging.getLogger("novus_pipeline.embeddings")

# Texts per provider call (judgment; under the API's per-request item limit).
BATCH_SIZE = 50


@dataclass
class BuildStats:
    programs: int = 0
    reused: int = 0
    embedded: int = 0
    skipped_over_limit: int = 0
    queries: int = 0
    queries_reused: int = 0
    queries_embedded: int = 0
    calls: int = 0
    notes: list[str] = field(default_factory=list)


def _batches(items: Sequence[Any], size: int) -> Iterable[Sequence[Any]]:
    for i in range(0, len(items), size):
        yield items[i : i + size]


def _reusable(previous: ProgramEmbeddingsFile | None, model: str, dims: int) -> ProgramEmbeddingsFile | None:
    if previous is None:
        return None
    if previous.model != model or previous.dims != dims or previous.textVersion != TEXT_VERSION:
        return None
    return previous


def build_embeddings_file(
    cards: Sequence[Mapping[str, Any]],
    embedder: Embedder,
    *,
    previous: ProgramEmbeddingsFile | None = None,
    labelled_queries: Sequence[str] = (),
    include_known_items: bool = True,
    source_release: int | None = None,
    max_new: int | None = None,
    now: datetime | None = None,
    batch_size: int = BATCH_SIZE,
) -> tuple[ProgramEmbeddingsFile, BuildStats]:
    """Embeds what changed and returns the full file plus counts.

    `max_new` caps fresh program embeddings per run (a spend guard); programs over the cap keep no
    vector this run and are picked up next time. The Worker's coverage gate decides whether a
    partial file is usable.
    """
    model, dims = embedder.model, embedder.dims
    if model in EMBEDDING_MODELS and dims not in EMBEDDING_MODELS[model]:
        raise ValueError(f"{model} does not offer {dims} dimensions")
    stats = BuildStats()
    reuse = _reusable(previous, model, dims)
    old_programs = {(p.id, p.textHash): p.v for p in reuse.programs} if reuse else {}
    old_queries = {q.textHash: q.v for q in reuse.queries} if reuse else {}

    programs: list[ProgramVector] = []
    todo: list[tuple[str, str, str]] = []  # (id, textHash, text)
    seen: set[str] = set()
    for card in cards:
        pid = str(card.get("programCycleId", ""))
        if not pid or pid in seen:
            continue
        seen.add(pid)
        stats.programs += 1
        h = embedding_text_hash(card)
        if (pid, h) in old_programs:
            programs.append(ProgramVector(id=pid, textHash=h, v=old_programs[(pid, h)]))
            stats.reused += 1
        else:
            todo.append((pid, h, embedding_text(card)))
    if max_new is not None and len(todo) > max_new:
        stats.skipped_over_limit = len(todo) - max_new
        todo = todo[:max_new]

    for batch in _batches(todo, batch_size):
        vectors = embedder.embed([t for _, _, t in batch], task_type=DOC_TASK)
        stats.calls += 1
        if len(vectors) != len(batch):
            raise EmbeddingError("embedding count mismatch")
        for (pid, h, _), vec in zip(batch, vectors, strict=True):
            programs.append(ProgramVector(id=pid, textHash=h, v=encode_int8(vec)))
            stats.embedded += 1

    query_texts = list(known_item_query_texts(cards)) if include_known_items else []
    query_texts += list(labelled_queries)
    queries: list[QueryVector] = []
    q_todo: list[tuple[str, str]] = []
    q_seen: set[str] = set()
    for text in query_texts:
        h = query_text_hash(text)
        if h in q_seen or not text.strip():
            continue
        q_seen.add(h)
        stats.queries += 1
        if h in old_queries:
            queries.append(QueryVector(textHash=h, v=old_queries[h]))
            stats.queries_reused += 1
        else:
            q_todo.append((h, text))
    for batch in _batches(q_todo, batch_size):
        # The normalized text is what the Worker would embed for the same query.
        vectors = embedder.embed([normalize_query_text(t) for _, t in batch], task_type=QUERY_TASK)
        stats.calls += 1
        if len(vectors) != len(batch):
            raise EmbeddingError("embedding count mismatch")
        for (h, _), vec in zip(batch, vectors, strict=True):
            queries.append(QueryVector(textHash=h, v=encode_int8(vec)))
            stats.queries_embedded += 1

    file = ProgramEmbeddingsFile(
        model=model,
        dims=dims,
        textVersion=TEXT_VERSION,
        docTask=DOC_TASK,
        queryTask=QUERY_TASK,
        generatedAt=(now or datetime.now(UTC)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        sourceRelease=source_release,
        programs=sorted(programs, key=lambda p: p.id),
        queries=sorted(queries, key=lambda q: q.textHash),
    )
    log.info(
        "embeddings built",
        extra={"programs": stats.programs, "reused": stats.reused, "embedded": stats.embedded, "queries": stats.queries, "calls": stats.calls},
    )
    return file, stats
