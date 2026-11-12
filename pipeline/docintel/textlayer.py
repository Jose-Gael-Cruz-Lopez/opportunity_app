"""PDF text-layer extraction: PDFium for text and boxes, pypdf for the
structural preflight, pdfplumber as an independent second reader for quality.

- pypdf checks magic bytes, encryption, page count and page sizes before
  PDFium touches the file, so oversized inputs fail fast with a clear code.
- PDFium gives text in its native order with one tight box per character,
  plus each character's render mode (for the hidden channel).
- pdfplumber (pdfminer) re-reads every page; the similarity of the two
  readings flags broken ToUnicode maps and other extraction faults.

All boxes are stored relative to the CropBox's lower-left corner, before
/Rotate (PDFium reports boxes in unrotated page space).

Hidden characters are replaced by spaces before canonicalization. When that
space is collapsed with neighbouring whitespace, the HiddenSpan is recorded
as a zero-length span at the position where the text was; its `text` field
still holds the hidden characters for the HIDDEN_TEXT check.
"""

from __future__ import annotations

import io
import logging
from collections.abc import Callable
from dataclasses import dataclass

import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_raw

from .boxes import ZERO_BOX, Box, intersection_area, pack_char_boxes, union
from .canonical import CanonicalText, canonicalize
from .config import DocIntelConfig
from .contracts import HiddenReason, HiddenSpan, PageQuality, TextLayerPage
from .errors import LimitExceeded, ParseFailed
from .quality import classify_page, page_signals, quality_score

log = logging.getLogger("docintel.textlayer")

INVISIBLE_RENDER_MODES = frozenset({pdfium_raw.FPDF_TEXTRENDERMODE_INVISIBLE, pdfium_raw.FPDF_TEXTRENDERMODE_CLIP})


@dataclass(frozen=True)
class RawChar:
    text: str  # "" for the low half of a surrogate pair already merged
    box: Box  # CropBox-relative; ZERO_BOX when PDFium has none
    generated: bool
    hidden: HiddenReason | None
    unicode_error: bool


@dataclass(frozen=True)
class PageExtraction:
    layer_page: TextLayerPage
    quality: PageQuality
    canonical: CanonicalText


# --------------------------------------------------------------------------- preflight


def preflight(pdf: bytes, config: DocIntelConfig) -> int:
    """Cheap structural checks with pypdf. Returns the page count."""
    limits = config.limits
    if len(pdf) > limits.max_pdf_bytes:
        raise LimitExceeded(detail=f"bytes={len(pdf)}")
    if b"%PDF-" not in pdf[:1024]:
        raise ParseFailed("not_a_pdf")
    try:
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError

        reader = PdfReader(io.BytesIO(pdf), strict=False)
        if reader.is_encrypted and not reader.decrypt(""):
            # Owner-password-only files open with an empty user password;
            # anything else needs a password we never have.
            raise ParseFailed("encrypted")
        count = len(reader.pages)
        if count > limits.max_pages:
            raise LimitExceeded(detail=f"pages={count}")
        for page in reader.pages:
            box = page.mediabox
            if max(float(box.width), float(box.height)) > limits.max_page_side_pt:
                raise LimitExceeded(detail="page_side")
        return count
    except (LimitExceeded, ParseFailed):
        raise
    except (PdfReadError, ValueError, KeyError, TypeError, AttributeError, OSError) as exc:
        raise ParseFailed(detail=type(exc).__name__) from None


# --------------------------------------------------------------------------- PDFium reading


def _read_unicode(textpage: pdfium.PdfTextPage, count: int) -> list[str]:
    """One entry per PDFium index; surrogate pairs collapse onto the first."""
    raw_tp = textpage.raw
    codes = [pdfium_raw.FPDFText_GetUnicode(raw_tp, i) for i in range(count)]
    out: list[str] = []
    i = 0
    while i < count:
        code = codes[i]
        if 0xD800 <= code < 0xDC00 and i + 1 < count and 0xDC00 <= codes[i + 1] < 0xE000:
            out.append(chr(0x10000 + ((code - 0xD800) << 10) + (codes[i + 1] - 0xDC00)))
            out.append("")
            i += 2
            continue
        out.append(chr(code) if code and not 0xD800 <= code < 0xE000 else "�")
        i += 1
    return out


def _render_mode(textpage: pdfium.PdfTextPage, index: int) -> int | None:
    obj = pdfium_raw.FPDFText_GetTextObject(textpage.raw, index)
    if not obj:
        return None
    return int(pdfium_raw.FPDFTextObj_GetTextRenderMode(obj))


def _has_images(page: pdfium.PdfPage) -> bool:
    for _ in page.get_objects(filter=[pdfium_raw.FPDF_PAGEOBJ_IMAGE], max_depth=4):
        return True
    return False


def read_raw_chars(page: pdfium.PdfPage) -> tuple[list[RawChar], tuple[float, float, float, float]]:
    crop = tuple(float(v) for v in page.get_cropbox())  # left, bottom, right, top
    cl, cb, cr, ct = crop
    crop_rel = Box(0.0, 0.0, cr - cl, ct - cb)
    textpage = page.get_textpage()
    try:
        count = textpage.count_chars()
        texts = _read_unicode(textpage, count)
        chars: list[RawChar] = []
        for i in range(count):
            generated = bool(pdfium_raw.FPDFText_IsGenerated(textpage.raw, i))
            box = ZERO_BOX
            if not generated:
                # Loose boxes span the font's ascent and descent, so every
                # glyph on a line shares one height and highlights line up.
                left, bottom, right, top = textpage.get_charbox(i, loose=True)
                box = Box(left - cl, bottom - cb, right - cl, top - cb)
            hidden: HiddenReason | None = None
            if not generated and texts[i] and not texts[i].isspace():
                mode = _render_mode(textpage, i)
                if mode is not None and mode in INVISIBLE_RENDER_MODES:
                    hidden = "render_mode"
                elif not box.empty and intersection_area(box, crop_rel) == 0.0:
                    hidden = "outside_cropbox"
            unicode_error = bool(pdfium_raw.FPDFText_HasUnicodeMapError(textpage.raw, i))
            chars.append(RawChar(texts[i], box, generated, hidden, unicode_error))
        return chars, (cl, cb, cr, ct)
    finally:
        textpage.close()


