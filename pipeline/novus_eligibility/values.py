"""Three-valued logic and abstract values, ported from shared/eligibility/kleene.ts and abstract.ts.

Strong Kleene logic is encoded as integers so the folds are min and max: NO = -1, UNKNOWN = 0,
YES = 1. An abstract value is what the evaluator knows about an input: one known value, one of a
finite set of primitives, a numeric range, or anything at all. JSON values follow JavaScript's
type rules here, not Python's: ``True`` is never equal to ``1`` and booleans are not numbers.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterable, Sequence

NO = -1
UNKNOWN = 0
YES = 1

# Sentinel for JavaScript's `undefined` (a path that does not exist).
MISSING: Any = object()


# --------------------------------------------------------------------------------------------
# Kleene
# --------------------------------------------------------------------------------------------


def and3(values: Iterable[int]) -> int:
    result = YES
    for v in values:
        if v < result:
            result = v
    return result


def or3(values: Iterable[int]) -> int:
    result = NO
    for v in values:
        if v > result:
            result = v
    return result


def not3(value: int) -> int:
    return UNKNOWN if value == UNKNOWN else (NO if value == YES else YES)


def agree3(values: Iterable[int]) -> int:
    saw_yes = False
    saw_no = False
    for v in values:
        if v == UNKNOWN:
            return UNKNOWN
        if v == YES:
            saw_yes = True
        else:
            saw_no = True
        if saw_yes and saw_no:
            return UNKNOWN
    if saw_yes:
        return YES
    return NO if saw_no else UNKNOWN


_VERDICTS = {NO: "not_met", UNKNOWN: "unknown", YES: "met"}


def tri_to_verdict(value: int) -> str:
    return _VERDICTS[value]


# --------------------------------------------------------------------------------------------
# JSON values with JavaScript semantics
# --------------------------------------------------------------------------------------------


def is_num(x: Any) -> bool:
    return type(x) in (int, float)


def is_primitive(x: Any) -> bool:
    return x is None or type(x) in (bool, int, float, str)


def strict_eq(a: Any, b: Any) -> bool:
    """JavaScript `===` on primitives."""
    if is_num(a) and is_num(b):
        return a == b
    if type(a) is not type(b):
        return False
    return a == b


def js_type(x: Any) -> str:
    if x is None:
        return "null"
    if isinstance(x, list):
        return "array"
    if type(x) is bool:
        return "boolean"
    if is_num(x):
        return "number"
    if isinstance(x, str):
        return "string"
    return "object"


def js_number_text(x: float | int) -> str:
    """String(x) for the numbers rule sets use (integral floats print without a fraction)."""
    if type(x) is int:
        return str(x)
    if not math.isfinite(x):
        raise ValueError("non-finite number")
    if x == 0:
        return "0"
    if x.is_integer() and abs(x) < 1e21:
        return str(int(x))
    return repr(x)


def concrete_truthy(value: Any) -> bool:
    if isinstance(value, list):
        return len(value) > 0
    if isinstance(value, dict):
        return True
    if value is None:
        return False
    if type(value) is bool:
        return value
    if is_num(value):
        return value != 0
    if isinstance(value, str):
        return value != ""
    return bool(value)


def same_json(a: Any, b: Any) -> bool:
    if is_primitive(a) or is_primitive(b):
        return is_primitive(a) and is_primitive(b) and strict_eq(a, b)
    if isinstance(a, list) != isinstance(b, list):
        return False
    if isinstance(a, list):
        return len(a) == len(b) and all(same_json(x, y) for x, y in zip(a, b))
    ka = sorted(a.keys())
    kb = sorted(b.keys())
    return ka == kb and all(same_json(a[k], b[k]) for k in ka)


# --------------------------------------------------------------------------------------------
# Abstract values
# --------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Known:
    value: Any
    kind: str = "known"


@dataclass(frozen=True)
class SetValue:
    values: tuple[Any, ...]
    kind: str = "set"


@dataclass(frozen=True)
class RangeValue:
    lo: float
    hi: float
    lo_open: bool
    hi_open: bool
    kind: str = "range"


@dataclass(frozen=True)
class Unknown:
    kind: str = "unknown"


AbstractValue = Known | SetValue | RangeValue | Unknown

ANYTHING = Unknown()


def known(value: Any) -> Known:
    return Known(value)


def one_of(values: Sequence[Any]) -> AbstractValue:
    distinct: list[Any] = []
    for v in values:
        if not any(strict_eq(d, v) for d in distinct):
            distinct.append(v)
    if not distinct:
        return ANYTHING
    if len(distinct) == 1:
        return known(distinct[0])
    return SetValue(tuple(distinct))


def make_range(lo: float, hi: float, lo_open: bool = False, hi_open: bool = False) -> AbstractValue:
    if lo == hi and not lo_open and not hi_open:
        return known(lo)
    return RangeValue(lo, hi, lo_open, hi_open)


def from_tri(value: int) -> AbstractValue:
    return ANYTHING if value == UNKNOWN else known(value == YES)


def range_contains(r: RangeValue, x: float) -> bool:
    above = x > r.lo if r.lo_open else x >= r.lo
    below = x < r.hi if r.hi_open else x <= r.hi
    return above and below


def truthy(value: AbstractValue) -> int:
    if isinstance(value, Known):
        return YES if concrete_truthy(value.value) else NO
    if isinstance(value, SetValue):
        truths = [concrete_truthy(v) for v in value.values]
        if all(truths):
            return YES
        return UNKNOWN if any(truths) else NO
    if isinstance(value, RangeValue):
        if range_contains(value, 0):
            return NO if value.lo == 0 and value.hi == 0 else UNKNOWN
        return YES
    return UNKNOWN


def finite_values(value: AbstractValue) -> list[Any] | None:
    if isinstance(value, Known):
        return [value.value]
    if isinstance(value, SetValue):
        return list(value.values)
    return None


def join(a: AbstractValue, b: AbstractValue) -> AbstractValue:
    fa = finite_values(a)
    fb = finite_values(b)
    if fa is not None and fb is not None and all(is_primitive(x) for x in fa) and all(is_primitive(x) for x in fb):
        return one_of([*fa, *fb])
    if isinstance(a, Known) and isinstance(b, Known) and same_json(a.value, b.value):
        return a
    if isinstance(a, RangeValue) and isinstance(b, RangeValue):
        lo = min(a.lo, b.lo)
        hi = max(a.hi, b.hi)
        return make_range(
            lo,
            hi,
            lo_open=(a.lo_open if a.lo == lo else True) and (b.lo_open if b.lo == lo else True),
            hi_open=(a.hi_open if a.hi == hi else True) and (b.hi_open if b.hi == hi else True),
        )
    return ANYTHING
