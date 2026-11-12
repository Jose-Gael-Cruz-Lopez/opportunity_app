"""Span parsers for dates, times and time zones (one grammar, reused by every caller).

Values are parsed from the located page span and its window, never from a model's `value`
field. The grammar is deliberately small and explicit: anything it cannot read becomes a review
finding rather than a guess.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date

MONTHS: dict[str, int] = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4,
    "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9, "sept": 9,
    "september": 9, "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}  # fmt: skip
WEEKDAYS: dict[str, int] = {
    "mon": 0, "monday": 0, "tue": 1, "tues": 1, "tuesday": 1, "wed": 2, "wednesday": 2,
    "thu": 3, "thur": 3, "thurs": 3, "thursday": 3, "fri": 4, "friday": 4, "sat": 5,
    "saturday": 5, "sun": 6, "sunday": 6,
}  # fmt: skip

_MON = r"(?P<mon>jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
_WD = r"(?:(?P<wd>mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\.?,?\s+)?"
_DAY = r"(?P<day>[0-3]?\d)(?:st|nd|rd|th)?"
_YEAR = r"(?P<year>(?:19|20)\d{2})"

_DATE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("iso", re.compile(r"\b(?P<year>(?:19|20)\d{2})-(?P<m>[01]\d)-(?P<day>[0-3]\d)\b")),
    ("mdy_name", re.compile(rf"\b{_WD}{_MON}\.?\s+{_DAY}\b(?:,?\s+{_YEAR}\b)?", re.I)),
    ("dmy_name", re.compile(rf"\b{_WD}{_DAY}\s+(?:of\s+)?{_MON}\.?(?:,?\s+{_YEAR}\b)?", re.I)),
    ("mdy_num", re.compile(r"\b(?P<m>[01]?\d)/(?P<day>[0-3]?\d)/(?P<year>(?:19|20)?\d{2})\b")),
    ("month_year", re.compile(rf"\b{_MON}\.?,?\s+{_YEAR}\b", re.I)),
)

_TIME = re.compile(
    r"\b(?P<h>[01]?\d)(?::(?P<m>[0-5]\d))?\s*(?P<ampm>[ap])\.?\s?m\b\.?"
    r"|\b(?P<noon>noon)\b|\b(?P<midnight>midnight)\b"
    r"|\b(?P<h24>[01]?\d|2[0-3]):(?P<m24>[0-5]\d)\b",
    re.I,
)

# Zone words to IANA zones. Long names match in any case; abbreviations only in capitals, so
# "et al." or a lowercase "ct" never reads as a zone. DST forms map to the same zone because the
# stored value is the zone, and the published instant is computed from it (shared/time).
_I = re.I
_ZONES: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"\b(?:anywhere on earth)\b", _I), "Etc/GMT+12"),
    (re.compile(r"\bAoE\b"), "Etc/GMT+12"),
    (re.compile(r"\bhawaii(?:an)?(?:[- ]aleutian)?(?: standard)? time\b", _I), "Pacific/Honolulu"),
    (re.compile(r"\bH(?:A)?ST\b"), "Pacific/Honolulu"),
    (re.compile(r"\balaska(?:n)?(?: standard| daylight)? time\b", _I), "America/Anchorage"),
    (re.compile(r"\bAK[SD]?T\b"), "America/Anchorage"),
    (re.compile(r"\bsamoa(?: standard)? time\b", _I), "Pacific/Pago_Pago"),
    (re.compile(r"\bSST\b"), "Pacific/Pago_Pago"),
    (re.compile(r"\bchamorro(?: standard)? time\b", _I), "Pacific/Guam"),
    (re.compile(r"\bChST\b"), "Pacific/Guam"),
    (re.compile(r"\batlantic(?: standard| daylight)? time\b", _I), "America/Puerto_Rico"),
    (re.compile(r"\bA[SD]T\b"), "America/Puerto_Rico"),
    (re.compile(r"\barizona time\b", _I), "America/Phoenix"),
    (re.compile(r"\beastern(?: standard| daylight| prevailing)?(?: time)?\b", _I), "America/New_York"),
    (re.compile(r"\bE[SD]?T\b"), "America/New_York"),
    (re.compile(r"\bcentral(?: standard| daylight| prevailing)?(?: time)?\b", _I), "America/Chicago"),
    (re.compile(r"\bC[SD]?T\b"), "America/Chicago"),
    (re.compile(r"\bmountain(?: standard| daylight| prevailing)?(?: time)?\b", _I), "America/Denver"),
    (re.compile(r"\bM[SD]?T\b"), "America/Denver"),
    (re.compile(r"\bpacific(?: standard| daylight| prevailing)?(?: time)?\b", _I), "America/Los_Angeles"),
    (re.compile(r"\bP[SD]?T\b"), "America/Los_Angeles"),
    (re.compile(r"\b(?:coordinated universal time|greenwich mean time)\b", _I), "UTC"),
    (re.compile(r"\b(?:UTC|GMT)\b"), "UTC"),
)
_APPLICANT_LOCAL = re.compile(
    r"\byour (?:own )?(?:local )?time ?zone\b|\byour local time\b|\bapplicant'?s?'? (?:own )?local time\b"
    r"|\blocal time (?:of|for|in) (?:the )?(?:applicant|student|your)\b|\bin your (?:own )?time ?zone\b",
    re.I,
)
DEADLINE_CUE = re.compile(
    r"\b(?:deadline|due|clos\w*|submi\w*|postmark\w*|received|apply by|priority|no later than|must be in)\b", re.I
)


@dataclass(frozen=True)
class DateMatch:
    start: int
    end: int
    year: int | None
    month: int
    day: int | None
    weekday: int | None  # 0 = Monday, when the page names one

    @property
    def iso(self) -> str:
        """Comparable token: YYYY-MM-DD, YYYY-MM for month-only, --MM-DD when the year is absent."""
        if self.day is None:
            return f"{self.year:04d}-{self.month:02d}" if self.year else f"--{self.month:02d}"
        if self.year is None:
            return f"--{self.month:02d}-{self.day:02d}"
        return f"{self.year:04d}-{self.month:02d}-{self.day:02d}"


@dataclass(frozen=True)
class TimeMatch:
    start: int
    end: int
    hhmm: str
    ambiguous: bool  # "midnight" is read as 23:59 of the named day, which a Curator confirms


@dataclass(frozen=True)
class ZoneMatch:
    start: int
    end: int
    iana: str | None
    applicant_local: bool
    text: str


@dataclass
class ParsedDeadline:
    local_date: str  # YYYY-MM-DD, or YYYY-MM when only a month is stated
    local_time: str | None
    time_zone: str | None
    tz_mode: str | None  # "fixed" | "applicant_local" | None when no zone wording exists
    precision: str  # "exact" | "date_only" | "month_only"
    year_inferred: bool = False
    weekday_mismatch: bool = False
    time_ambiguous: bool = False
    all_dates: list[str] = field(default_factory=list)


def _valid(year: int | None, month: int, day: int | None) -> bool:
    if not 1 <= month <= 12:
        return False
    if day is None:
        return True
    try:
        date(year or 2000, month, day)  # 2000 is a leap year, so Feb 29 without a year passes
    except ValueError:
        return False
    return True


def _valid_in(year: int, month: int, day: int) -> bool:
    try:
        date(year, month, day)
    except ValueError:
        return False
    return True


def find_dates(text: str) -> list[DateMatch]:
    """Every date in `text`, non-overlapping, earliest first; longer matches win overlaps."""
    found: list[DateMatch] = []
    for kind, pattern in _DATE_PATTERNS:
        for m in pattern.finditer(text):
            g = m.groupdict()
            month = MONTHS[g["mon"].lower().rstrip(".")] if g.get("mon") else int(g["m"])
            day = int(g["day"]) if g.get("day") else None
            year: int | None = int(g["year"]) if g.get("year") else None
            if kind == "mdy_num" and year is not None and year < 100:
                year += 2000
            if not _valid(year, month, day):
                continue
            wd = WEEKDAYS.get(g["wd"].lower().rstrip(".")) if g.get("wd") else None
            found.append(DateMatch(m.start(), m.end(), year, month, day, wd))
    found.sort(key=lambda d: (d.start, -(d.end - d.start)))
    out: list[DateMatch] = []
    for d in found:
        if out and d.start < out[-1].end:
            continue
        out.append(d)
    return out


def date_tokens(text: str) -> list[str]:
    return [d.iso for d in find_dates(text)]


def find_times(text: str) -> list[TimeMatch]:
    out: list[TimeMatch] = []
    for m in _TIME.finditer(text):
        if m.group("noon"):
            out.append(TimeMatch(m.start(), m.end(), "12:00", False))
        elif m.group("midnight"):
            out.append(TimeMatch(m.start(), m.end(), "23:59", True))
        elif m.group("ampm"):
            h = int(m.group("h"))
            if not 1 <= h <= 12:
                continue
            minute = int(m.group("m") or 0)
            pm = m.group("ampm").lower() == "p"
            hour = (h % 12) + (12 if pm else 0)
            out.append(TimeMatch(m.start(), m.end(), f"{hour:02d}:{minute:02d}", False))
        else:
            out.append(TimeMatch(m.start(), m.end(), f"{int(m.group('h24')):02d}:{m.group('m24')}", False))
    return out


def find_zone(text: str) -> ZoneMatch | None:
    """The first zone statement; applicant-local wording wins over a zone abbreviation."""
    local = _APPLICANT_LOCAL.search(text)
    if local:
        return ZoneMatch(local.start(), local.end(), None, True, local.group(0))
    best: ZoneMatch | None = None
    for pattern, iana in _ZONES:
        m = pattern.search(text)
        if m and (best is None or m.start() < best.start):
            best = ZoneMatch(m.start(), m.end(), iana, False, m.group(0))
    return best


def _infer_year(month: int, day: int | None, reference: date) -> int:
    """Next occurrence on or after the reference date; a year-less date is never in the past."""
    if (month, day or 31) < (reference.month, reference.day):
        return reference.year + 1
    return reference.year


def _pick_deadline_date(sentence: str, dates: list[DateMatch]) -> DateMatch:
    """Prefer the first date after a deadline cue ("open Dec 1 and close Jan 15" -> Jan 15)."""
    cues = [m.end() for m in DEADLINE_CUE.finditer(sentence)]
    for cue_end in cues:
        after = [d for d in dates if d.start >= cue_end]
        if after:
            return after[0]
    return dates[0]


def parse_deadline(sentence: str, *, context: str = "", reference: date) -> ParsedDeadline | None:
    """Parse one deadline from its sentence; the zone may come from the surrounding window."""
    dates = find_dates(sentence)
    if not dates:
        return None
    chosen = _pick_deadline_date(sentence, dates)
    year = chosen.year
    inferred = False
    if year is None:
        year = _infer_year(chosen.month, chosen.day, reference)
        inferred = True
    weekday_mismatch = False
    if chosen.day is not None and chosen.weekday is not None and _valid_in(year, chosen.month, chosen.day):
        weekday_mismatch = date(year, chosen.month, chosen.day).weekday() != chosen.weekday

    times = [t for t in find_times(sentence) if not (chosen.start <= t.start < chosen.end)]
    time = min(times, key=lambda t: abs(t.start - chosen.end)) if times else None
    zone = find_zone(sentence) or (find_zone(context) if context else None)

    if chosen.day is None:
        local_date, precision = f"{year:04d}-{chosen.month:02d}", "month_only"
    else:
        local_date = f"{year:04d}-{chosen.month:02d}-{chosen.day:02d}"
        precision = "exact" if time else "date_only"
    tz_mode = None
    time_zone = None
    if zone is not None:
        tz_mode = "applicant_local" if zone.applicant_local else "fixed"
        time_zone = zone.iana
    return ParsedDeadline(
        local_date=local_date,
        local_time=time.hhmm if time else None,
        time_zone=time_zone,
        tz_mode=tz_mode,
        precision=precision,
        year_inferred=inferred,
        weekday_mismatch=weekday_mismatch,
        time_ambiguous=bool(time and time.ambiguous),
        all_dates=[d.iso for d in dates],
    )


def parse_single_date(text: str, *, reference: date) -> tuple[str, bool] | None:
    """The first date in `text` as (YYYY-MM-DD or YYYY-MM, year_inferred)."""
    dates = find_dates(text)
    if not dates:
        return None
    d = dates[0]
    year, inferred = (d.year, False) if d.year else (_infer_year(d.month, d.day, reference), True)
    if d.day is None:
        return f"{year:04d}-{d.month:02d}", inferred
    return f"{year:04d}-{d.month:02d}-{d.day:02d}", inferred


def to_date(local_date: str) -> date | None:
    """`YYYY-MM-DD` to a date; month-only values compare as the last possible day is unknown."""
    try:
        return date.fromisoformat(local_date)
    except ValueError:
        return None
