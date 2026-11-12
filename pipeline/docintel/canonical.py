"""Canonical text with one offset map back to source character indices.

Quotes, offsets and boxes all refer to the canonical text, so the locator and
the text layer cannot diverge. The rules follow the pipeline's shared
normalization (NFKC, plain quotes and dashes, collapsed whitespace, no
zero-width characters). One deliberate choice: a whitespace run that
contains a line break collapses to "\n" rather than " ", so page text keeps
its lines for display. When the fetcher's own normalize module lands, this
function should delegate to it and keep only the offset bookkeeping.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass

ZERO_WIDTH = frozenset("​‌‍⁠﻿­")
LINE_BREAKS = frozenset("\n\r  \x0b\x0c\x85")
QUOTE_MAP = {
    "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'", "`": "'",
    "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"', "«": '"', "»": '"',
}
DASH_MAP = {c: "-" for c in "‐‑‒–—―−﹘﹣－"}
PUNCT_MAP = {**QUOTE_MAP, **DASH_MAP}


@dataclass(frozen=True)
class CanonicalText:
    text: str
    # src_ranges[i] = (start, end) of source indices that produced text[i].
    src_ranges: tuple[tuple[int, int], ...]

    def source_span(self, start: int, end: int) -> tuple[int, int]:
        """Source index range covering canonical [start, end)."""
        if start >= end:
            raise ValueError("empty span")
        return self.src_ranges[start][0], self.src_ranges[end - 1][1]

    def canonical_indices_for_source(self, src_start: int, src_end: int) -> list[int]:
        """Canonical positions whose source range intersects [src_start, src_end)."""
        return [i for i, (a, b) in enumerate(self.src_ranges) if a < src_end and b > src_start]


def _clusters(chars: Sequence[str]) -> list[tuple[int, int]]:
    """Group each base character with the combining marks that follow it,
    so NFKC can compose "e" + U+0301 into one character."""
    out: list[tuple[int, int]] = []
    i = 0
    n = len(chars)
    while i < n:
        j = i + 1
        while j < n and len(chars[j]) == 1 and unicodedata.combining(chars[j]):
            j += 1
        out.append((i, j))
        i = j
    return out


def _normalize_cluster(raw: str) -> str:
    text = unicodedata.normalize("NFKC", raw)
    return "".join(PUNCT_MAP.get(c, c) for c in text if c not in ZERO_WIDTH)


def canonicalize(chars: Sequence[str]) -> CanonicalText:
    """Canonicalize a sequence of source characters (one entry per source index).

    Entries may be longer than one code point (PDFium can return surrogate
    pairs as one index); each output character maps to the whole source range
    of the cluster that produced it.
    """
    out_chars: list[str] = []
    out_ranges: list[tuple[int, int]] = []
    ws_start: int | None = None
    ws_end = 0
    ws_newline = False

    def flush_whitespace() -> None:
        nonlocal ws_start, ws_newline
        if ws_start is not None and out_chars:
            out_chars.append("\n" if ws_newline else " ")
            out_ranges.append((ws_start, ws_end))
        ws_start = None
        ws_newline = False

    for start, end in _clusters(chars):
        raw = "".join(chars[start:end])
        if raw and all(c in ZERO_WIDTH for c in raw):
            continue
        norm = _normalize_cluster(raw)
        if not norm:
            continue
        if norm.isspace():
            if ws_start is None:
                ws_start = start
            ws_end = end
            if any(c in LINE_BREAKS for c in raw) or any(c in LINE_BREAKS for c in norm):
                ws_newline = True
            continue
        flush_whitespace()
        for c in norm:
            # A cluster that expands (a ligature) maps every output char to it.
            if c.isspace():
                c = " "
            out_chars.append(c)
            out_ranges.append((start, end))
    # Trailing whitespace is dropped (ws_start discarded).
    return CanonicalText("".join(out_chars), tuple(out_ranges))


def canonicalize_string(text: str) -> CanonicalText:
    """Canonicalize a plain string; source indices are code-point indices."""
    return canonicalize(list(text))


def normalize_for_match(text: str) -> str:
    """Canonical text, lower-cased, used to check a quote is a substring."""
    return canonicalize_string(text).text.lower()
