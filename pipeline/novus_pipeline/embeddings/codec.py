"""int8 vector encoding for the release file (shared/matching/embeddings.ts decodes it).

q_i = round(127 * x_i / max|x|) with halves away from zero, stored as two's-complement bytes in
standard base64. Cosine similarity is scale-free, so no scale is stored; the Worker renormalizes.
"""

from __future__ import annotations

import base64
import math
from collections.abc import Sequence


def encode_int8(values: Sequence[float]) -> str:
    peak = max((abs(float(x)) for x in values), default=0.0)
    out = bytearray(len(values))
    for i, x in enumerate(values):
        x = float(x)
        if not math.isfinite(x):
            raise ValueError("vector has a non-finite value")
        q = 0 if peak == 0 else int(math.copysign(math.floor((127 * abs(x)) / peak + 0.5), x))
        out[i] = q & 0xFF
    return base64.b64encode(bytes(out)).decode("ascii")


def decode_int8(b64: str, dims: int) -> list[float] | None:
    """Unit-length floats, or None for a wrong length or an all-zero vector (tests and checks)."""
    try:
        raw = base64.b64decode(b64, validate=True)
    except ValueError:
        return None
    if len(raw) != dims:
        return None
    ints = [b - 256 if b > 127 else b for b in raw]
    norm = math.sqrt(sum(v * v for v in ints))
    if norm == 0:
        return None
    return [v / norm for v in ints]


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return sum(x * y for x, y in zip(a, b, strict=True)) / (na * nb)
