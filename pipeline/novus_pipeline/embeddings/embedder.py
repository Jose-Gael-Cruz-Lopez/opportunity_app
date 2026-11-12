"""Embedders: the seam between the build and the model.

Gemini is reached only through novus_llm (repository rule). novus_llm does not yet expose an
embedding call; `NovusLlmEmbedder` uses the surface described in README.md ("novus_llm contract")
once it exists and reports `unavailable` until then, exactly like a missing key. The build then
writes nothing and search stays lexical.

`HashingEmbedder` is a deterministic offline stand-in for tests only (no network, no key).
"""

from __future__ import annotations

import hashlib
import math
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol


class EmbeddingsUnavailable(Exception):
    """No key, no novus_llm embed surface, a kill switch or a deferred budget. Not an error."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class EmbeddingError(Exception):
    """The provider answered but the result is unusable (wrong count or length). Never carries text."""


class Embedder(Protocol):
    model: str
    dims: int

    def embed(self, texts: Sequence[str], *, task_type: str) -> list[list[float]]: ...


@dataclass
class NovusLlmEmbedder:
    """Adapter over `novus_llm.Gateway.embed` (README "novus_llm contract")."""

    gateway: Any
    model: str
    dims: int
    route_id: str = "embed.program.v1"

    def embed(self, texts: Sequence[str], *, task_type: str) -> list[list[float]]:
        embed = getattr(self.gateway, "embed", None)
        if embed is None:
            raise EmbeddingsUnavailable("novus_llm_has_no_embed")
        result = embed(list(texts), task_type=task_type, model=self.model, dims=self.dims, route_id=self.route_id)
        status = getattr(result, "status", None)
        if status != "ok":
            raise EmbeddingsUnavailable(str(status or "unknown"))
        vectors = list(getattr(result, "vectors", None) or [])
        if len(vectors) != len(texts) or any(len(v) != self.dims for v in vectors):
            raise EmbeddingError("embedding count or length mismatch")
        return [[float(x) for x in v] for v in vectors]


def embedder_from_env(model: str, dims: int, *, gateway: Any = None) -> NovusLlmEmbedder:
    """The production embedder. Raises EmbeddingsUnavailable with no key (checked first, no cost)."""
    if gateway is not None:
        if not getattr(getattr(gateway, "settings", None), "api_key", None):
            raise EmbeddingsUnavailable("no_api_key")
        return NovusLlmEmbedder(gateway, model=model, dims=dims)
    from novus_llm import Gateway, LlmSettings

    settings = LlmSettings.from_env()
    if not settings.api_key:
        raise EmbeddingsUnavailable("no_api_key")
    return NovusLlmEmbedder(Gateway.from_env(settings=settings), model=model, dims=dims)


_WORD_RE = re.compile(r"[^\W_]+", re.UNICODE)


@dataclass
class HashingEmbedder:
    """Feature hashing of folded words into `dims` buckets, then unit length. Tests only."""

    model: str = "test-hashing"
    dims: int = 64
    calls: int = 0

    def embed(self, texts: Sequence[str], *, task_type: str) -> list[list[float]]:
        self.calls += 1
        out: list[list[float]] = []
        for text in texts:
            v = [0.0] * self.dims
            folded = unicodedata.normalize("NFKD", text).lower()
            for word in _WORD_RE.findall(folded):
                h = int.from_bytes(hashlib.sha256(word.encode("utf-8")).digest()[:4], "big")
                v[h % self.dims] += 1.0 if (h >> 31) & 1 else -1.0
            norm = math.sqrt(sum(x * x for x in v)) or 1.0
            out.append([x / norm for x in v])
        return out
