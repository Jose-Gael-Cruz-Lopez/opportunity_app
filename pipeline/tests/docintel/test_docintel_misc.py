"""Privacy scan, rasters and crops, contracts, image intake and the public OCR flow."""

from __future__ import annotations

import io

import pytest
from docintel_fakes import FakeEngine, blank_png, line
from docintel_pdfgen import build_pdf, notice_page
from PIL import Image
from pydantic import TypeAdapter, ValidationError

from docintel import read_public_pages
from docintel.config import DEFAULT_CONFIG, RenderRules
from docintel.contracts import BBox, EvidenceLocator, is_verifying_locator_kind
from docintel.errors import IsolationViolation, LimitExceeded, ParseFailed
from docintel.images import decode_image, sniff
from docintel.privacy import scan
from docintel.raster import PdfiumRasterizer, compute_render_dpi, crop_for_blind_read, from_pil

from conftest import blocked_probe

# --------------------------------------------------------------------------- privacy


@pytest.mark.parametrize(
    ("text", "rule"),
    [
        ("holds an F-1 visa", "short:f1"),
        ("A-123456789", "a_number"),
        ("TPS holder", "short:tps"),
        ("Pell recipient", "phrase:pell"),
        ("first-generation student", "phrase:first_generation"),
        ("permanent  resident", "phrase:permanent_resident"),
    ],
)
def test_scan_hits(text: str, rule: str) -> None:
    assert rule in scan({"k": [text]})


def test_scan_ignores_neutral_text_and_case_for_short_tokens() -> None:
    assert scan({"program_id": "prog_1", "decision": "accepted", "codes": ["fields_agreed"]}) == []
    assert scan("tps reports and if-1 values") == []


# --------------------------------------------------------------------------- rasters


def test_render_dpi_caps() -> None:
    rules = RenderRules()
    assert compute_render_dpi(612, 792, 110, rules) == 110
    poster = compute_render_dpi(2592, 3456, 300, rules)  # 36 x 48 in
    w, h = 2592 * poster / 72, 3456 * poster / 72
    assert w * h <= 40_000_000 * 1.0001 and max(w, h) <= 4000.01


def test_pdfium_rasterizer_renders_clean_png() -> None:
    images = PdfiumRasterizer(RenderRules()).render(build_pdf([notice_page()]), target_dpi=110)
    img = images[0].to_pil()
    assert (img.width, img.height) == (935, 1210) and img.mode == "L"
    assert img.info.get("dpi") is None and "exif" not in img.info
    assert min(img.getextrema()) < 128  # some ink was drawn


def test_rasterizer_page_limit() -> None:
    with pytest.raises(LimitExceeded):
        PdfiumRasterizer(RenderRules()).render(build_pdf([notice_page()] * 3), target_dpi=72, max_pages=2)


def black_raster(w: int = 1000, h: int = 1000):  # type: ignore[no-untyped-def]
    return from_pil(Image.new("L", (w, h), 0), page=1)


def test_crop_masking_for_student_content() -> None:
    box = BBox(x0=0.5, y0=0.5, x1=0.55, y1=0.53)
    masked = Image.open(io.BytesIO(crop_for_blind_read(black_raster(), box, RenderRules(), mask_context=True)))
    assert min(masked.size) >= 200
    assert masked.getpixel((0, 0)) == 255  # nothing outside the token survives
    context = Image.open(io.BytesIO(crop_for_blind_read(black_raster(), box, RenderRules(), mask_context=False)))
    assert context.getpixel((0, 0)) == 0  # page context included


def test_tiny_glyphs_are_upscaled() -> None:
    box = BBox(x0=0.5, y0=0.5, x1=0.6, y1=0.51)  # 10 px tall
    crop = Image.open(io.BytesIO(crop_for_blind_read(black_raster(), box, RenderRules(), mask_context=True)))
    assert crop.size == (200, 200)
    inner = [crop.getpixel((100, y)) for y in range(200)]
    assert inner.count(0) == 20  # 10 px token doubled


# --------------------------------------------------------------------------- contracts


