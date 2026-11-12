"""Tests for novus_pipeline.embeddings (run: pytest novus_pipeline/embeddings from pipeline/)."""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from novus_pipeline.embeddings import (
    EmbeddingError,
    EmbeddingsUnavailable,
    HashingEmbedder,
    NovusLlmEmbedder,
    ProgramEmbeddingsFile,
    build_embeddings_file,
    cosine,
    decode_int8,
    embedder_from_env,
    embedding_text,
    embedding_text_hash,
    encode_int8,
    known_item_query_texts,
    normalize_query_text,
    query_text_hash,
    scripted_misspelling,
    upload_embeddings,
)
from novus_pipeline.embeddings.__main__ import main as cli_main
from novus_pipeline.embeddings.upload import UPLOAD_PATH

REPO = Path(__file__).resolve().parents[3]
PARITY = json.loads((REPO / "shared/matching/fixtures/embedding-parity.json").read_text(encoding="utf-8"))
NOW = datetime(2026, 11, 11, 12, 0, tzinfo=UTC)


def _cards() -> list[dict[str, Any]]:
    return [{**p["card"], "programCycleId": f"c{i:02d}"} for i, p in enumerate(PARITY["programs"])]


# --- cross-language parity with shared/matching/embeddings.ts -----------------------------------


@pytest.mark.parametrize("entry", PARITY["programs"], ids=lambda e: e["card"]["name"][:30])
def test_program_text_and_hash_match_typescript(entry: dict[str, Any]) -> None:
    assert embedding_text(entry["card"]) == entry["text"]
    assert embedding_text_hash(entry["card"]) == entry["textHash"]


@pytest.mark.parametrize("entry", PARITY["queries"], ids=lambda e: e["normalized"])
def test_query_normalization_and_hash_match_typescript(entry: dict[str, Any]) -> None:
    assert normalize_query_text(entry["query"]) == entry["normalized"]
    assert query_text_hash(entry["query"]) == entry["textHash"]


@pytest.mark.parametrize("entry", PARITY["vectors"], ids=lambda e: e["b64"])
def test_int8_encoding_matches_typescript(entry: dict[str, Any]) -> None:
    assert encode_int8(entry["values"]) == entry["b64"]


@pytest.mark.parametrize("entry", PARITY["misspellings"], ids=lambda e: e["text"][:30])
def test_scripted_misspelling_matches_typescript(entry: dict[str, Any]) -> None:
    assert scripted_misspelling(entry["text"]) == entry["typo"]


# --- codec ------------------------------------------------------------------------------------


def test_codec_round_trips_direction() -> None:
    v = [math.sin(i * 1.7) * (3 if i % 7 == 0 else 1) for i in range(768)]
    back = decode_int8(encode_int8(v), 768)
    assert back is not None
    assert cosine(back, v) > 0.999


def test_codec_rejects_bad_input() -> None:
    assert decode_int8(encode_int8([1.0, 2.0, 3.0]), 4) is None
    assert decode_int8("!!!!", 3) is None
    assert decode_int8(encode_int8([0.0, 0.0, 0.0]), 3) is None
    with pytest.raises(ValueError):
        encode_int8([1.0, float("nan")])


# --- build ------------------------------------------------------------------------------------


def test_build_embeds_programs_and_known_item_queries() -> None:
    emb = HashingEmbedder(dims=64)
    file, stats = build_embeddings_file(_cards(), emb, labelled_queries=["ocean science summer"], now=NOW, source_release=7)
    assert stats.programs == len(PARITY["programs"])
    assert stats.embedded == stats.programs and stats.reused == 0
    assert {p.id for p in file.programs} == {c["programCycleId"] for c in _cards()}
    hashes = {q.textHash for q in file.queries}
    assert query_text_hash("ocean science summer") in hashes
    assert query_text_hash(_cards()[0]["name"]) in hashes
    assert file.sourceRelease == 7 and file.generatedAt == "2026-11-11T12:00:00Z"
    assert file.model == "test-hashing" and file.dims == 64
    ProgramEmbeddingsFile.model_validate(file.to_wire())


def test_build_reuses_unchanged_vectors_and_reembeds_changed_text() -> None:
    emb = HashingEmbedder(dims=64)
    first, _ = build_embeddings_file(_cards(), emb, now=NOW)
    calls = emb.calls
    again, stats = build_embeddings_file(_cards(), emb, previous=first, now=NOW)
    assert emb.calls == calls  # nothing new to embed
    assert stats.reused == stats.programs and stats.queries_reused == stats.queries
    assert again.programs == first.programs

    edited = _cards()
    edited[0] = {**edited[0], "summary": "A different summary."}
    _, stats2 = build_embeddings_file(edited, emb, previous=first, now=NOW)
    assert stats2.embedded == 1 and stats2.reused == stats2.programs - 1


def test_build_does_not_reuse_across_models_or_dimensions() -> None:
    first, _ = build_embeddings_file(_cards(), HashingEmbedder(dims=64), now=NOW)
    _, stats = build_embeddings_file(_cards(), HashingEmbedder(dims=32), previous=first, now=NOW)
    assert stats.reused == 0
    _, stats = build_embeddings_file(_cards(), HashingEmbedder(model="other", dims=64), previous=first, now=NOW)
    assert stats.reused == 0


def test_build_caps_new_embeddings_and_refuses_unoffered_dimensions() -> None:
    _, stats = build_embeddings_file(_cards(), HashingEmbedder(dims=64), max_new=2, include_known_items=False, now=NOW)
    assert stats.embedded == 2 and stats.skipped_over_limit == stats.programs - 2
    with pytest.raises(ValueError):
        build_embeddings_file(_cards(), HashingEmbedder(model="gemini-embedding-001", dims=100), now=NOW)


