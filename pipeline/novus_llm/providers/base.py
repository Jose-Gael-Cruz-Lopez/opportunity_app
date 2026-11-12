"""The provider seam: one structured-JSON generation call, provider-neutral in and out."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

Finish = Literal["stop", "max_tokens", "refused", "other"]


@dataclass(frozen=True)
class TextPart:
    text: str


@dataclass(frozen=True)
class BinaryPart:
    mime_type: str
    data: bytes


@dataclass(frozen=True)
class GenerateCall:
    model: str
    system: str
    parts: tuple[TextPart | BinaryPart, ...]
    response_schema: dict[str, Any]
    max_output_tokens: int
    thinking_level: str | None = None  # already mapped to what the model accepts


@dataclass(frozen=True)
class ProviderResult:
    text: str | None
    finish: Finish
    refusal_category: str | None = None
    input_tokens: int = 0
    cached_tokens: int = 0
    output_tokens: int = 0
    thinking_tokens: int = 0
    model_version: str | None = None
    response_id: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)


class ProviderError(Exception):
    """Transport or API failure. Messages carry status codes only, never prompt text."""

    def __init__(self, message: str, *, retryable: bool, status: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status


class Provider(Protocol):
    name: str

    def generate(self, call: GenerateCall) -> ProviderResult: ...
