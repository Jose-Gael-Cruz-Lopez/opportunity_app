"""PaddleOCR adapter, an optional dependency.

PaddleOCR 3.x returns one result object per image whose JSON form carries
`rec_texts`, `rec_scores` and either `rec_boxes` (x0, y0, x1, y1) or
`rec_polys` (four corner points). Parsing is a pure function so tests can
feed it fixed output without the library. Model directories must be baked
into the image and passed in, because the runtime cannot download them.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from PIL import Image

from ..errors import EngineUnavailable
from .base import EngineResult, OcrLine, normalize_box


def _box_from_entry(entry: Any) -> tuple[float, float, float, float]:
    """Accept a flat [x0, y0, x1, y1] box or a polygon of (x, y) points."""
    values = entry.tolist() if hasattr(entry, "tolist") else list(entry)
    if len(values) == 4 and all(isinstance(v, (int, float)) for v in values):
        return float(values[0]), float(values[1]), float(values[2]), float(values[3])
    points = [(float(p[0]), float(p[1])) for p in values]
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def parse_paddle_result(result: Mapping[str, Any], width: int, height: int) -> list[OcrLine]:
    texts = list(result.get("rec_texts") or [])
    scores = list(result.get("rec_scores") or [None] * len(texts))
    boxes = result.get("rec_boxes")
    if boxes is None or len(boxes) == 0:
        boxes = result.get("rec_polys") or []
    lines: list[OcrLine] = []
    for text, score, entry in zip(texts, scores, boxes, strict=False):
        clean = str(text).strip()
        if not clean:
            continue
        x0, y0, x1, y1 = _box_from_entry(entry)
        conf = None if score is None else round(float(score), 4)
        lines.append(OcrLine(clean, normalize_box(x0, y0, x1, y1, width, height), conf, ()))
    return lines


class PaddleEngine:
    name = "paddleocr"

    def __init__(self, **paddle_kwargs: Any) -> None:
        try:
            import paddleocr
        except ImportError:
            raise EngineUnavailable(detail="paddleocr") from None
        self.version = str(getattr(paddleocr, "__version__", "unknown"))
        defaults: dict[str, Any] = {
            "lang": "en",
            "use_doc_orientation_classify": False,
            "use_doc_unwarping": False,
            "use_textline_orientation": True,
        }
        defaults.update(paddle_kwargs)
        self._ocr = paddleocr.PaddleOCR(**defaults)

    def recognize(self, image: Image.Image, langs: Sequence[str]) -> EngineResult:
        import numpy as np  # installed with paddleocr

        # PaddleOCR reads the color image (no binarization), BGR order.
        rgb = np.asarray(image.convert("RGB"))[:, :, ::-1]
        results = self._ocr.predict(rgb)
        lines: list[OcrLine] = []
        for res in results:
            payload = res.json.get("res", res.json) if hasattr(res, "json") else res
            lines.extend(parse_paddle_result(payload, image.width, image.height))
        return EngineResult(self.name, self.version, tuple(lines), image.width, image.height)
