"""Text normalization shared by the normalizer, the change detector and the evidence locator.

One function decides what "the same text" means, so a quote normalized here and a page
normalized here compare byte for byte. Offsets in FieldEvidence always point into text that has
already passed through `normalize_text`, so no offset map back to raw bytes is needed.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata

# Typographic quotes, dashes and spaces that pages use interchangeably with ASCII forms.
_TRANSLATE = str.maketrans(
    {
        "‘": "'",
        "’": "'",
        "‚": "'",
        "‛": "'",
        "′": "'",
        "“": '"',
        "”": '"',
        "„": '"',
        "‟": '"',
        "″": '"',
        "«": '"',
        "»": '"',
        "‐": "-",
        "‑": "-",
        "‒": "-",
        "–": "-",
        "—": "-",
        "―": "-",
        "−": "-",
        " ": " ",
        " ": " ",
        " ": " ",
    }
)
# Zero-width characters and soft hyphens hide inside words and break exact matching.
_INVISIBLE = re.compile("[​‌‍⁠﻿­]")
_SPACES = re.compile(r"[ \t\f\v\r]+")
_BLANK_LINES = re.compile(r"\n\s*\n+")
_WORD = re.compile(r"[^\W_]+")


def normalize_text(text: str) -> str:
    """NFKC, plain quotes and dashes, no zero-width characters, collapsed spaces per line."""
    text = unicodedata.normalize("NFKC", text)
    text = _INVISIBLE.sub("", text).translate(_TRANSLATE)
    lines = [_SPACES.sub(" ", line).strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line)


def normalize_inline(text: str) -> str:
    """Like `normalize_text` but also folds newlines, for quotes and single sentences."""
    return _SPACES.sub(" ", normalize_text(text).replace("\n", " ")).strip()


def words(text: str) -> list[str]:
    """Casefolded word sequence; punctuation and spacing differences disappear."""
    return _WORD.findall(unicodedata.normalize("NFKC", text).casefold())


def sha256_hex(data: bytes | str) -> str:
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def collapse_blank_lines(text: str) -> str:
    return _BLANK_LINES.sub("\n", text)
