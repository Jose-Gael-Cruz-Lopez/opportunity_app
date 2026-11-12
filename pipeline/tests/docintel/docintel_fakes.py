"""Fake OCR engines and helpers for DocIntel tests (no OCR library needed)."""

from __future__ import annotations

from collections.abc import Sequence

from PIL import Image

from docintel.boxes import Box
from docintel.engines.base import EngineResult, OcrLine, OcrWord


def line(text: str, y: float, conf: float | None = 0.9, *, x0: float = 0.1, x1: float = 0.9, h: float = 0.04,
         words: bool = True) -> OcrLine:
    """A line at height y with evenly spaced word boxes."""
    box = Box(x0, y, x1, y + h)
    ws: list[OcrWord] = []
    if words:
        parts = text.split(" ")
        total = max(1, len(text))
        cursor = 0
        for p in parts:
            a = x0 + (x1 - x0) * cursor / total
            b = x0 + (x1 - x0) * (cursor + len(p)) / total
            ws.append(OcrWord(p, Box(a, y, b, y + h), conf))
            cursor += len(p) + 1
    return OcrLine(text, box, conf, tuple(ws))


def result(engine: str, lines: Sequence[OcrLine], *, size: tuple[int, int] = (1000, 1400)) -> EngineResult:
    return EngineResult(engine, "fake-1", tuple(lines), size[0], size[1])


class FakeEngine:
    def __init__(self, name: str, lines: Sequence[OcrLine] | Sequence[Sequence[OcrLine]]) -> None:
        self.name = name
        self.version = "fake-1"
        self._pages: list[Sequence[OcrLine]]
        if lines and isinstance(lines[0], OcrLine):
            self._pages = [lines]  # type: ignore[list-item]
        else:
            self._pages = list(lines)  # type: ignore[arg-type]
        self.calls = 0

    def recognize(self, image: Image.Image, langs: Sequence[str]) -> EngineResult:
        page = self._pages[min(self.calls, len(self._pages) - 1)]
        self.calls += 1
        return EngineResult(self.name, self.version, tuple(page), image.width, image.height)


def blank_png(width: int = 400, height: int = 560, value: int = 255) -> bytes:
    import io

    buf = io.BytesIO()
    Image.new("L", (width, height), value).save(buf, format="PNG")
    return buf.getvalue()
