"""Image intake inside the restricted runtime: sniff, decode with caps, clean.

The Worker checks only sizes and magic bytes; decoding happens here, where a
decoder bug reaches neither secrets nor the network.
"""

from __future__ import annotations

import io
from typing import Literal

from PIL import Image, ImageOps

from .errors import LimitExceeded, ParseFailed

ImageKind = Literal["png", "jpeg", "webp", "pdf"]


def sniff(data: bytes) -> ImageKind | None:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if b"%PDF-" in data[:1024]:
        return "pdf"
    return None


def decode_image(data: bytes, *, max_megapixels: float) -> Image.Image:
    """Decode a PNG, JPEG or WebP with a pixel cap, apply EXIF orientation,
    and return a metadata-free RGB copy."""
    kind = sniff(data)
    if kind not in ("png", "jpeg", "webp"):
        raise ParseFailed(detail="unsupported_image")
    try:
        with Image.open(io.BytesIO(data)) as probe:
            w, h = probe.size
            if w * h > max_megapixels * 1_000_000:
                raise LimitExceeded(detail="megapixels")
            probe.load()
            upright = ImageOps.exif_transpose(probe) or probe
            rgb = upright.convert("RGB")
    except (LimitExceeded, ParseFailed):
        raise
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        raise ParseFailed(detail=type(exc).__name__) from None
    # Rebuild from pixels so no EXIF, ICC or text chunk survives.
    return Image.frombytes("RGB", rgb.size, rgb.tobytes())
