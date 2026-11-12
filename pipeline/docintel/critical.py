"""Deterministic recognizers for critical tokens.

Critical classes: DATE, TIME, URL, EMAIL, NUMBER and ELIG_TERM (plan 5.5.5).
Two readers must agree exactly on the *normalized* value of each one, and
the normalization is deliberately narrow: no fuzzy matching, so
"goldwater.gov" and "go1dwater.gov" disagree.

Normalized forms:
- DATE   "YYYY-MM-DD", or "--MM-DD" when no year is printed
- TIME   "HH:MM" (24h when a meridiem is printed, else as printed) plus " ZONE"
- URL    scheme and host lower-cased, trailing punctuation removed, path case kept
- EMAIL  local part as printed, domain lower-cased
- NUMBER digits and the decimal point only
- ELIG_TERM lower-cased, hyphens as spaces, periods removed
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .contracts import TokenClass

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4,
    "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9, "sept": 9,
    "september": 9, "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}
_MONTH_ALT = "|".join(sorted(MONTHS, key=len, reverse=True))
DAYS_IN_MONTH = (31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)

ZONES = {
    "et": "ET", "est": "ET", "edt": "ET", "eastern": "ET",
    "ct": "CT", "cst": "CT", "cdt": "CT", "central": "CT",
    "mt": "MT", "mst": "MT", "mdt": "MT", "mountain": "MT",
    "pt": "PT", "pst": "PT", "pdt": "PT", "pacific": "PT",
    "akst": "AKT", "akdt": "AKT", "hst": "HT", "utc": "UTC", "gmt": "UTC",
}
_ZONE_ALT = "|".join(sorted(ZONES, key=len, reverse=True))
# Keep the exact zone abbreviation distinct from its family: "EST" and "EDT"
# both normalize to "ET" because flyers use them interchangeably for the
# same wall-clock time, and the deadline model stores the zone family.

TLDS = (
    "com", "org", "edu", "gov", "net", "mil", "int", "io", "ai", "co", "us", "info", "app", "dev",
    "uk", "ca", "me", "ly", "gl", "gle", "link", "page", "site",
)
_TLD_ALT = "|".join(sorted(TLDS, key=len, reverse=True))

ELIG_TERMS = (
    "first-year", "first year", "freshman", "freshmen", "sophomore", "sophomores", "second-year",
    "second year", "junior", "juniors", "senior", "seniors", "undergraduate", "undergraduates",
    "graduate student", "graduate students", "rising sophomore", "rising junior", "rising senior",
    "u.s. citizen", "us citizen", "u.s. citizens", "us citizens", "citizenship", "permanent resident",
    "permanent residents", "lawful permanent resident", "green card", "daca", "international students",
    "international student", "residency", "in-state", "out-of-state", "pell", "pell grant",
    "pell-eligible", "pell eligible", "first-generation", "first generation", "transfer student",
    "transfer students", "community college", "community colleges",
)
_ELIG_ALT = "|".join(re.escape(t) for t in sorted(ELIG_TERMS, key=len, reverse=True))

EMAIL_RE = re.compile(r"(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
URL_RE = re.compile(
    r"(?<![@\w.-])(?:https?://)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:" + _TLD_ALT + r")\b"
    r"(?:[/?#][^\s<>\"]*)?",
    re.IGNORECASE,
)
DATE_NAMED_RE = re.compile(
    r"\b(?P<mon>" + _MONTH_ALT + r")\.?\s+(?P<day>\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(?P<year>\d{4})\b)?",
    re.IGNORECASE,
)
DATE_DAY_FIRST_RE = re.compile(
    r"\b(?P<day>\d{1,2})(?:st|nd|rd|th)?\s+(?P<mon>" + _MONTH_ALT + r")\.?(?:,?\s+(?P<year>\d{4})\b)?",
    re.IGNORECASE,
)
DATE_NUMERIC_RE = re.compile(r"\b(?P<mon>\d{1,2})/(?P<day>\d{1,2})(?:/(?P<year>\d{4}|\d{2}))?\b")
DATE_ISO_RE = re.compile(r"\b(?P<year>\d{4})-(?P<mon>\d{2})-(?P<day>\d{2})\b")
TIME_RE = re.compile(
    r"\b(?P<h>\d{1,2})(?::(?P<m>\d{2}))?\s*(?P<mer>a\.?\s?m\.?|p\.?\s?m\.?)(?![a-z])"
    r"(?:\s*\(?(?P<zone>" + _ZONE_ALT + r")\)?(?:\s+time)?\b)?"
    r"|\b(?P<h24>\d{1,2}):(?P<m24>\d{2})\b(?:\s*\(?(?P<zone24>" + _ZONE_ALT + r")\)?(?:\s+time)?\b)?"
    r"|\b(?P<word>noon|midnight)\b(?:\s*\(?(?P<zonew>" + _ZONE_ALT + r")\)?(?:\s+time)?\b)?",
    re.IGNORECASE,
)
NUMBER_RE = re.compile(r"\$\s?\d[\d,]*(?:\.\d+)?|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\b")
ELIG_RE = re.compile(r"(?<![\w-])(?:" + _ELIG_ALT + r")(?![\w-])", re.IGNORECASE)

URL_TRAILING = ".,;:!?)]}'\""


@dataclass(frozen=True)
class CriticalMatch:
    cls: TokenClass
    text: str  # as printed
    norm: str
    start: int  # offsets into the line text
    end: int


def _valid_date(month: int, day: int) -> bool:
    return 1 <= month <= 12 and 1 <= day <= DAYS_IN_MONTH[month - 1]


def _date_norm(mon: str, day: str, year: str | None) -> str | None:
    month = MONTHS.get(mon.lower().rstrip(".")) if not mon.isdigit() else int(mon)
    if month is None or not _valid_date(month, int(day)):
        return None
    if year is None:
        return f"--{month:02d}-{int(day):02d}"
    y = int(year)
    if len(year) == 2:
        y += 2000
    return f"{y:04d}-{month:02d}-{int(day):02d}"


def normalize_url(text: str) -> str:
    stripped = text.rstrip(URL_TRAILING)
    m = re.match(r"(?i)(https?://)?([^/?#]+)(.*)", stripped)
    if not m:
        return stripped
    scheme, host, rest = m.group(1) or "", m.group(2), m.group(3)
    return scheme.lower() + host.lower() + rest


def normalize_email(text: str) -> str:
    local, _, domain = text.rstrip(".").partition("@")
    return f"{local}@{domain.lower()}"


def normalize_number(text: str) -> str:
    return "".join(c for c in text if c.isdigit() or c == ".").strip(".")


def normalize_elig(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower().replace("-", " ").replace(".", "")).strip()


def _time_norm(m: re.Match[str]) -> str | None:
    if m.group("word"):
        base = "12:00" if m.group("word").lower() == "noon" else "00:00"
        zone = m.group("zonew")
    elif m.group("mer"):
        hour, minute = int(m.group("h")), int(m.group("m") or 0)
        if not 1 <= hour <= 12 or minute > 59:
            return None
        pm = m.group("mer").lower().startswith("p")
        hour = (hour % 12) + (12 if pm else 0)
        base = f"{hour:02d}:{minute:02d}"
        zone = m.group("zone")
    else:
        hour, minute = int(m.group("h24")), int(m.group("m24"))
        if hour > 23 or minute > 59:
            return None
        base = f"{hour:02d}:{minute:02d}"
        zone = m.group("zone24")
    return f"{base} {ZONES[zone.lower()]}" if zone else base


def _overlaps(start: int, end: int, taken: list[tuple[int, int]]) -> bool:
    return any(start < b and end > a for a, b in taken)


def recognize(text: str) -> list[CriticalMatch]:
    """All critical tokens in `text`, non-overlapping, in reading order.

    Classes claim spans in priority order (EMAIL, URL, DATE, TIME, ELIG_TERM,
    NUMBER), so the digits inside a date or a URL never become NUMBERs.
    """
    found: list[CriticalMatch] = []
    taken: list[tuple[int, int]] = []

    def claim(cls: TokenClass, start: int, end: int, norm: str | None) -> None:
        if norm is None or start >= end or _overlaps(start, end, taken):
            return
        taken.append((start, end))
        found.append(CriticalMatch(cls, text[start:end], norm, start, end))

    for m in EMAIL_RE.finditer(text):
        claim("EMAIL", m.start(), m.end(), normalize_email(m.group(0)))
    for m in URL_RE.finditer(text):
        raw = m.group(0)
        end = m.start() + len(raw.rstrip(URL_TRAILING))
        claim("URL", m.start(), end, normalize_url(raw))
    for pattern in (DATE_ISO_RE, DATE_NAMED_RE, DATE_DAY_FIRST_RE, DATE_NUMERIC_RE):
        for m in pattern.finditer(text):
            claim("DATE", m.start(), m.end(), _date_norm(m.group("mon"), m.group("day"), m.group("year")))
    for m in TIME_RE.finditer(text):
        claim("TIME", m.start(), m.end(), _time_norm(m))
    for m in ELIG_RE.finditer(text):
        claim("ELIG_TERM", m.start(), m.end(), normalize_elig(m.group(0)))
    for m in NUMBER_RE.finditer(text):
        norm = normalize_number(m.group(0))
        claim("NUMBER", m.start(), m.end(), norm or None)
    found.sort(key=lambda t: t.start)
    return found


def normalize_as(cls: TokenClass, text: str) -> str | None:
    """Normalize a free reading (for example a blind reader's answer) as a
    given class. Returns None when the reading is not a token of that class."""
    candidates = [t for t in recognize(text.strip()) if t.cls == cls]
    if len(candidates) != 1:
        return None
    return candidates[0].norm
