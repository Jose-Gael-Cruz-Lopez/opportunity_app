"""Calendar dates, terms and class standing, ported from shared/time and shared/eligibility/standing.ts.

Plain year/month/day integers only: no datetime, no time zones and no clock, so the browser, the
Worker and Python agree exactly. Invalid input raises ValueError (RangeError in TypeScript).
"""

from __future__ import annotations

from dataclasses import dataclass

from .catalogue import CATALOGUE, ISO_DATE_PATTERN, ISO_MONTH_PATTERN, TERM_KEY_PATTERN

COUNTABLE_CALENDARS = ("semester", "four_one_four", "quarter", "trimester")
_TERMS = ("winter", "spring", "summer", "fall")
_TERM_ORDER = {t: i for i, t in enumerate(_TERMS)}
_TERM_END = {
    "semester": {"winter": "01-31", "spring": "05-31", "summer": "08-31", "fall": "12-31"},
    "quarter": {"winter": "03-31", "spring": "06-15", "summer": "08-31", "fall": "12-31"},
}


def is_leap_year(year: int) -> bool:
    return (year % 4 == 0 and year % 100 != 0) or year % 400 == 0


def days_in_month(year: int, month: int) -> int:
    if month < 1 or month > 12:
        return 0
    return [31, 29 if is_leap_year(year) else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]


def parse_iso_date(value: object) -> tuple[int, int, int] | None:
    if not isinstance(value, str):
        return None
    m = ISO_DATE_PATTERN.match(value)
    if not m or len(value) != 10:
        return None
    year, month, day = int(m[1]), int(m[2]), int(m[3])
    if month < 1 or month > 12 or day < 1 or day > days_in_month(year, month):
        return None
    return year, month, day


def is_iso_date(value: object) -> bool:
    return parse_iso_date(value) is not None


def parse_iso_month(value: object) -> tuple[int, int] | None:
    if not isinstance(value, str):
        return None
    m = ISO_MONTH_PATTERN.match(value)
    if not m or len(value) != 7:
        return None
    year, month = int(m[1]), int(m[2])
    return (year, month) if 1 <= month <= 12 else None


def parse_term_key(key: object) -> tuple[str, int] | None:
    if not isinstance(key, str):
        return None
    m = TERM_KEY_PATTERN.match(key)
    if not m or len(key) != len(m[0]):
        return None
    return m[1], int(m[2])


def term_ordinal(term: tuple[str, int]) -> int:
    return term[1] * 4 + _TERM_ORDER[term[0]]


def enumerate_terms(start: str, end: str, include_winter: bool = False) -> list[str]:
    a = parse_term_key(start)
    b = parse_term_key(end)
    if a is None or b is None:
        raise ValueError("invalid term key")
    out: list[str] = []
    for ordinal in range(term_ordinal(a), term_ordinal(b) + 1):
        term = _TERMS[ordinal % 4]
        if term == "winter" and not include_winter:
            continue
        out.append(f"{term}-{ordinal // 4}")
    return out


def academic_year_start(iso_date: str, start_month: int) -> int:
    d = parse_iso_date(iso_date)
    if d is None:
        raise ValueError(f"invalid ISO date: {iso_date}")
    return d[0] if d[1] >= start_month else d[0] - 1


def is_countable_calendar(calendar: object) -> bool:
    return calendar in COUNTABLE_CALENDARS


def terms_per_year(calendar: str) -> int:
    return 3 if calendar in ("quarter", "trimester") else 2


def term_end_date(term_key: str, calendar: str = "semester") -> str:
    t = parse_term_key(term_key)
    if t is None:
        raise ValueError(f"invalid term key: {term_key}")
    table = _TERM_END["quarter"] if terms_per_year(calendar) == 3 else _TERM_END["semester"]
    return f"{t[1]:04d}-{table[t[0]]}"


def _counts_as_full_time_term(term: str, calendar: str) -> bool:
    if term == "summer":
        return False
    if term == "winter":
        return terms_per_year(calendar) == 3
    return True


def remaining_native_terms(grad_term: str, anchor: str, calendar: str) -> int:
    grad = parse_term_key(grad_term)
    at = parse_iso_date(anchor)
    if grad is None or at is None:
        raise ValueError("invalid graduation term or anchor date")
    if term_ordinal(grad) < term_ordinal(("winter", at[0])):
        return 0
    count = 0
    for key in enumerate_terms(f"winter-{at[0]}", grad_term, include_winter=True):
        t = parse_term_key(key)
        if t is None or not _counts_as_full_time_term(t[0], calendar):
            continue
        if term_end_date(key, calendar) > anchor:
            count += 1
    return count


@dataclass(frozen=True)
class SemesterEquivalents:
    exact: bool
    lo: float
    hi: float
    native_terms: int


def semester_equivalents_remaining(grad_term: str, anchor: str, calendar: str) -> SemesterEquivalents:
    n = remaining_native_terms(grad_term, anchor, calendar)
    if terms_per_year(calendar) == 2:
        return SemesterEquivalents(True, n, n, n)
    factor = 2 / 3
    return SemesterEquivalents(False, max(0, (n - 0.5) * factor), (n + 0.5) * factor, n)


def possible_ages(birth_year_month: str, anchor: str) -> list[int]:
    birth = parse_iso_month(birth_year_month)
    at = parse_iso_date(anchor)
    if birth is None or at is None:
        raise ValueError("invalid birth month or anchor date")

    def age_if_born_on(day: int) -> int:
        had_birthday = at[1] > birth[1] or (at[1] == birth[1] and at[2] >= day)
        return at[0] - birth[0] - (0 if had_birthday else 1)

    oldest = age_if_born_on(1)
    youngest = age_if_born_on(days_in_month(birth[0], birth[1]) or 31)
    return [oldest] if oldest == youngest else [youngest, oldest]


_CLASS_YEAR_BY_INDEX = sorted(
    (c for c in CATALOGUE.class_years if CATALOGUE.class_year_index.get(c) is not None),
    key=lambda c: CATALOGUE.class_year_index[c],  # type: ignore[arg-type, return-value]
)
_MAX_INDEX = len(_CLASS_YEAR_BY_INDEX) - 1


@dataclass(frozen=True)
class ProjectedClassYear:
    years: tuple[str, ...]
    conflict: bool


def project_class_year(reported: str, today: str, anchor: str, grad_term: str | None, calendar: str, academic_year_start_month: int) -> ProjectedClassYear:
    index = CATALOGUE.class_year_index.get(reported)
    years_ahead = academic_year_start(anchor, academic_year_start_month) - academic_year_start(today, academic_year_start_month)
    if years_ahead == 0 or index is None:
        return ProjectedClassYear((reported,), False)
    nominal = index + years_ahead
    nxt = _CLASS_YEAR_BY_INDEX[max(0, min(_MAX_INDEX, nominal))]
    if grad_term is None:
        return ProjectedClassYear(("fifth_year_plus", "recent_graduate") if nominal > 4 else (nxt,), False)
    graduated = term_end_date(grad_term, calendar) <= anchor
    if not graduated:
        return ProjectedClassYear((nxt,), False)
    if nominal > 4:
        return ProjectedClassYear(("recent_graduate",), False)
    return ProjectedClassYear((nxt, "recent_graduate"), True)
