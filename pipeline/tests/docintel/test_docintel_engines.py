from __future__ import annotations

import sys

import pytest
from docintel_fakes import FakeEngine, line
from PIL import Image

from docintel.engines.base import OCREngine
from docintel.engines.paddle import PaddleEngine, parse_paddle_result
from docintel.engines.tesseract import TesseractEngine, parse_tesseract_data
from docintel.errors import EngineUnavailable


def test_parse_tesseract_groups_words_into_lines() -> None:
    data = {
        "level": [1, 4, 5, 5, 4, 5, 5],
        "page_num": [1] * 7,
        "block_num": [0, 1, 1, 1, 1, 1, 1],
        "par_num": [0, 1, 1, 1, 1, 1, 1],
        "line_num": [0, 1, 1, 1, 2, 2, 2],
        "word_num": [0, 0, 1, 2, 0, 1, 2],
        "left": [0, 10, 10, 60, 10, 10, 80],
        "top": [0, 10, 10, 10, 40, 40, 40],
        "width": [200, 100, 40, 50, 100, 60, 30],
        "height": [100, 20, 20, 20, 20, 20, 20],
        "conf": [-1, -1, 96.0, 88.5, -1, 91.0, "70"],
        "text": ["", "", "Due", "Mar", "", "30,", " "],
    }
    lines = parse_tesseract_data(data, 200, 100)
    assert [ln.text for ln in lines] == ["Due Mar", "30,"]
    assert lines[0].conf == pytest.approx(0.885)  # line conf = weakest word
    assert lines[0].box.x0 == pytest.approx(0.05) and lines[0].box.x1 == pytest.approx(0.55)
    assert lines[1].words[0].box.y0 == pytest.approx(0.4)


def test_parse_paddle_accepts_boxes_and_polygons() -> None:
    boxed = {"rec_texts": ["Apply now", " "], "rec_scores": [0.97, 0.1], "rec_boxes": [[10, 20, 110, 40], [0, 0, 1, 1]]}
    lines = parse_paddle_result(boxed, 200, 100)
    assert [ln.text for ln in lines] == ["Apply now"]
    assert lines[0].box.x1 == pytest.approx(0.55) and lines[0].conf == pytest.approx(0.97)
    poly = {"rec_texts": ["Due"], "rec_scores": [0.5], "rec_polys": [[[10, 20], [50, 18], [52, 40], [9, 42]]]}
    (ln,) = parse_paddle_result(poly, 100, 100)
    assert (ln.box.x0, ln.box.y0, ln.box.x1, ln.box.y1) == pytest.approx((0.09, 0.18, 0.52, 0.42))


def test_missing_engines_raise_engine_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "pytesseract", None)
    monkeypatch.setitem(sys.modules, "paddleocr", None)
    with pytest.raises(EngineUnavailable):
        TesseractEngine()
    with pytest.raises(EngineUnavailable):
        PaddleEngine()


def test_fake_engine_satisfies_protocol() -> None:
    engine = FakeEngine("fake", [line("hello", 0.1)])
    assert isinstance(engine, OCREngine)
    res = engine.recognize(Image.new("L", (10, 10)), ["en"])
    assert res.lines[0].text == "hello" and res.mean_confidence == pytest.approx(0.9)