LOCATORS = [
    {"kind": "html", "snapshotId": "s1", "charStart": 0, "charEnd": 4},
    {"kind": "pdf_text", "snapshotId": "s1", "page": 1, "charStart": 0, "charEnd": 4,
     "boxes": [{"x0": 0, "y0": 0, "x1": 1, "y1": 1}]},
    {"kind": "upload_text", "documentId": "d1", "page": 1, "charStart": 0, "charEnd": 4, "boxes": []},
    {"kind": "ocr_image", "documentId": "d1", "page": 1, "charStart": 0, "charEnd": 4, "bboxes": [],
     "agreement": "agreed", "readers": ["tesseract", "paddleocr"]},
    {"kind": "qr", "documentId": "d1", "page": 1, "bbox": {"x0": 0, "y0": 0, "x1": 1, "y1": 1},
     "payload": "https://example.org"},
]


def test_locator_union_round_trips_each_kind() -> None:
    adapter: TypeAdapter[EvidenceLocator] = TypeAdapter(EvidenceLocator)
    for raw in LOCATORS:
        parsed = adapter.validate_python(raw)
        assert parsed.kind == raw["kind"]
        assert parsed.to_wire() == raw
    with pytest.raises(ValidationError):
        adapter.validate_python({"kind": "screenshot", "documentId": "d1"})
    with pytest.raises(ValidationError):
        adapter.validate_python({**LOCATORS[0], "unknown": 1})


def test_only_html_and_pdf_text_verify() -> None:
    assert [k["kind"] for k in LOCATORS if is_verifying_locator_kind(str(k["kind"]))] == ["html", "pdf_text"]


# --------------------------------------------------------------------------- image intake


def test_sniff_and_decode() -> None:
    png = blank_png(50, 40)
    assert sniff(png) == "png" and sniff(b"%PDF-1.7") == "pdf" and sniff(b"GIF89a") is None
    img = decode_image(png, max_megapixels=40)
    assert img.size == (50, 40) and img.mode == "RGB" and not img.info
    with pytest.raises(LimitExceeded):
        decode_image(blank_png(2000, 2000), max_megapixels=1)
    with pytest.raises(ParseFailed):
        decode_image(b"\x89PNG\r\n\x1a\nbroken", max_megapixels=40)


# --------------------------------------------------------------------------- public OCR flow


class AgreeingReader:
    name = "llm:test-model"

    def read_crop(self, crop_png: bytes, token_class: str) -> str | None:
        return "goldwater.gov"


def test_read_public_pages_end_to_end(ocr_env: dict[str, str]) -> None:
    tess = FakeEngine("tesseract", [line("Apply at go1dwater.gov by March 30, 2027", 0.1, 0.8)])
    paddle = FakeEngine("paddleocr", [line("Apply at goldwater.gov by March 30, 2027", 0.1, 0.9)])
    raster = from_pil(Image.open(io.BytesIO(blank_png(1000, 1400))), page=1)
    out = read_public_pages(
        [raster], tess, paddle, document_id="doc-1", input_hash="abc",
        blind_reader=AgreeingReader(), flags={"docintel.blind_read": True},
        env=ocr_env, network_probe=blocked_probe,
    )
    assert [r.engine for r in out.ocr_runs] == ["tesseract", "paddleocr", "llm:test-model"]
    assert out.ocr_runs[0].mean_confidence == pytest.approx(0.8)
    assert out.ocr_runs[2].model_id == "test-model" and out.ocr_runs[2].prompt_version == "read_span.v1"
    assert all(t.agreement == "agreed" for t in out.critical_tokens)
    url = next(t for t in out.critical_tokens if t.cls == "URL")
    assert url.adjudicated and url.readers == ["paddleocr", "llm:test-model"]
    assert out.pages[0].source == "ocr" and out.pages[0].tokens
    assert not any("goldwater" in str(v) for row in out.ocr_runs for v in row.to_wire().values())


def test_read_public_pages_guards(ocr_env: dict[str, str]) -> None:
    eng = FakeEngine("a", [line("x", 0.1)])
    raster = from_pil(Image.new("L", (10, 10), 255), page=1)
    with pytest.raises(IsolationViolation):
        read_public_pages([raster], eng, eng, document_id="d", env={}, network_probe=blocked_probe)
    with pytest.raises(LimitExceeded):
        read_public_pages([raster] * (DEFAULT_CONFIG.limits.max_ocr_pages + 1), eng, eng, document_id="d",
                          env=ocr_env, network_probe=blocked_probe)
