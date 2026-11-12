"""Rules first (plan 4.7): structured data and deadline sentences, each citing its source.

The LLM fills only gaps and conflicts. Rule output also lets a field be labelled `high` when the
rules and the model agree on an exact quote (plan 4.8, confidence labels).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from typing import Any

from .dates import DEADLINE_CUE, parse_deadline, parse_single_date
from .lexicon import split_sentences
from .normalize import NormalizedDoc

_JSONLD_DEADLINE_KEYS = (
    ("applicationDeadline", "application"),
    ("validThrough", "application"),
)
_JSONLD_TYPES = frozenset({"EducationalOccupationalProgram", "JobPosting", "Course", "Event", "Grant", "MonetaryGrant"})


@dataclass(frozen=True)
class RuleDeadline:
    kind: str
    local_date: str
    local_time: str | None
    time_zone: str | None
    tz_mode: str | None
    quote: str  # the sentence, or the JSON-LD key and value
    basis: str  # "jsonld" | "sentence"


def _types(item: dict[str, Any]) -> set[str]:
    t = item.get("@type")
    return {t} if isinstance(t, str) else {x for x in t if isinstance(x, str)} if isinstance(t, list) else set()


def from_jsonld(items: Iterable[dict[str, Any]], reference: date) -> list[RuleDeadline]:
    out: list[RuleDeadline] = []
    for item in items:
        if not (_types(item) & _JSONLD_TYPES):
            continue
        for key, kind in _JSONLD_DEADLINE_KEYS:
            value = item.get(key)
            if not isinstance(value, str) or not value:
                continue
            got = parse_single_date(value[:10], reference=reference)
            if got is None:
                continue
            local_time = value[11:16] if len(value) >= 16 and value[10] == "T" else None
            out.append(RuleDeadline(kind, got[0], local_time, None, None, f"{key}: {value}", "jsonld"))
    return out


def from_sentences(doc: NormalizedDoc, reference: date) -> list[RuleDeadline]:
    """Dates beside deadline words in the canonical text, quoting the whole sentence."""
    out: list[RuleDeadline] = []
    for sentence in split_sentences(doc.canonical_text):
        if not DEADLINE_CUE.search(sentence):
            continue
        parsed = parse_deadline(sentence, reference=reference)
        if parsed is None:
            continue
        out.append(
            RuleDeadline("application", parsed.local_date, parsed.local_time, parsed.time_zone, parsed.tz_mode, sentence, "sentence")
        )
    return out


def extract_rules(doc: NormalizedDoc, reference: date) -> list[RuleDeadline]:
    seen: set[tuple[str, str]] = set()
    out: list[RuleDeadline] = []
    for d in [*from_jsonld(doc.jsonld, reference), *from_sentences(doc, reference)]:
        if (d.local_date, d.quote) in seen:
            continue
        seen.add((d.local_date, d.quote))
        out.append(d)
    return out
