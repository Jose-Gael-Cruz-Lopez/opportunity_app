"""The OCR engine interface and its result types.

Engines are optional imports: an image that lacks Tesseract or PaddleOCR
still imports DocIntel, and constructing the missing engine raises
EngineUnavailable. Tests use fake engines that return fixed results.

Boxes are normalized to 0-1 with a top-left origin, so results from engines
that saw different resolutions can be compared directly.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from PIL import Image

from ..boxes import Box


@dataclass(frozen=True)
class OcrWord:
    text: str
    box: Box  # normalized 0-1, top-left origin
    conf: float | None  # engine's raw confidence in [0, 1]; uncalibrated


@dataclass(frozen=True)
class OcrLine:
    text: str
    box: Box
    conf: float | None
    words: tuple[OcrWord, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class EngineResult:
    engine: str
    version: str
    lines: tuple[OcrLine, ...]
    width: int
    height: int

    @property
    def mean_confidence(self) -> float | None:
        confs = [line.conf for line in self.lines if line.conf is not None]
        return round(sum(confs) / len(confs), 4) if confs else None


@runtime_checkable
class OCREngine(Protocol):
    name: str
    version: str

    def recognize(self, image: Image.Image, langs: Sequence[str]) -> EngineResult: ...


def normalize_box(x0: float, y0: float, x1: float, y1: float, width: int, height: int) -> Box:
    if width <= 0 or height <= 0:
        raise ValueError("image size must be positive")
    clamp = lambda v: max(0.0, min(1.0, v))  # noqa: E731
    return Box(clamp(x0 / width), clamp(y0 / height), clamp(x1 / width), clamp(y1 / height))


def line_from_words(words: Sequence[OcrWord]) -> OcrLine:
    from ..boxes import union

    confs = [w.conf for w in words if w.conf is not None]
    return OcrLine(
        text=" ".join(w.text for w in words),
        box=union(w.box for w in words),
        conf=min(confs) if confs else None,
        words=tuple(words),
    )
