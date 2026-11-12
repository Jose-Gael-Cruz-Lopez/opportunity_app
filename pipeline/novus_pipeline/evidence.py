"""Evidence locator: is a proposed quote really on the page, unaltered? (plans 4.8 and 8.6)

Fuzzy similarity alone is never evidence: "January 16" scores about 95 against "January 15" in
partial-ratio terms. A quote is accepted only when
- it occurs exactly in the canonical text (or, for Curator quotes, the watch text), or
- an aligned span exists within an edit ratio of 0.05 AND that span has the same word sequence
  and the same critical tokens (digits, months, weekdays, AM/PM, zones, URLs, amounts, and the
  polarity and eligibility words of plan 4.8). Aligned therefore accepts formatting differences
  only (case, punctuation, spacing).
Eligibility, status and nomination fields have no span parser, so they need an exact match.

Values are parsed from the located span, never from the model's `value`; a disagreement adds
VALUE_NOT_IN_SPAN and the parse wins.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from enum import StrEnum
from typing import Literal

from .dates import DEADLINE_CUE, ParsedDeadline, find_dates, find_times, parse_deadline, parse_single_date
from .textnorm import normalize_inline, words

MAX_EDIT_RATIO = 0.05

CRITICAL = re.compile(
    r"\d+|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b"
    r"|\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b[ap]\.?m\b|\bnoon\b|\bmidnight\b"
    r"|\b(?:eastern|central|mountain|pacific|alaska|hawaii|[ecmp][sd]?t|utc|gmt)\b"
    r"|https?://\S+|\$[\d,.]+"
    r"|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b"  # emails
    r"|\b(?:[a-z0-9-]+\.)+(?:gov|edu|org|com|net|mil|io|us)(?:/\S*)?\b",  # scheme-less domains
    re.I,
)
# Plan 4.8: negation, restriction and eligibility words. A dropped "not" or an inserted "only"
# changes meaning without changing any digit, so these are critical too.
ELIGIBILITY_CRITICAL = re.compile(
    r"\b(?:not|no|never|none|non|only|except|excluding|unless|without|ineligible|eligible|cannot"
    r"|can't|must|may|required|preferred|regardless|citizen\w*|resident\w*|national\w*|daca|tps"
    r"|f-1|j-1|undocumented|pell|freshm[ae]n|first-year|sophomores?|juniors?|seniors?|transfer"
    r"|community college|gpa|at least|at most|minimum|maximum|before|after|prior)\b",
    re.I,
)
POLARITY = re.compile(
    r"\b(?:not|no|non|never|neither|nor|without|except|excluding|unless|only|ineligible|cannot|and|or"
    r"|before|after|prior|previously|until|through|between|under|over|at least|at most|minimum|maximum)\b",
    re.I,
)
_URL = re.compile(r"https?://[^\s<>\"')\]]+", re.I)
_AMOUNT = re.compile(r"\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?")
_COUNT = re.compile(r"\b(\d{1,3}(?:,\d{3})+|\d+)\b")


class FieldKind(StrEnum):
    DATE = "date"
    URL = "url"
    AMOUNT = "amount"
    COUNT = "count"
    STATUS = "status"
    ELIGIBILITY = "eligibility"
    NOMINATION = "nomination"
    TEXT = "text"
    DEADLINE = "deadline"
    REQUIREMENT = "requirement"


EXACT_ONLY = frozenset({FieldKind.STATUS, FieldKind.ELIGIBILITY, FieldKind.NOMINATION})
PARSED = frozenset({FieldKind.DATE, FieldKind.URL, FieldKind.AMOUNT, FieldKind.COUNT})

Channel = Literal["canonical", "watch"]
Method = Literal["exact", "aligned"]


def critical_tokens(text: str) -> list[str]:
    toks = [t.lower() for t in CRITICAL.findall(text)]
    toks += [t.lower() for t in ELIGIBILITY_CRITICAL.findall(text)]
    return toks


@dataclass(frozen=True)
class Located:
    method: Method | None
    start: int = 0
    end: int = 0
    channel: Channel = "canonical"
    flags: tuple[str, ...] = ()
    code: str | None = None  # a blocking code when method is None

    @property
    def blocked(self) -> bool:
        return self.method is None

    @classmethod
    def block(cls, code: str) -> Located:
        return cls(method=None, code=code)


class EvidenceText:
    """The text channels of one Snapshot, with offsets into the canonical (or watch) text."""

    def __init__(
        self,
        canonical: str,
        watch: str = "",
        hidden: str = "",
        suspect_ranges: tuple[tuple[int, int], ...] = (),
    ) -> None:
        self.canonical = canonical
        self.watch = watch
        self.hidden = hidden
        self.suspect_ranges = suspect_ranges
        # Newlines become spaces of the same length, so offsets stay valid across both forms.
        self._flat = {"canonical": canonical.replace("\n", " "), "watch": watch.replace("\n", " ")}
        self._word_index: list[tuple[str, int, int]] | None = None

    @classmethod
    def from_doc(cls, doc: object) -> EvidenceText:
        return cls(
            getattr(doc, "canonical_text"),
            getattr(doc, "watch_text", ""),
            getattr(doc, "hidden_text", ""),
            getattr(doc, "suspect_ranges", ()),
        )

    def text(self, channel: Channel = "canonical") -> str:
        return self.canonical if channel == "canonical" else self.watch

    def flat(self, channel: Channel = "canonical") -> str:
        return self._flat[channel]

    def find_all(self, quote: str, channel: Channel = "canonical") -> list[int]:
        hay = self._flat[channel]
        out: list[int] = []
        i = hay.find(quote)
        while i != -1:
            out.append(i)
            i = hay.find(quote, i + 1)
        return out

    def same_line(self, starts: list[int], length: int, channel: Channel = "canonical") -> bool:
        text = self.text(channel)
        lines = {text.count("\n", 0, s) for s in starts} | {text.count("\n", 0, s + length) for s in starts}
        return len(lines) == 1

    def suspect(self, start: int, end: int) -> bool:
        return any(a < end and start < b for a, b in self.suspect_ranges)

    def sentence(self, start: int, end: int, *, pad: int = 0, channel: Channel = "canonical") -> str:
        """The sentence(s) around a span, plus `pad` neighbouring sentences each side."""
        text = self.text(channel)
        boundary = re.compile(r"[.!?](?=\s)|\n")
        left = start
        for i in range(pad + 1):
            # First pass: boundaries ending at or before the span; later passes skip the one found.
            limit = left if i == 0 else max(left - 1, 0)
            prev = [m.end() for m in boundary.finditer(text, 0, limit)]
            left = prev[-1] if prev else 0
        right = max(start, end - 1)  # a quote that ends with its own full stop ends the sentence
        for _ in range(pad + 1):
            nxt = boundary.search(text, right)
            right = nxt.end() if nxt else len(text)
        return text[left:right].strip()

    def window(self, start: int, end: int, chars: int = 240, channel: Channel = "canonical") -> str:
        text = self.text(channel)
        return text[max(0, start - chars) : min(len(text), end + chars)]

    def words_with_offsets(self) -> list[tuple[str, int, int]]:
        if self._word_index is None:
            self._word_index = [
                (m.group(0).casefold(), m.start(), m.end()) for m in re.finditer(r"[^\W_]+", self._flat["canonical"])
            ]
        return self._word_index


def _banded_levenshtein(a: str, b: str, limit: int) -> int:
    """Edit distance, or limit + 1 once it is certain to exceed `limit` (cheap for long text)."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        lo = max(1, i - limit)
        hi = min(len(b), i + limit)
        cur = [limit + 1] * (len(b) + 1)
        cur[0] = i if i <= limit else limit + 1
        best = cur[0]
        for j in range(lo, hi + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            v = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            cur[j] = v
            if v < best:
                best = v
        if best > limit:
            return limit + 1
        prev = cur
    return prev[len(b)]


def align(src: EvidenceText, quote: str, max_edit_ratio: float = MAX_EDIT_RATIO) -> tuple[int, int] | None:
    """Best canonical span within the edit budget, found around anchor words of the quote."""
    q_words = words(quote)
    if not q_words:
        return None
    limit = max(1, int(len(quote) * max_edit_ratio))
    index = src.words_with_offsets()
    if not index:
        return None
    anchors = sorted({(len(w), k, w) for k, w in enumerate(q_words)}, reverse=True)[:3]
    flat = src.flat("canonical")
    q_fold = quote.casefold()
    best: tuple[int, int, int] | None = None
    seen: set[tuple[int, int]] = set()
    n = len(q_words)
    for _, k, anchor in anchors:
        hits = [j for j, (w, _, _) in enumerate(index) if w == anchor][:200]
        for j in hits:
            for start_word in range(j - k - 1, j - k + 2):
                for length in (n - 1, n, n + 1):
                    a, b = start_word, start_word + length - 1
                    if a < 0 or b >= len(index) or length < 1 or (a, b) in seen:
                        continue
                    seen.add((a, b))
                    s, e = index[a][1], index[b][2]
                    # Keep trailing punctuation when the quote carries it ("residents." vs "residents").
                    if not quote[-1].isalnum():
                        while e < len(flat) and not flat[e].isspace() and not flat[e].isalnum():
                            e += 1
                    d = _banded_levenshtein(q_fold, flat[s:e].casefold(), limit)
                    if d <= limit and (best is None or d < best[0]):
                        best = (d, s, e)
    return (best[1], best[2]) if best else None


def locate(src: EvidenceText, quote: str, kind: FieldKind, *, allow_watch: bool = False) -> Located:
    """Find `quote` on the page. Curator quotes may use the watch text; model quotes may not."""
    q = normalize_inline(quote)
    if not q:
        return Located.block("QUOTE_NOT_ON_PAGE")
    channels: tuple[Channel, ...] = ("canonical", "watch") if allow_watch else ("canonical",)
    for channel in channels:
        starts = src.find_all(q, channel)
        if not starts:
            continue
        flags: list[str] = []
        if len(starts) > 1 and not src.same_line(starts, len(q), channel):
            flags.append("AMBIGUOUS_QUOTE")
        s = starts[0]
        if channel == "canonical" and src.suspect(s, s + len(q)):
            flags.append("HIDDEN_TEXT_SUSPECT")
        return Located("exact", s, s + len(q), channel, tuple(flags))

    span = align(src, q)
    if span is None:
        if q in src.hidden.replace("\n", " "):
            return Located.block("HIDDEN_TEXT")
        return Located.block("QUOTE_NOT_ON_PAGE")
    found = src.flat("canonical")[span[0] : span[1]]
    if kind in EXACT_ONLY:
        return Located.block("QUOTE_ALTERED")
    if words(q) != words(found) or critical_tokens(q) != critical_tokens(found):
        return Located.block("QUOTE_ALTERED")
    flags = ("HIDDEN_TEXT_SUSPECT",) if src.suspect(*span) else ()
    return Located("aligned", span[0], span[1], "canonical", flags)


@dataclass
class FieldCheck:
    """The evidence outcome for one proposed field."""

    field_id: str
    outcome: Literal["exact", "aligned", "blocked", "not_stated"]
    code: str | None = None
    flags: list[str] = field(default_factory=list)
    start: int | None = None
    end: int | None = None
    channel: Channel = "canonical"
    parsed_value: str | None = None
    parsed_deadline: ParsedDeadline | None = None

    @property
    def blocked(self) -> bool:
        return self.outcome == "blocked"

    @property
    def quote_ok(self) -> bool:
        return self.outcome in ("exact", "aligned")


def normalize_url(url: str) -> str:
    u = url.strip().rstrip(".,;")
    m = re.match(r"(?i)(https?)://([^/?#]+)(.*)", u)
    if not m:
        return u
    rest = m.group(3) or "/"
    return f"{m.group(1).lower()}://{m.group(2).lower()}{rest.rstrip('/') or '/'}"


def parse_amount_cents(text: str) -> int | None:
    m = _AMOUNT.search(text)
    if not m:
        return None
    return int(m.group(1).replace(",", "")) * 100 + int(m.group(2) or 0)


def parse_count(text: str) -> int | None:
    for m in _COUNT.finditer(text):
        # Skip years and parts of dates, which are not counts.
        if any(d.start <= m.start() < d.end for d in find_dates(text)):
            continue
        return int(m.group(1).replace(",", ""))
    return None


def parse_value(kind: FieldKind, span_text: str, window: str, reference: date) -> str | None:
    if kind is FieldKind.DATE:
        got = parse_single_date(span_text, reference=reference) or parse_single_date(window, reference=reference)
        return got[0] if got else None
    if kind is FieldKind.URL:
        m = _URL.search(span_text)
        return normalize_url(m.group(0)) if m else None
    if kind is FieldKind.AMOUNT:
        cents = parse_amount_cents(span_text)
        return str(cents) if cents is not None else None
    if kind is FieldKind.COUNT:
        n = parse_count(span_text)
        return str(n) if n is not None else None
    return None


def model_value_as(kind: FieldKind, value: str, reference: date) -> str | None:
    """Bring a model's free-form value into the parse's form for comparison only."""
    return parse_value(kind, value, "", reference) if value else None


def check_leaf(
    src: EvidenceText,
    field_id: str,
    value: str,
    quote: str,
    status: str,
    kind: FieldKind,
    fetched_at: date,
    *,
    allow_watch: bool = False,
) -> FieldCheck:
    if status == "not_stated":
        if value == "" and quote == "":
            return FieldCheck(field_id, "not_stated")
        return FieldCheck(field_id, "blocked", code="NOT_STATED_WITH_VALUE")
    loc = locate(src, quote, kind, allow_watch=allow_watch)
    if loc.blocked:
        return FieldCheck(field_id, "blocked", code=loc.code)
    assert loc.method is not None
    check = FieldCheck(field_id, loc.method, flags=list(loc.flags), start=loc.start, end=loc.end, channel=loc.channel)
    span_text = src.flat(loc.channel)[loc.start : loc.end]
    if kind in PARSED:
        parsed = parse_value(kind, span_text, src.window(loc.start, loc.end, channel=loc.channel), fetched_at)
        check.parsed_value = parsed
        if parsed is None or parsed != model_value_as(kind, value, fetched_at):
            check.flags.append("VALUE_NOT_IN_SPAN")
    elif kind in (FieldKind.ELIGIBILITY, FieldKind.STATUS, FieldKind.NOMINATION):
        if POLARITY.search(src.sentence(loc.start, loc.end, pad=1, channel=loc.channel)):
            check.flags.append("POLARITY_REVIEW")
    if status == "ambiguous":
        check.flags.append("AMBIGUOUS_STATUS")
    return check


def _model_time(local_time: str) -> str | None:
    if not local_time:
        return None
    if re.fullmatch(r"[0-2]\d:[0-5]\d", local_time):
        return local_time
    times = find_times(local_time)
    return times[0].hhmm if times else None


def _model_date(local_date: str, reference: date) -> str | None:
    if not local_date:
        return None
    if re.fullmatch(r"\d{4}-\d{2}(?:-\d{2})?", local_date):
        return local_date
    got = parse_single_date(local_date, reference=reference)
    return got[0] if got else None


def check_deadline(
    src: EvidenceText,
    field_id: str,
    *,
    quote: str,
    status: str,
    local_date: str,
    local_time: str,
    tz_mode: str,
    fetched_at: date,
    allow_watch: bool = False,
) -> FieldCheck:
    """One DeadlineDraft: locate its quote, parse date, time and zone from the page sentence."""
    if status == "not_stated":
        if quote == "" and local_date == "":
            return FieldCheck(field_id, "not_stated")
        return FieldCheck(field_id, "blocked", code="NOT_STATED_WITH_VALUE")
    loc = locate(src, quote, FieldKind.DEADLINE, allow_watch=allow_watch)
    if loc.blocked:
        return FieldCheck(field_id, "blocked", code=loc.code)
    assert loc.method is not None
    check = FieldCheck(field_id, loc.method, flags=list(loc.flags), start=loc.start, end=loc.end, channel=loc.channel)
    sentence = src.sentence(loc.start, loc.end, channel=loc.channel)
    if not (find_dates(sentence) and DEADLINE_CUE.search(sentence)):
        check.flags.append("KIND_UNSUPPORTED")  # "January 15" under "Info session" is no deadline
    parsed = parse_deadline(sentence, context=src.window(loc.start, loc.end, channel=loc.channel), reference=fetched_at)
    check.parsed_deadline = parsed
    if tz_mode == "not_stated" or (parsed and parsed.local_time and parsed.tz_mode is None):
        check.flags.append("TZ_MISSING")
    if parsed is None:
        check.flags.append("VALUE_NOT_IN_SPAN")
        return check
    check.parsed_value = parsed.local_date
    if parsed.year_inferred:
        check.flags.append("YEAR_INFERRED")
    if parsed.weekday_mismatch:
        check.flags.append("WEEKDAY_MISMATCH")
    if parsed.time_ambiguous:
        check.flags.append("TIME_AMBIGUOUS")
    if len(set(parsed.all_dates)) > 1 and DEADLINE_CUE.search(sentence):
        # Two dates in one deadline sentence: the parse picked one; a Curator confirms which.
        check.flags.append("MULTIPLE_DATES_IN_SENTENCE")
    same_date = _model_date(local_date, fetched_at) == parsed.local_date
    same_time = _model_time(local_time) == parsed.local_time
    same_mode = tz_mode == "not_stated" or parsed.tz_mode is None or tz_mode == parsed.tz_mode
    if not (same_date and same_time and same_mode):
        check.flags.append("VALUE_NOT_IN_SPAN")
    return check