# --------------------------------------------------------------------------- assembly


def _hidden_spans(chars: list[RawChar], canon: CanonicalText) -> list[HiddenSpan]:
    """Group runs of hidden characters (same reason) and map them to the
    canonical positions that replaced them."""
    spans: list[HiddenSpan] = []
    i = 0
    n = len(chars)
    while i < n:
        reason = chars[i].hidden
        if reason is None:
            i += 1
            continue
        j = i
        while j < n and (chars[j].hidden == reason or (chars[j].text.isspace() and j + 1 < n and chars[j + 1].hidden == reason)):
            j += 1
        idx = canon.canonical_indices_for_source(i, j)
        if idx:
            start, end = idx[0], idx[-1] + 1
        else:
            # Collapsed away at a page edge: record an empty span at the nearest position.
            following = [k for k, (a, _) in enumerate(canon.src_ranges) if a >= j]
            start = end = following[0] if following else len(canon.text)
        spans.append(HiddenSpan(start=start, end=end, text="".join(c.text for c in chars[i:j]), reason=reason))
        i = j
    return spans


def assemble_page(
    page_number: int,
    chars: list[RawChar],
    crop: tuple[float, float, float, float],
    rotate: int,
    *,
    has_images: bool,
    other_reading: str | None,
    config: DocIntelConfig,
) -> PageExtraction:
    # Hidden characters become spaces before canonicalization, so offsets of
    # the visible text are unaffected and nothing hidden reaches a model.
    visible = [" " if c.hidden else ("\n" if c.generated and c.text in "\r\n" else c.text) for c in chars]
    canon = canonicalize(visible)
    canon_boxes = [
        union(chars[k].box for k in range(a, b) if chars[k].hidden is None) for a, b in canon.src_ranges
    ]
    hidden = _hidden_spans(chars, canon)
    signals = page_signals(
        canon.text,
        unicode_map_errors=sum(1 for c in chars if c.unicode_error),
        has_images=has_images,
        # Compare like with like: the second reader also sees hidden text,
        # so it is compared with PDFium's full reading, hidden chars included.
        other_reading=other_reading,
        own_reading="".join(c.text for c in chars),
    )
    status = classify_page(signals, config.triage)
    cl, cb, cr, ct = crop
    rot = rotate if rotate in (0, 90, 180, 270) else 0
    layer_page = TextLayerPage(
        page=page_number,
        source="text_layer",
        text=canon.text,
        crop_box=(cl, cb, cr, ct),
        rotate=rot,  # type: ignore[arg-type]
        char_boxes=pack_char_boxes(canon_boxes),
        hidden=hidden,
    )
    quality = PageQuality(
        page=page_number,
        printable_chars=signals.printable_chars,
        tokens=signals.tokens,
        garbage_tokens=signals.garbage_tokens,
        garbage_ratio=round(signals.garbage_ratio, 4),
        unicode_map_errors=signals.unicode_map_errors,
        has_images=has_images,
        cross_reader_agreement=signals.cross_reader_agreement,
        hidden_chars=sum(1 for c in chars if c.hidden),
        status=status,
        score=quality_score(signals, config.triage),
    )
    return PageExtraction(layer_page, quality, canon)


SecondReader = Callable[[bytes, int], list[str | None]]


def pdfplumber_reader(pdf: bytes, page_count: int) -> list[str | None]:
    """Independent reading of every page with pdfplumber. A failure on one
    page yields None for that page; quality then relies on PDFium alone."""
    out: list[str | None] = [None] * page_count
    try:
        import pdfplumber

        with pdfplumber.open(io.BytesIO(pdf)) as doc:
            for i, page in enumerate(doc.pages[:page_count]):
                try:
                    out[i] = page.extract_text() or ""
                except Exception as exc:  # pdfminer raises many types on bad input
                    log.info("second_reader_page_failed", extra={"error_class": type(exc).__name__})
    except Exception as exc:
        log.info("second_reader_failed", extra={"error_class": type(exc).__name__})
    return out


def extract_text_layer(
    pdf: bytes,
    config: DocIntelConfig,
    *,
    second_reader: SecondReader | None = pdfplumber_reader,
) -> list[PageExtraction]:
    """Extract every page. Raises LimitExceeded or ParseFailed."""
    page_count = preflight(pdf, config)
    others = second_reader(pdf, page_count) if second_reader else [None] * page_count
    try:
        doc = pdfium.PdfDocument(pdf)
    except pdfium.PdfiumError as exc:
        raise ParseFailed(detail=type(exc).__name__) from None
    try:
        pages: list[PageExtraction] = []
        for index in range(len(doc)):
            page = doc[index]
            try:
                width, height = page.get_size()
                if max(width, height) > config.limits.max_page_side_pt:
                    raise LimitExceeded(detail="page_side")
                chars, crop = read_raw_chars(page)
                pages.append(
                    assemble_page(
                        index + 1,
                        chars,
                        crop,
                        int(page.get_rotation()),
                        has_images=_has_images(page),
                        other_reading=others[index] if index < len(others) else None,
                        config=config,
                    )
                )
            finally:
                page.close()
        return pages
    finally:
        doc.close()
