"""Two-engine reconciliation: critical-token agreement and field agreement.

Agreement beats confidence (plan 5.3): a critical token is prefilled only
when two independent engines read the same normalized value. Confidence is
carried along for display and evaluation, never used to break a tie.

Page text for an OCR page is the primary (stronger) engine's reading, with
any line only the secondary engine found merged in reading order, so every
token has offsets into the page text.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from itertools import zip_longest
from typing import Literal

from .boxes import Box, union
from .config import DocIntelConfig
from .contracts import (
    Agreement,
    BBox,
    CriticalTokenReport,
    OcrToken,
    Reading,
    TextLayerPage,
    TokenClass,
)
from .critical import CriticalMatch, recognize
from .engines.base import EngineResult, OcrLine
from .matching import match_lines

CLASS_ORDER: tuple[TokenClass, ...] = ("DATE", "TIME", "URL", "EMAIL", "NUMBER", "ELIG_TERM")


@dataclass(frozen=True)
class TokenReading:
    reader: str
    text: str
    norm: str
    box: Box
    conf: float | None


@dataclass
class ReconciledToken:
    cls: TokenClass
    norm: str  # the agreed value, or the primary reading's when disputed
    text: str
    start: int
    end: int
    box: Box
    agreement: Agreement
    readers: list[str]
    readings: list[TokenReading]
    confidence: float | None
    adjudicated: bool = False

    def to_ocr_token(self) -> OcrToken:
        return OcrToken(
            text=self.text,
            start=self.start,
            end=self.end,
            bbox=to_bbox(self.box),
            readers=list(self.readers),
            cls=self.cls,
            agreement=self.agreement,
            readings=[Reading(reader=r.reader, text=r.text) for r in self.readings]
            if self.agreement == "disputed"
            else None,
        )

    def to_report(self, page: int) -> CriticalTokenReport:
        return CriticalTokenReport(
            page=page,
            cls=self.cls,
            norm=self.norm,
            text=self.text,
            start=self.start,
            end=self.end,
            bbox=to_bbox(self.box),
            agreement=self.agreement,
            readers=list(self.readers),
            readings=[Reading(reader=r.reader, text=r.text) for r in self.readings],
            confidence=self.confidence,
            adjudicated=self.adjudicated,
        )


@dataclass
class ReconciledPage:
    page: int
    text: str
    tokens: list[ReconciledToken] = field(default_factory=list)

    def to_layer_page(self) -> TextLayerPage:
        return TextLayerPage(
            page=self.page,
            source="ocr",
            text=self.text,
            tokens=[t.to_ocr_token() for t in self.tokens],
            hidden=[],
        )

    def reports(self) -> list[CriticalTokenReport]:
        return [t.to_report(self.page) for t in self.tokens]


def to_bbox(box: Box) -> BBox:
    return BBox(x0=round(box.x0, 5), y0=round(box.y0, 5), x1=round(box.x1, 5), y1=round(box.y1, 5))


# --------------------------------------------------------------------------- token geometry


def _word_spans(line: OcrLine) -> list[tuple[int, int, int]]:
    """(start, end, word index) of each word inside the line text."""
    spans: list[tuple[int, int, int]] = []
    cursor = 0
    for k, word in enumerate(line.words):
        pos = line.text.find(word.text, cursor)
        if pos < 0:
            continue
        spans.append((pos, pos + len(word.text), k))
        cursor = pos + len(word.text)
    return spans


def token_box(line: OcrLine, start: int, end: int) -> Box:
    """Box of line.text[start:end]: the union of overlapping word boxes when
    the engine gave words, else a proportional slice of the line box."""
    hits = [line.words[k].box for a, b, k in _word_spans(line) if a < end and b > start]
    if hits:
        return union(hits)
    n = max(1, len(line.text))
    w = line.box.x1 - line.box.x0
    return Box(line.box.x0 + w * start / n, line.box.y0, line.box.x0 + w * end / n, line.box.y1)


def token_conf(line: OcrLine, start: int, end: int) -> float | None:
    confs = [
        line.words[k].conf for a, b, k in _word_spans(line) if a < end and b > start and line.words[k].conf is not None
    ]
    if confs:
        return min(c for c in confs if c is not None)
    return line.conf


def _reading(engine: str, line: OcrLine, m: CriticalMatch) -> TokenReading:
    return TokenReading(engine, m.text, m.norm, token_box(line, m.start, m.end), token_conf(line, m.start, m.end))


def align_by_class_and_order(
    a: Sequence[CriticalMatch], b: Sequence[CriticalMatch]
) -> list[tuple[CriticalMatch | None, CriticalMatch | None]]:
    """Pair the n-th token of each class on one side with the n-th of the
    same class on the other. A missing partner stays None (a disagreement)."""
    out: list[tuple[CriticalMatch | None, CriticalMatch | None]] = []
    for cls in CLASS_ORDER:
        xs = [t for t in a if t.cls == cls]
        ys = [t for t in b if t.cls == cls]
        out.extend(zip_longest(xs, ys))
    out.sort(key=lambda pair: (pair[0] or pair[1]).start)  # type: ignore[union-attr]
    return out


# --------------------------------------------------------------------------- page check


@dataclass(frozen=True)
class _PlacedLine:
    engine: str
    line: OcrLine
    partner: OcrLine | None  # matched line of the other engine, if any
    partner_engine: str | None


def _min_conf(values: Sequence[float | None]) -> float | None:
    real = [v for v in values if v is not None]
    return min(real) if real else None


def check_page(
    page: int, primary: EngineResult, secondary: EngineResult, config: DocIntelConfig
) -> ReconciledPage:
    """Compare two engines' readings of one page (plan 5.5.5)."""
    match = match_lines(
        [ln.box for ln in primary.lines], [ln.box for ln in secondary.lines], min_iou=config.match.line_min_iou
    )
    placed: list[_PlacedLine] = []
    for i, j in match.pairs:
        placed.append(_PlacedLine(primary.engine, primary.lines[i], secondary.lines[j], secondary.engine))
    for i in match.lone_a:
        placed.append(_PlacedLine(primary.engine, primary.lines[i], None, None))
    for j in match.lone_b:
        placed.append(_PlacedLine(secondary.engine, secondary.lines[j], None, None))
    # Reading order: top to bottom, then left to right.
    placed.sort(key=lambda p: (round(p.line.box.y0, 3), p.line.box.x0))

    parts: list[str] = []
    tokens: list[ReconciledToken] = []
    offset = 0
    for item in placed:
        line = item.line
        base = offset
        parts.append(line.text)
        offset += len(line.text) + 1  # "\n" separator
        own = recognize(line.text)
        if item.partner is None:
            for m in own:
                r = _reading(item.engine, line, m)
                tokens.append(
                    ReconciledToken(m.cls, m.norm, m.text, base + m.start, base + m.end, r.box, "single",
                                    [item.engine], [r], r.conf)
                )
            continue
        partner_engine = item.partner_engine or secondary.engine
        theirs = recognize(item.partner.text)
        for x, y in align_by_class_and_order(own, theirs):
            rx = _reading(item.engine, line, x) if x else None
            ry = _reading(partner_engine, item.partner, y) if y else None
            readings = [r for r in (rx, ry) if r is not None]
            if x and y and x.cls == y.cls and x.norm == y.norm and rx and ry:
                tokens.append(
                    ReconciledToken(x.cls, x.norm, x.text, base + x.start, base + x.end, union((rx.box, ry.box)),
                                    "agreed", [item.engine, partner_engine], readings, _min_conf([rx.conf, ry.conf]))
                )
            elif x and rx:
                tokens.append(
                    ReconciledToken(x.cls, x.norm, x.text, base + x.start, base + x.end,
                                    union(r.box for r in readings), "disputed", [item.engine, partner_engine],
                                    readings, None)
                )
            elif y and ry:
                # Only the secondary engine saw this token, so it has no
                # place in the primary's text: anchor it to the whole line.
                tokens.append(
                    ReconciledToken(y.cls, y.norm, y.text, base, base + len(line.text), ry.box, "disputed",
                                    [item.engine, partner_engine], readings, None)
                )
    return ReconciledPage(page=page, text="\n".join(parts), tokens=tokens)


