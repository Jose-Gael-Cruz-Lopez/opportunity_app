"""The change detector and the reopen rule (plan 4.6). The plan's only change detector.

Every new Snapshot is compared with the Source's *baseline* (the Snapshot behind the last Curator
verification), not just the previous fetch, so a change stays visible until a Curator resolves it.
Deterministic signals decide what reaches a person; a model's "unchanged" never closes anything.
"""

from __future__ import annotations

import difflib
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from enum import StrEnum

from .dates import date_tokens, to_date
from .lexicon import URGENT_STATUS_TERMS, status_terms
from .normalize import NormalizedDoc
from .textnorm import normalize_inline

MIN_MAIN_TEXT_RATIO = 0.30
URGENT_WINDOW_DAYS = 21
_ERROR_TITLE = re.compile(
    r"\b(?:not found|404|page (?:cannot|can't|could not) be found|maintenance|temporarily unavailable"
    r"|access denied|forbidden|error|cookie consent|just a moment)\b",
    re.I,
)


class ChangeClass(StrEnum):
    NEW = "new"  # no baseline yet
    NONE = "none"
    INVALID = "invalid"  # soft 404, maintenance or consent page: changes nothing public
    COSMETIC = "cosmetic"
    MINOR = "minor"
    KEY = "key"


@dataclass(frozen=True)
class SnapshotFacts:
    raw_sha256: str
    main_text_sha256: str | None = None
    watch_tokens_sha256: str | None = None
    http_status: int = 200
    bot_challenge: bool = False


@dataclass(frozen=True)
class WindowDiff:
    removed: tuple[str, ...] = ()
    added: tuple[str, ...] = ()


@dataclass(frozen=True)
class Change:
    cls: ChangeClass
    diff: WindowDiff = WindowDiff()
    tokens_changed: bool = False
    missing_quotes: tuple[str, ...] = ()
    invalid_reason: str | None = None

    @property
    def contract_class(self) -> str | None:
        """The shared `ChangeClass` enum has none/cosmetic/minor/key; NEW and INVALID map to null."""
        return self.cls.value if self.cls in (ChangeClass.NONE, ChangeClass.COSMETIC, ChangeClass.MINOR, ChangeClass.KEY) else None


def _present(quote: str, doc: NormalizedDoc) -> bool:
    return doc.visible_contains(quote)


def page_valid(
    cur: SnapshotFacts, doc: NormalizedDoc, base_doc: NormalizedDoc | None, verified_quotes: Sequence[str]
) -> tuple[bool, str | None]:
    """Judgment rules from plan 4.6; an invalid page is re-fetched in 6 hours and changes nothing."""
    if cur.http_status != 200:
        return False, "http_status"
    if cur.bot_challenge:
        return False, "bot_challenge"
    if base_doc is not None:
        base_len = len(base_doc.canonical_text)
        if base_len and len(doc.canonical_text) < MIN_MAIN_TEXT_RATIO * base_len:
            return False, "main_text_shrank"
        if _ERROR_TITLE.search(doc.title) and not _ERROR_TITLE.search(base_doc.title):
            return False, "error_title"
    if len(verified_quotes) >= 2:
        present = sum(1 for q in verified_quotes if _present(q, doc))
        if present * 2 < len(verified_quotes):
            return False, "most_quotes_missing"
    return True, None


def window_diff(old: Sequence[str], new: Sequence[str]) -> WindowDiff:
    removed: list[str] = []
    added: list[str] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=list(old), b=list(new), autojunk=False).get_opcodes():
        if tag in ("replace", "delete"):
            removed.extend(old[i1:i2])
        if tag in ("replace", "insert"):
            added.extend(new[j1:j2])
    return WindowDiff(tuple(removed), tuple(added))


def sorted_dates(windows: Sequence[str]) -> tuple[str, ...]:
    # Compared as values (tuples), not identities: v1's JavaScript compared arrays by reference.
    return tuple(sorted(t for w in windows for t in date_tokens(w)))


def window_status_terms(windows: Sequence[str]) -> tuple[str, ...]:
    return tuple(sorted({t for w in windows for t in status_terms(w)}))


