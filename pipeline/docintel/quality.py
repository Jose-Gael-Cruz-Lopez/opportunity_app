"""Text-layer quality signals and page triage.

A page is `born_digital` when it has at least 50 printable characters and
under 15% garbage tokens (plan 5.4.2). The score is a diagnostic for the
console and the evaluation report; triage uses the rules, not the score.
"""

from __future__ import annotations

import difflib
import unicodedata
from dataclasses import dataclass
from typing import Literal

from .config import TriageRules

PageStatus = Literal["born_digital", "blank", "failing"]


def is_private_use(c: str) -> bool:
    return unicodedata.category(c) == "Co"


def is_garbage_token(token: str) -> bool:
    """A token is garbage when it holds U+FFFD or a private-use code point, or
    when letters and digits make up under half of its characters. Common
    punctuation-only tokens ("-", "&", "|") count as garbage too; a page made
    of them has no usable text anyway."""
    if not token:
        return False
    if "�" in token or any(is_private_use(c) for c in token):
        return True
    alnum = sum(1 for c in token if c.isalnum())
    return alnum * 2 < len(token)


def printable_count(text: str) -> int:
    return sum(1 for c in text if c.isprintable() and not c.isspace())


def cross_reader_agreement(a: str, b: str) -> float:
    """Similarity of two independent readings of the same page, comparing
    non-whitespace characters only, since the two libraries space words
    differently. 1.0 means identical character sequences."""
    sa = "".join(a.split())
    sb = "".join(b.split())
    if not sa and not sb:
        return 1.0
    return difflib.SequenceMatcher(None, sa, sb, autojunk=False).ratio()


@dataclass(frozen=True)
class PageSignals:
    printable_chars: int
    tokens: int
    garbage_tokens: int
    unicode_map_errors: int
    has_images: bool
    cross_reader_agreement: float | None

    @property
    def garbage_ratio(self) -> float:
        return self.garbage_tokens / self.tokens if self.tokens else 0.0


def page_signals(
    text: str,
    *,
    unicode_map_errors: int = 0,
    has_images: bool = False,
    other_reading: str | None = None,
    own_reading: str | None = None,
) -> PageSignals:
    """Signals for one page. `own_reading` (default: `text`) is what gets
    compared with `other_reading`, the second library's reading."""
    tokens = text.split()
    mine = text if own_reading is None else own_reading
    return PageSignals(
        printable_chars=printable_count(text),
        tokens=len(tokens),
        garbage_tokens=sum(1 for t in tokens if is_garbage_token(t)),
        unicode_map_errors=unicode_map_errors,
        has_images=has_images,
        cross_reader_agreement=None
        if other_reading is None
        else round(cross_reader_agreement(mine, other_reading), 4),
    )


def classify_page(signals: PageSignals, rules: TriageRules) -> PageStatus:
    if signals.printable_chars == 0:
        # An image with no text is a scan, not a blank page.
        return "failing" if signals.has_images else "blank"
    if signals.printable_chars >= rules.min_printable_chars and signals.garbage_ratio < rules.max_garbage_ratio:
        return "born_digital"
    return "failing"


def quality_score(signals: PageSignals, rules: TriageRules) -> float:
    """coverage x cleanliness x agreement, each in [0, 1].

    coverage    = printable / min_printable (capped at 1)
    cleanliness = 1 - garbage_ratio / max_garbage_ratio (floored at 0)
    agreement   = cross-reader similarity, or 1 when the second reader failed
    """
    coverage = min(1.0, signals.printable_chars / rules.min_printable_chars)
    cleanliness = max(0.0, 1.0 - signals.garbage_ratio / rules.max_garbage_ratio)
    agreement = 1.0 if signals.cross_reader_agreement is None else signals.cross_reader_agreement
    return round(coverage * cleanliness * agreement, 4)


def document_triage(statuses: list[PageStatus]) -> Literal["born_digital", "no_text_layer"]:
    """Conservative: every page must pass or be blank, and at least one must
    pass. One scanned page sends the whole PDF to manual curation."""
    if statuses and all(s in ("born_digital", "blank") for s in statuses) and "born_digital" in statuses:
        return "born_digital"
    return "no_text_layer"
