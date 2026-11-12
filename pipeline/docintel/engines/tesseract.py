"""Tesseract (LSTM) adapter through pytesseract, an optional dependency.

The parsing of Tesseract's TSV/dict output is a pure function so it can be
tested without the binary. Model files must be baked into the image: the
restricted runtime has no network to download them.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from PIL import Image

from ..errors import EngineUnavailable
from .base import EngineResult, OcrLine, OcrWord, line_from_words, normalize_box

TESSERACT_LANGS = {"en": "eng", "es": "spa"}


def parse_tesseract_data(data: Mapping[str, Sequence[Any]], width: int, height: int) -> list[OcrLine]:
    """Group word rows (level 5) into lines keyed by (block, paragraph, line).

    Tesseract reports conf in 0-100 and -1 for non-word rows; empty words
    are dropped.
    """
    groups: dict[tuple[int, int, int, int], list[OcrWord]] = {}
    order: list[tuple[int, int, int, int]] = []
    for i, text in enumerate(data["text"]):
        word = str(text).strip()
        if not word or int(data["level"][i]) != 5:
            continue
        left, top = float(data["left"][i]), float(data["top"][i])
        w, h = float(data["width"][i]), float(data["height"][i])
        raw_conf = float(data["conf"][i])
        conf = None if raw_conf < 0 else round(raw_conf / 100.0, 4)
        key = (int(data["page_num"][i]), int(data["block_num"][i]), int(data["par_num"][i]), int(data["line_num"][i]))
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(OcrWord(word, normalize_box(left, top, left + w, top + h, width, height), conf))
    return [line_from_words(groups[k]) for k in order]


class TesseractEngine:
    name = "tesseract"

    def __init__(self, *, psm: int = 3, oem: int = 1) -> None:
        try:
            import pytesseract
        except ImportError:
            raise EngineUnavailable(detail="pytesseract") from None
        self._pt = pytesseract
        try:
            self.version = str(pytesseract.get_tesseract_version())
        except Exception:  # binary missing or not executable
            raise EngineUnavailable(detail="tesseract binary") from None
        self._config = f"--oem {oem} --psm {psm}"

    def recognize(self, image: Image.Image, langs: Sequence[str]) -> EngineResult:
        lang = "+".join(TESSERACT_LANGS.get(code, code) for code in langs) or "eng"
        data = self._pt.image_to_data(image, lang=lang, config=self._config, output_type=self._pt.Output.DICT)
        lines = parse_tesseract_data(data, image.width, image.height)
        return EngineResult(self.name, self.version, tuple(lines), image.width, image.height)