# --------------------------------------------------------------------------- field agreement

FieldStatus = Literal["agreed", "disputed", "single", "missing"]


@dataclass(frozen=True)
class FieldReading:
    value: str | None  # normalized value; None when the engine found nothing
    text: str = ""
    conf: float | None = None
    page: int | None = None
    start: int | None = None
    end: int | None = None


@dataclass(frozen=True)
class FieldDecision:
    name: str
    status: FieldStatus
    value: str | None
    readers: tuple[str, ...]
    readings: tuple[tuple[str, FieldReading], ...]
    confidence: float | None


def reconcile_fields(
    readings_by_engine: Mapping[str, Mapping[str, FieldReading]],
    fields: Sequence[str],
    *,
    min_agreeing: int = 2,
) -> dict[str, FieldDecision]:
    """Field-level agreement across engines (for example Program, decision
    and date on a decision letter, plan 5.6.2).

    A field is `agreed` only when at least `min_agreeing` engines produced
    the same normalized value and no engine produced a different one. Any
    conflicting value makes it `disputed`; a field one engine alone found is
    `single`; nobody found it, `missing`. There is no majority vote: a third
    engine can veto agreement but never outvote a dissenting one.
    """
    out: dict[str, FieldDecision] = {}
    for name in fields:
        present = [
            (engine, fields_map[name])
            for engine, fields_map in readings_by_engine.items()
            if name in fields_map and fields_map[name].value is not None
        ]
        values = {r.value for _, r in present}
        readers = tuple(engine for engine, _ in present)
        conf = _min_conf([r.conf for _, r in present])
        if not present:
            out[name] = FieldDecision(name, "missing", None, (), (), None)
        elif len(values) > 1:
            out[name] = FieldDecision(name, "disputed", None, readers, tuple(present), None)
        elif len(present) >= min_agreeing:
            out[name] = FieldDecision(name, "agreed", present[0][1].value, readers, tuple(present), conf)
        else:
            out[name] = FieldDecision(name, "single", present[0][1].value, readers, tuple(present), conf)
    return out
