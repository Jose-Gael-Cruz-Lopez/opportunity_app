"""The field environment, ported from shared/eligibility/fields.ts (server-safe half only).

Reads one catalogue field for a rule and says how certain the answer is. There is no device
path here: a sensitive field is never read and always comes back "sensitive_withheld".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from .catalogue import CATALOGUE
from .standing import is_countable_calendar, parse_term_key, possible_ages, project_class_year, semester_equivalents_remaining
from .values import ANYTHING, AbstractValue, known, make_range, one_of

# The JavaScript `undefined` of a missing object key, kept apart from an explicit null.
_ABSENT: Any = object()


@dataclass(frozen=True)
class FieldReading:
    value: AbstractValue
    status: str
    blame: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class FieldEnv:
    profile: Mapping[str, Any]
    context: Mapping[str, Any]
    today: str


def _nullish(value: Any) -> bool:
    return value is None or value is _ABSENT


def _coalesce(*values: Any) -> Any:
    for v in values:
        if not _nullish(v):
            return v
    return None


def _institution(env: FieldEnv) -> Mapping[str, Any] | None:
    inst = env.context.get("institution")
    return inst if isinstance(inst, Mapping) else None


def _ok(value: AbstractValue) -> FieldReading:
    return FieldReading(value, "known", ())


def _missing(value: AbstractValue, *blame: str) -> FieldReading:
    return FieldReading(value, "missing", tuple(blame))


def _context() -> FieldReading:
    return FieldReading(ANYTHING, "context", ())


def is_answered(reading: FieldReading) -> bool:
    return reading.status not in ("missing", "sensitive_missing", "sensitive_withheld")


def _universe(key: str) -> list[str]:
    d = CATALOGUE.field(key)
    if d is None:
        return []
    return [v for v in d.values if v not in d.unknown_values]


def _read_enum(key: str, value: Any) -> FieldReading:
    d = CATALOGUE.field(key)
    unanswered = value is None or (d is not None and value in d.unknown_values)
    if not unanswered:
        return _ok(known(value))
    values = _universe(key)
    return _missing(one_of(values) if values else ANYTHING, key)


def _read_gpa(band: Any) -> FieldReading:
    bounds = CATALOGUE.gpa_band_bounds.get(band) if isinstance(band, str) and band else None
    if not bounds:
        return _missing(ANYTHING, "gpaBand")
    return FieldReading(make_range(bounds["min"], bounds["max"], hi_open=True), "coarse", ())


def _read_participation(env: FieldEnv) -> FieldReading:
    inst = _institution(env)
    if inst is None and not env.profile.get("institutionId"):
        return _missing(ANYTHING, "institutionId")
    if inst is not None and inst.get("participates") is True:
        return _ok(known(True))
    return FieldReading(ANYTHING, "participation", ())


def _calendar_of(env: FieldEnv) -> tuple[str | None, FieldReading | None]:
    inst = _institution(env)
    if inst is None:
        return None, _missing(ANYTHING, "institutionId")
    calendar = inst.get("calendar", _ABSENT)
    if calendar is None:
        return None, _context()
    if not is_countable_calendar(calendar):
        return None, FieldReading(ANYTHING, "calendar", ())
    return calendar, None


def _read_standing(key: str, env: FieldEnv, anchor: str | None) -> FieldReading:
    if anchor is None:
        return _context()
    grad = _coalesce(env.profile.get("expectedGraduationTerm", _ABSENT))
    calendar, reading = _calendar_of(env)
    if not grad:
        return _missing(ANYTHING, "expectedGraduationTerm", *(reading.blame if reading else ()))
    if reading is not None:
        return reading
    eq = semester_equivalents_remaining(grad, anchor, calendar or "semester")
    scale = 0.5 if key == "yearsRemaining" else 1
    if eq.exact:
        return _ok(known(eq.lo * scale))
    return FieldReading(make_range(eq.lo * scale, eq.hi * scale), "calendar", ())


def _read_class_year(env: FieldEnv, anchor: str | None) -> FieldReading:
    reported = _coalesce(env.profile.get("classYear", _ABSENT))
    if reported is None:
        return _read_enum("classYear", None)
    if anchor is None:
        return _context()
    if anchor == env.today:
        return _ok(known(reported))
    inst = _institution(env)
    cal = inst.get("calendar") if inst is not None else None
    calendar = cal if cal and is_countable_calendar(cal) else "semester"
    start_month = _coalesce(inst.get("academicYearStartMonth", _ABSENT) if inst is not None else None, 8)
    projected = project_class_year(
        reported=reported,
        today=env.today,
        anchor=anchor,
        grad_term=_coalesce(env.profile.get("expectedGraduationTerm", _ABSENT)),
        calendar=calendar,
        academic_year_start_month=start_month,
    )
    possible = list(projected.years)
    if projected.conflict:
        return FieldReading(one_of(possible), "conflict", ("classYear", "expectedGraduationTerm"))
    if len(possible) == 1:
        return _ok(known(possible[0]))
    return _missing(one_of(possible), "expectedGraduationTerm")


def _read_age(env: FieldEnv, anchor: str | None) -> FieldReading:
    birth = _coalesce(env.profile.get("birthYearMonth", _ABSENT))
    if not birth:
        return _missing(ANYTHING, "ageAtAsOf")
    if anchor is None:
        return _context()
    ages = possible_ages(birth, anchor)
    if len(ages) == 1:
        return _ok(known(ages[0]))
    return FieldReading(one_of(ages), "coarse", ())


def read_field(key: str, env: FieldEnv, anchor: str | None) -> FieldReading:
    d = CATALOGUE.field(key)
    if d is None:
        raise ValueError(f"unknown field {key}")
    if d.sensitive:
        # Server-safe port: sensitive answers are never read here.
        return FieldReading(ANYTHING, "sensitive_withheld", (key,))
    p = env.profile
    inst = _institution(env)
    if key == "classYear":
        return _read_class_year(env, anchor)
    if key in ("semestersRemaining", "yearsRemaining"):
        return _read_standing(key, env, anchor)
    if key == "expectedGraduationTerm":
        term = p.get("expectedGraduationTerm")
        return _ok(known(term)) if term else _missing(ANYTHING, key)
    if key == "expectedGraduationYear":
        term = p.get("expectedGraduationTerm")
        t = parse_term_key(term) if term else None
        return _ok(known(t[1])) if t else _missing(ANYTHING, "expectedGraduationTerm")
    if key == "institutionLevel":
        return _read_enum(key, _coalesce(inst.get("level", _ABSENT) if inst is not None else None, p.get("institutionLevel", _ABSENT)))
    if key in ("enrollmentIntensity", "transferIntent", "gpaBand", "majorFamily", "residenceState"):
        return _read_enum(key, _coalesce(p.get(key, _ABSENT)))
    if key in ("gpaMin", "gpaMax"):
        return _read_gpa(_coalesce(p.get("gpaBand", _ABSENT)))
    if key in ("majorCip", "minorCip"):
        value = p.get(key)
        return _ok(known(value)) if value else _missing(ANYTHING, key)
    if key == "institutionId":
        value = _coalesce(inst.get("id", _ABSENT) if inst is not None else None, p.get("institutionId", _ABSENT))
        return _ok(known(value)) if value else _missing(ANYTHING, key)
    if key == "institutionParticipates":
        return _read_participation(env)
    if key == "ageAtAsOf":
        return _read_age(env, anchor)
    raise ValueError(f"no reader for field {key}")