def classify_change(
    base: SnapshotFacts | None,
    cur: SnapshotFacts,
    base_doc: NormalizedDoc | None,
    doc: NormalizedDoc | None,
    verified_quotes: Sequence[str] = (),
) -> Change:
    """Classify the current Snapshot against the baseline. `doc` is None for raw-hash-only PDFs."""
    if base is None:
        return Change(ChangeClass.NEW)
    if cur.raw_sha256 == base.raw_sha256:
        return Change(ChangeClass.NONE)
    if doc is None or base_doc is None:
        # PDFs are compared by raw bytes until the text layer lands: any byte change is KEY.
        return Change(ChangeClass.KEY, tokens_changed=True)
    valid, reason = page_valid(cur, doc, base_doc, verified_quotes)
    if not valid:
        return Change(ChangeClass.INVALID, invalid_reason=reason)
    missing = tuple(q for q in verified_quotes if not _present(q, doc))
    watch_moved = (cur.watch_tokens_sha256 or doc.watch_tokens_sha256) != (
        base.watch_tokens_sha256 or base_doc.watch_tokens_sha256
    )
    main_same = (cur.main_text_sha256 or doc.main_text_sha256) == (base.main_text_sha256 or base_doc.main_text_sha256)
    if main_same and not watch_moved and not missing:
        return Change(ChangeClass.COSMETIC)
    old, new = base_doc.key_windows, doc.key_windows
    if old == new and not watch_moved and not missing:
        return Change(ChangeClass.MINOR)
    tokens = sorted_dates(old) != sorted_dates(new) or window_status_terms(old) != window_status_terms(new) or watch_moved
    return Change(ChangeClass.KEY, window_diff(old, new), tokens_changed=tokens, missing_quotes=missing)


# ------------------------------------------------------------------------------------------
# Reopen rule and task triage (plan 4.6 table)
# ------------------------------------------------------------------------------------------

LAUNCH_FIELDS = frozenset({"deadline", "status", "launch_filter"})


@dataclass(frozen=True)
class VerifiedQuote:
    """A Curator-verified quote and the field family it backs."""

    family: str  # "deadline" | "status" | "launch_filter" | "other"
    quote: str
    deadline_date: str | None = None  # YYYY-MM-DD for deadline quotes


@dataclass(frozen=True)
class Triage:
    task_kind: str | None  # "cycle_update" | "new_program" | None
    reason: str | None  # a REVIEW_REASON_CODES value
    reverify: bool = False  # move the record to `reverifying` (withdraws confidence, publishes nothing)
    urgent: bool = False
    hold_reminders: bool = False
    notes: tuple[str, ...] = field(default_factory=tuple)


def _earlier_date_soon(windows: Sequence[str], verified: date, today: date) -> bool:
    horizon = today + timedelta(days=URGENT_WINDOW_DAYS)
    for w in windows:
        for tok in date_tokens(w):
            d = to_date(tok)
            if d and d < verified and today <= d <= horizon:
                return True
    return False


def triage(change: Change, verified: Sequence[VerifiedQuote], today: date, *, is_pdf: bool = False) -> Triage:
    """Decide the queue and public effect of one classified change. Machines never publish here."""
    if change.cls is ChangeClass.NEW:
        return Triage("new_program", "page_changed")
    if change.cls in (ChangeClass.NONE, ChangeClass.COSMETIC, ChangeClass.MINOR, ChangeClass.INVALID):
        return Triage(None, None)
    if is_pdf:
        return Triage("cycle_update", "pdf_changed")
    missing = {normalize_inline(q) for q in change.missing_quotes}
    gone = [v for v in verified if normalize_inline(v.quote) in missing]
    new_status = set(window_status_terms(change.diff.added)) - set(window_status_terms(change.diff.removed))
    urgent_status = bool(new_status & URGENT_STATUS_TERMS)
    urgent_date = any(
        v.family == "deadline"
        and v.deadline_date
        and (d := to_date(v.deadline_date)) is not None
        and _earlier_date_soon(change.diff.added, d, today)
        for v in gone
    )
    if urgent_status or urgent_date:
        notes = tuple(sorted(new_status & URGENT_STATUS_TERMS)) or ("earlier_deadline",)
        return Triage("cycle_update", "urgent_recheck", reverify=True, urgent=True, hold_reminders=True, notes=notes)
    if any(v.family in LAUNCH_FIELDS for v in gone):
        return Triage("cycle_update", "quote_missing", reverify=True)
    return Triage("cycle_update", "key_change")
