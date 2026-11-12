"""Box arithmetic and the packed character-box encoding.

Character boxes are stored as four little-endian int16 values per character
(x0, y0, x1, y1) in 0.5-pt units relative to the CropBox's lower-left corner,
then base64-encoded. An all-zero box means "no box" (generated or hidden
characters).
"""

from __future__ import annotations

import base64
import struct
from collections.abc import Iterable, Sequence
from dataclasses import dataclass

INT16_MIN, INT16_MAX = -32768, 32767


@dataclass(frozen=True)
class Box:
    """Axis-aligned box. Orientation (y up or down) is the caller's convention."""

    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def empty(self) -> bool:
        return self.x1 <= self.x0 or self.y1 <= self.y0

    @property
    def area(self) -> float:
        return 0.0 if self.empty else (self.x1 - self.x0) * (self.y1 - self.y0)

    @property
    def height(self) -> float:
        return max(0.0, self.y1 - self.y0)

    @property
    def width(self) -> float:
        return max(0.0, self.x1 - self.x0)


ZERO_BOX = Box(0.0, 0.0, 0.0, 0.0)


def union(boxes: Iterable[Box]) -> Box:
    real = [b for b in boxes if not b.empty]
    if not real:
        return ZERO_BOX
    return Box(min(b.x0 for b in real), min(b.y0 for b in real), max(b.x1 for b in real), max(b.y1 for b in real))


def intersection_area(a: Box, b: Box) -> float:
    w = min(a.x1, b.x1) - max(a.x0, b.x0)
    h = min(a.y1, b.y1) - max(a.y0, b.y0)
    return w * h if w > 0 and h > 0 else 0.0


def iou(a: Box, b: Box) -> float:
    inter = intersection_area(a, b)
    if inter == 0.0:
        return 0.0
    return inter / (a.area + b.area - inter)


def _to_half_points(v: float) -> int:
    q = round(v * 2)
    return max(INT16_MIN, min(INT16_MAX, q))


def pack_char_boxes(boxes: Sequence[Box]) -> str:
    raw = bytearray()
    for b in boxes:
        if b.empty:
            raw += struct.pack("<4h", 0, 0, 0, 0)
        else:
            raw += struct.pack("<4h", *(_to_half_points(v) for v in (b.x0, b.y0, b.x1, b.y1)))
    return base64.b64encode(bytes(raw)).decode("ascii")


def unpack_char_boxes(encoded: str) -> list[Box]:
    raw = base64.b64decode(encoded)
    if len(raw) % 8:
        raise ValueError("charBoxes length is not a multiple of 8 bytes")
    out: list[Box] = []
    for i in range(0, len(raw), 8):
        x0, y0, x1, y1 = struct.unpack_from("<4h", raw, i)
        out.append(Box(x0 / 2, y0 / 2, x1 / 2, y1 / 2))
    return out


def merge_line_boxes(boxes: Sequence[Box], *, y_tolerance_ratio: float = 0.5) -> list[Box]:
    """Merge consecutive character boxes that sit on one line into one box.

    Two neighbours share a line when their vertical overlap is at least
    `y_tolerance_ratio` of the smaller height. Empty boxes are skipped, so a
    span of visible characters always yields at least one box.
    """
    merged: list[Box] = []
    for b in boxes:
        if b.empty:
            continue
        if merged:
            last = merged[-1]
            overlap = min(last.y1, b.y1) - max(last.y0, b.y0)
            smaller = min(last.height, b.height) or 1.0
            if overlap >= y_tolerance_ratio * smaller:
                merged[-1] = union((last, b))
                continue
        merged.append(b)
    return merged
