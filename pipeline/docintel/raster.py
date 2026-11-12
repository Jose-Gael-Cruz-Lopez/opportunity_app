"""Page rasterization and crops.

`PageRasterizer` is the interface the OCR path depends on; the PDFium
implementation is the default. Rasters are re-encoded PNG without metadata,
so nothing from the source file (EXIF, text chunks) survives.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass
from typing import Protocol

from PIL import Image

from .config import RenderRules
from .contracts import BBox
from .errors import LimitExceeded, ParseFailed

NEUTRAL_FILL = 255  # white, in grayscale or each RGB channel


@dataclass(frozen=True)
class RasterImage:
    page: int  # 1-based
    width: int
    height: int
    dpi: float
    png: bytes

    def to_pil(self) -> Image.Image:
        img = Image.open(io.BytesIO(self.png))
        img.load()
        return img


class PageRasterizer(Protocol):
    def render(self, pdf: bytes, *, target_dpi: float, max_pages: int | None = None) -> list[RasterImage]: ...


def compute_render_dpi(width_pt: float, height_pt: float, target_dpi: float, rules: RenderRules) -> float:
    """dpi = min(target, 72*sqrt(max_pixels / (w*h)), 72*max_long_edge / max(w, h)) (plan 5.4.3)."""
    if width_pt <= 0 or height_pt <= 0:
        raise ValueError("page size must be positive")
    by_pixels = 72.0 * math.sqrt(rules.max_pixels / (width_pt * height_pt))
    by_edge = 72.0 * rules.max_long_edge_px / max(width_pt, height_pt)
    return min(target_dpi, by_pixels, by_edge)


def encode_png(img: Image.Image) -> bytes:
    """PNG with no ancillary chunks (no text, EXIF or ICC carried over)."""
    if img.mode not in ("L", "RGB", "RGBA", "1"):
        img = img.convert("RGB")
    # Rebuilding from raw pixels drops `info` (EXIF, ICC, text chunks).
    clean = Image.frombytes(img.mode, img.size, img.tobytes())
    buf = io.BytesIO()
    clean.save(buf, format="PNG", optimize=False)
    return buf.getvalue()


def from_pil(img: Image.Image, *, page: int, dpi: float = 0.0) -> RasterImage:
    return RasterImage(page=page, width=img.width, height=img.height, dpi=dpi, png=encode_png(img))


class PdfiumRasterizer:
    """Renders PDF pages with PDFium in grayscale (enough for OCR and display)."""

    def __init__(self, rules: RenderRules, *, max_page_side_pt: float = 14_400.0) -> None:
        self.rules = rules
        self.max_page_side_pt = max_page_side_pt

    def render(self, pdf: bytes, *, target_dpi: float, max_pages: int | None = None) -> list[RasterImage]:
        import pypdfium2 as pdfium

        try:
            doc = pdfium.PdfDocument(pdf)
        except pdfium.PdfiumError as exc:
            raise ParseFailed(detail=type(exc).__name__) from None
        try:
            count = len(doc)
            if max_pages is not None and count > max_pages:
                raise LimitExceeded(detail=f"pages={count}")
            out: list[RasterImage] = []
            for index in range(count):
                page = doc[index]
                try:
                    w, h = page.get_size()
                    if max(w, h) > self.max_page_side_pt:
                        raise LimitExceeded(detail="page_side")
                    dpi = compute_render_dpi(w, h, target_dpi, self.rules)
                    bitmap = page.render(scale=dpi / 72.0, grayscale=True)
                    img = bitmap.to_pil().convert("L")
                    out.append(from_pil(img, page=index + 1, dpi=dpi))
                finally:
                    page.close()
            return out
        finally:
            doc.close()


def bbox_to_pixels(bbox: BBox, width: int, height: int) -> tuple[int, int, int, int]:
    x0 = max(0, min(width, math.floor(bbox.x0 * width)))
    y0 = max(0, min(height, math.floor(bbox.y0 * height)))
    x1 = max(0, min(width, math.ceil(bbox.x1 * width)))
    y1 = max(0, min(height, math.ceil(bbox.y1 * height)))
    return x0, y0, x1, y1


def crop_for_blind_read(image: RasterImage, bbox: BBox, rules: RenderRules, *, mask_context: bool) -> bytes:
    """Crop one disputed token for an independent (blind) reader.

    Models misread images whose short edge is under ~200 px, so the result is
    padded to at least `blind_crop_min_short_edge_px`, after a 2x Lanczos
    upscale when the glyphs are very small. With `mask_context` (student
    content) no pixel outside the token's box is kept; otherwise nearby page
    context is included up to the minimum size.
    """
    img = image.to_pil().convert("L")
    x0, y0, x1, y1 = bbox_to_pixels(bbox, img.width, img.height)
    if x1 <= x0 or y1 <= y0:
        raise ValueError("empty crop box")
    scale = 2 if (y1 - y0) < rules.blind_crop_upscale_below_px else 1
    min_edge = rules.blind_crop_min_short_edge_px
    if mask_context:
        token = img.crop((x0, y0, x1, y1))
    else:
        # Grow the window around the token (in source pixels) towards the
        # minimum size, clamped to the page.
        need = math.ceil(min_edge / scale)
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        half_w = max((x1 - x0) / 2, need / 2)
        half_h = max((y1 - y0) / 2, need / 2)
        token = img.crop(
            (
                max(0, math.floor(cx - half_w)),
                max(0, math.floor(cy - half_h)),
                min(img.width, math.ceil(cx + half_w)),
                min(img.height, math.ceil(cy + half_h)),
            )
        )
    if scale != 1:
        token = token.resize((token.width * scale, token.height * scale), Image.Resampling.LANCZOS)
    canvas = Image.new("L", (max(token.width, min_edge), max(token.height, min_edge)), NEUTRAL_FILL)
    canvas.paste(token, ((canvas.width - token.width) // 2, (canvas.height - token.height) // 2))
    return encode_png(canvas)
