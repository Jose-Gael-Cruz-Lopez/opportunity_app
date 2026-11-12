from __future__ import annotations

import io

import pytest
from docintel_fakes import line, result
from PIL import Image

from docintel.adjudicate import (
    BLIND_READ_ROUTE,
    BlindReadOutput,
    NovusLlmBlindReader,
    adjudicate_page,
    blind_instruction,
)
from docintel.config import DEFAULT_CONFIG
from docintel.contracts import TokenClass
from docintel.isolation import DocumentClass
from docintel.raster import from_pil
from docintel.reconcile import ReconciledPage, check_page

FLAGS_ON = {"docintel.blind_read": True}


def disputed_page() -> ReconciledPage:
    tess = result("tesseract", [line("Apply at go1dwater.gov by March 30, 2027", 0.1)])
    paddle = result("paddleocr", [line("Apply at goldwater.gov by March 30, 2027", 0.1)])
    return check_page(1, tess, paddle, DEFAULT_CONFIG)


def raster():  # type: ignore[no-untyped-def]
    return from_pil(Image.new("L", (1000, 1400), 255), page=1, dpi=300)


class RecordingReader:
    name = "llm:test-model"

    def __init__(self, answer: str | None = None, error: Exception | None = None) -> None:
        self.answer = answer
        self.error = error
        self.calls: list[tuple[bytes, TokenClass]] = []

    def read_crop(self, crop_png: bytes, token_class: TokenClass) -> str | None:
        self.calls.append((crop_png, token_class))
        if self.error:
            raise self.error
        return self.answer


def url_token(page: ReconciledPage):  # type: ignore[no-untyped-def]
    return next(t for t in page.tokens if t.cls == "URL")


def test_matching_blind_vote_resolves_the_dispute() -> None:
    page = disputed_page()
    reader = RecordingReader("goldwater.gov")
    stats = adjudicate_page(page, raster(), reader, doc_class=DocumentClass.PUBLIC, flags=FLAGS_ON,
                            config=DEFAULT_CONFIG)
    tok = url_token(page)
    assert stats.attempted == 1 and stats.resolved == 1
    assert tok.agreement == "agreed" and tok.adjudicated
    assert tok.norm == "goldwater.gov" and tok.text == "goldwater.gov"
    assert tok.readers == ["paddleocr", "llm:test-model"]
    assert [r.reader for r in tok.readings] == ["tesseract", "paddleocr", "llm:test-model"]


def test_reader_sees_only_a_crop_and_the_class() -> None:
    page = disputed_page()
    reader = RecordingReader("goldwater.gov")
    adjudicate_page(page, raster(), reader, doc_class=DocumentClass.PUBLIC, flags=FLAGS_ON, config=DEFAULT_CONFIG)
    (crop, cls), = reader.calls
    assert cls == "URL"
    img = Image.open(io.BytesIO(crop))
    assert min(img.size) >= 200
    assert b"goldwater" not in crop and b"go1dwater" not in crop


def test_a_third_value_leaves_the_token_disputed() -> None:
    page = disputed_page()
    stats = adjudicate_page(page, raster(), RecordingReader("goldwater.org"), doc_class=DocumentClass.PUBLIC,
                            flags=FLAGS_ON, config=DEFAULT_CONFIG)
    tok = url_token(page)
    assert tok.agreement == "disputed" and not tok.adjudicated
    assert len(tok.readings) == 3 and stats.resolved == 0


def test_reader_failure_and_illegible_leave_token_disputed() -> None:
    page = disputed_page()
    stats = adjudicate_page(page, raster(), RecordingReader(error=TimeoutError()), doc_class=DocumentClass.PUBLIC,
                            flags=FLAGS_ON, config=DEFAULT_CONFIG)
    assert url_token(page).agreement == "disputed"
    assert stats.failures == 1 and stats.failure_codes == ["TimeoutError"]
    page2 = disputed_page()
    stats2 = adjudicate_page(page2, raster(), RecordingReader(None), doc_class=DocumentClass.PUBLIC, flags=FLAGS_ON,
                             config=DEFAULT_CONFIG)
    assert stats2.no_reading == 1 and url_token(page2).agreement == "disputed"


@pytest.mark.parametrize(
    ("doc_class", "flags", "reason"),
    [
        (DocumentClass.STUDENT, FLAGS_ON, "llm_not_allowed"),
        (DocumentClass.PUBLIC, {}, "llm_not_allowed"),
    ],
)
def test_student_content_and_flag_off_never_call_the_llm(
    doc_class: DocumentClass, flags: dict[str, bool], reason: str
) -> None:
    page = disputed_page()
    reader = RecordingReader("goldwater.gov")
    stats = adjudicate_page(page, raster(), reader, doc_class=doc_class, flags=flags, config=DEFAULT_CONFIG)
    assert reader.calls == [] and stats.skipped_reason == reason
    assert url_token(page).agreement == "disputed"


def test_max_calls_caps_spend() -> None:
    page = disputed_page()
    stats = adjudicate_page(page, raster(), RecordingReader("x"), doc_class=DocumentClass.PUBLIC, flags=FLAGS_ON,
                            config=DEFAULT_CONFIG, max_calls=0)
    assert stats.attempted == 0 and stats.skipped_reason == "max_calls"


class FakeLlm:
    model_id = "gemini-3.5-flash-lite"

    def __init__(self, out: BlindReadOutput | None) -> None:
        self.out = out
        self.kwargs: dict[str, object] = {}

    def extract_from_image(self, *, route, image_png, instruction, schema):  # type: ignore[no-untyped-def]
        self.kwargs = {"route": route, "image_png": image_png, "instruction": instruction, "schema": schema}
        return self.out


def test_novus_llm_adapter() -> None:
    llm = FakeLlm(BlindReadOutput(legible=True, text="March 30, 2027"))
    reader = NovusLlmBlindReader(llm)
    assert reader.name == "llm:gemini-3.5-flash-lite"
    assert reader.read_crop(b"png", "DATE") == "March 30, 2027"
    assert llm.kwargs["route"] == BLIND_READ_ROUTE and llm.kwargs["schema"] is BlindReadOutput
    assert NovusLlmBlindReader(FakeLlm(BlindReadOutput(legible=False, text=None))).read_crop(b"p", "URL") is None
    assert NovusLlmBlindReader(FakeLlm(None)).read_crop(b"p", "URL") is None


def test_instruction_carries_no_candidates() -> None:
    text = blind_instruction("URL")
    assert "web address" in text and ".gov" not in text
    with pytest.raises(Exception):
        BlindReadOutput.model_validate({"legible": True, "text": "x", "extra": 1})