def test_build_embeds_normalized_query_text_with_query_task() -> None:
    seen: list[tuple[str, tuple[str, ...]]] = []

    class Spy(HashingEmbedder):
        def embed(self, texts, *, task_type):  # type: ignore[no-untyped-def]
            seen.append((task_type, tuple(texts)))
            return super().embed(texts, task_type=task_type)

    build_embeddings_file(_cards()[:1], Spy(dims=16), labelled_queries=["  Ocean  SCIENCE "], include_known_items=False, now=NOW)
    assert seen[0][0] == "RETRIEVAL_DOCUMENT"
    assert seen[1] == ("RETRIEVAL_QUERY", ("ocean science",))


def test_known_item_queries_dedupe_and_include_typos() -> None:
    qs = known_item_query_texts([{"name": "Goldwater Scholarship", "aliases": ["goldwater scholarship", "GW"]}])
    assert qs == ["Goldwater Scholarship", "GW", "Goldwater Scholarrship"]


def test_vectors_file_carries_no_program_text() -> None:
    file, _ = build_embeddings_file(_cards(), HashingEmbedder(dims=64), now=NOW)
    wire = json.dumps(file.to_wire())
    for card in _cards():
        assert card["name"] not in wire
        if card.get("summary"):
            assert card["summary"].strip()[:20] not in wire


# --- novus_llm adapter and keyless behaviour --------------------------------------------------


@dataclass
class _Result:
    status: str
    vectors: list[list[float]] | None = None


class _Gateway:
    def __init__(self, result: _Result, key: str | None = "k") -> None:
        self.result = result
        self.settings = type("S", (), {"api_key": key})()
        self.calls: list[dict[str, Any]] = []

    def embed(self, texts: list[str], **kw: Any) -> _Result:
        self.calls.append({"n": len(texts), **kw})
        return self.result


def test_adapter_reports_unavailable_without_an_embed_surface() -> None:
    with pytest.raises(EmbeddingsUnavailable) as exc:
        NovusLlmEmbedder(object(), model="gemini-embedding-001", dims=768).embed(["x"], task_type="RETRIEVAL_DOCUMENT")
    assert exc.value.reason == "novus_llm_has_no_embed"


def test_adapter_maps_gateway_status_and_checks_shapes() -> None:
    with pytest.raises(EmbeddingsUnavailable):
        NovusLlmEmbedder(_Gateway(_Result("budget_deferred")), model="m", dims=2).embed(["x"], task_type="RETRIEVAL_DOCUMENT")
    with pytest.raises(EmbeddingError):
        NovusLlmEmbedder(_Gateway(_Result("ok", [[1.0, 2.0, 3.0]])), model="m", dims=2).embed(["x"], task_type="RETRIEVAL_DOCUMENT")
    gw = _Gateway(_Result("ok", [[1.0, 0.0]]))
    assert NovusLlmEmbedder(gw, model="m", dims=2).embed(["x"], task_type="RETRIEVAL_QUERY") == [[1.0, 0.0]]
    assert gw.calls == [{"n": 1, "task_type": "RETRIEVAL_QUERY", "model": "m", "dims": 2, "route_id": "embed.program.v1"}]


def test_embedder_from_env_is_unavailable_with_no_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(EmbeddingsUnavailable) as exc:
        embedder_from_env("gemini-embedding-001", 768)
    assert exc.value.reason == "no_api_key"
    with pytest.raises(EmbeddingsUnavailable):
        embedder_from_env("gemini-embedding-001", 768, gateway=_Gateway(_Result("ok"), key=None))


def test_cli_without_key_writes_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    cards = tmp_path / "client-core.json"
    cards.write_text(json.dumps({"release": 3, "cards": _cards()}), encoding="utf-8")
    out = tmp_path / "embeddings.json"
    assert cli_main(["build", "--cards", str(cards), "--out", str(out)]) == 0
    assert not out.exists()
    assert json.loads(capsys.readouterr().out)["status"] == "unavailable"


def test_cli_build_with_an_injected_embedder(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    cards = tmp_path / "client-core.json"
    cards.write_text(json.dumps({"release": 3, "cards": _cards()}), encoding="utf-8")
    queries = tmp_path / "labelled.json"
    queries.write_text(json.dumps([{"query": "ocean science summer"}, "trading desk", 5]), encoding="utf-8")
    out = tmp_path / "embeddings.json"
    assert cli_main(["build", "--cards", str(cards), "--out", str(out), "--queries", str(queries)], embedder=HashingEmbedder(dims=64)) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["status"] == "built" and report["embedded"] == len(_cards())
    file = ProgramEmbeddingsFile.model_validate_json(out.read_text(encoding="utf-8"))
    assert file.sourceRelease == 3
    assert query_text_hash("trading desk") in {q.textHash for q in file.queries}


def test_upload_posts_to_the_internal_route_idempotently() -> None:
    posted: list[tuple[str, dict[str, Any], str]] = []

    class Api:
        def post(self, path: str, body: dict[str, Any], *, idempotency_key: str) -> None:
            posted.append((path, body, idempotency_key))

    file, _ = build_embeddings_file(_cards(), HashingEmbedder(dims=16), now=NOW)
    upload_embeddings(Api(), file)
    upload_embeddings(Api(), file)
    assert posted[0][0] == UPLOAD_PATH
    assert posted[0][2] == posted[1][2] and posted[0][2].startswith("embeddings:")
    assert posted[0][1]["format"] == "novus.program-embeddings.v1"
