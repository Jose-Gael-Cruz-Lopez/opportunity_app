"""Shared word lists: status terms, key-window cues, volatile masks and sentence splitting.

The production status lexicon lives in the Worker's private `config` table so it can grow
without a release; this module holds the public excerpt from the plan, and callers may pass
extra terms. Every function is pure.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence

from .dates import date_tokens

# Public excerpt of the status lexicon (plan 4.6). Order does not matter; matches are casefolded.
STATUS_TERMS: tuple[str, ...] = (
    "paused", "suspended", "cancelled", "canceled", "cancellation", "closed", "reopened", "reopens",
    "extended", "extension", "postponed", "discontinued", "on hold", "on pause", "open", "opens",
    "opened", "now accepting", "accepting applications", "not accepted", "not being accepted",
    "no longer", "will not run", "will not take place", "will not be held", "will not be offered",
    "not offered", "unavailable", "terminated", "eliminated", "delayed", "rescheduled", "deferred",
    "halted", "waitlist", "ended",
)  # fmt: skip

# Status tokens that, when newly present, make a KEY change urgent (plan 4.6 table, row 3).
URGENT_STATUS_TERMS: frozenset[str] = frozenset(
    {"paused", "ended", "suspended", "cancelled", "canceled", "cancellation", "closed", "discontinued",
     "terminated", "eliminated", "halted", "on hold", "on pause", "will not run",
     "will not take place", "will not be held", "will not be offered", "no longer"}
)  # fmt: skip

# Words that make a sentence part of a key window (plan 4.6): deadlines, eligibility, money.
KEY_CUES = re.compile(
    r"\b(?:deadlines?|due|apply|application|applications|open(?:s|ed|ing)?|clos(?:e|es|ed|ing)"
    r"|eligib\w*|citizen\w*|permanent resident\w*|gpa|grade point|class year|freshm[ae]n|first[- ]year"
    r"|sophomores?|juniors?|seniors?|stipend|salary|award|nominat\w*|cohort|cycle)\b",
    re.I,
)

_SENTENCE_END = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])|\n+")


def status_pattern(extra: Iterable[str] = ()) -> re.Pattern[str]:
    terms = sorted({*STATUS_TERMS, *(t.lower() for t in extra)}, key=len, reverse=True)
    return re.compile(r"\b(?:" + "|".join(re.escape(t) for t in terms) + r")\b", re.I)


_DEFAULT_STATUS = status_pattern()


def split_sentences(text: str) -> list[str]:
    """Sentence split good enough for windows: line breaks and terminal punctuation."""
    return [s.strip() for s in _SENTENCE_END.split(text) if s and s.strip()]


def status_terms(text: str, pattern: re.Pattern[str] = _DEFAULT_STATUS) -> list[str]:
    return sorted({m.group(0).lower() for m in pattern.finditer(text)})


def is_key_sentence(sentence: str, pattern: re.Pattern[str] = _DEFAULT_STATUS) -> bool:
    return bool(KEY_CUES.search(sentence) or pattern.search(sentence) or date_tokens(sentence))


def key_windows(text: str, pattern: re.Pattern[str] = _DEFAULT_STATUS) -> list[str]:
    """Each key sentence with one sentence of context on either side, merged and in page order."""
    sentences = split_sentences(text)
    keep: set[int] = set()
    for i, s in enumerate(sentences):
        if is_key_sentence(s, pattern):
            keep.update(j for j in (i - 1, i, i + 1) if 0 <= j < len(sentences))
    windows: list[str] = []
    run: list[str] = []
    for i, s in enumerate(sentences):
        if i in keep:
            run.append(s)
        elif run:
            windows.append(" ".join(run))
            run = []
    if run:
        windows.append(" ".join(run))
    return windows


def watch_tokens(text: str, pattern: re.Pattern[str] = _DEFAULT_STATUS) -> list[str]:
    """Date and status tokens in page order: the detection-only fingerprint of the watch text."""
    return [*date_tokens(text), *(m.group(0).lower() for m in pattern.finditer(text))]


def compile_masks(patterns: Sequence[str]) -> list[re.Pattern[str]]:
    """Curator-set volatile patterns ("Last updated ...", webinar lists); invalid ones are skipped."""
    out: list[re.Pattern[str]] = []
    for p in patterns:
        try:
            out.append(re.compile(p, re.I))
        except re.error:
            continue
    return out


def apply_masks(text: str, masks: Sequence[re.Pattern[str]]) -> str:
    for m in masks:
        text = m.sub(" ", text)
    return text
