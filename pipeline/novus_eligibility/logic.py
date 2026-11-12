"""Tri-state JsonLogic interpreter, ported from shared/eligibility/logic.ts.

Same deliberate differences from JsonLogic as the TypeScript engine: missing inputs are abstract
values, never null; no type coercion; `and`, `or`, `!` and `!!` return booleans and never
short-circuit; a top-level `var` default is ignored; `missing` returns UNKNOWN when a field is
unanswered. A type mismatch is a rule bug and raises RuleEvaluationError.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import reduce
from typing import Any, Callable, Protocol, Sequence

from .values import (
    ANYTHING,
    MISSING,
    NO,
    UNKNOWN,
    YES,
    AbstractValue,
    Known,
    RangeValue,
    SetValue,
    Unknown,
    and3,
    finite_values,
    from_tri,
    is_num,
    is_primitive,
    join,
    js_number_text,
    js_type,
    known,
    make_range,
    not3,
    one_of,
    or3,
    range_contains,
    strict_eq,
    truthy,
)


class RuleEvaluationError(Exception):
    pass


class LogicScope(Protocol):
    def lookup(self, name: str) -> AbstractValue: ...

    def answered(self, name: str) -> bool: ...


@dataclass(frozen=True)
class _Item:
    value: Any


@dataclass(frozen=True)
class _Frame:
    scope: LogicScope
    item: _Item | None = None


MAX_COMBINATIONS = 4096

Handler = Callable[[Sequence[Any], _Frame], AbstractValue]


def evaluate_logic(logic: Any, scope: LogicScope) -> AbstractValue:
    return _ev(logic, _Frame(scope))


def evaluate_logic_tri(logic: Any, scope: LogicScope) -> int:
    return truthy(evaluate_logic(logic, scope))


def _ev(node: Any, frame: _Frame) -> AbstractValue:
    if isinstance(node, list):
        values = [_ev(n, frame) for n in node]
        if all(isinstance(v, Known) for v in values):
            return known([v.value for v in values])  # type: ignore[union-attr]
        return ANYTHING
    if node is None or type(node) in (str, bool, int, float):
        if type(node) is float and not math.isfinite(node):
            raise RuleEvaluationError("non-finite number")
        return known(node)
    if not isinstance(node, dict):
        raise RuleEvaluationError(f"unsupported literal {type(node).__name__}")
    if len(node) != 1:
        raise RuleEvaluationError("an expression has exactly one operator")
    op, raw = next(iter(node.items()))
    args: Sequence[Any] = raw if isinstance(raw, list) else [raw]
    handler = OPERATORS.get(op)
    if handler is None:
        raise RuleEvaluationError(f"unsupported operator {op}")
    return handler(args, frame)


# ---- data access -----------------------------------------------------------------------------


def _literal_path(args: Sequence[Any], frame: _Frame) -> str | int | float:
    arg = args[0] if args else None
    if isinstance(arg, str) or is_num(arg):
        return arg
    if arg is None:
        return ""
    v = _ev(arg, frame)
    if isinstance(v, Known) and (isinstance(v.value, str) or is_num(v.value)):
        return v.value
    raise RuleEvaluationError("var path must be a known string or number")


def _walk(data: Any, path: str | int | float) -> Any:
    if path == "":
        return data
    text = path if isinstance(path, str) else js_number_text(path)
    cur = data
    for part in text.split("."):
        if cur is MISSING or cur is None or not isinstance(cur, (list, dict)):
            return MISSING
        if isinstance(cur, list):
            if not part.isdigit():
                return MISSING
            index = int(part)
            cur = cur[index] if index < len(cur) else MISSING
        else:
            cur = cur.get(part, MISSING)
    return cur


def _op_var(args: Sequence[Any], frame: _Frame) -> AbstractValue:
    path = _literal_path(args, frame)
    if frame.item is not None:
        found = _walk(frame.item.value, path)
        if found is not MISSING:
            return known(found)
        return _ev(args[1], frame) if len(args) > 1 else known(None)
    if not isinstance(path, str) or path == "":
        raise RuleEvaluationError("top-level var must name a catalogue field")
    return frame.scope.lookup(path)


def _names_from(arg: Any, frame: _Frame) -> list[str]:
    v = _ev(arg, frame)
    if not isinstance(v, Known):
        raise RuleEvaluationError("missing needs literal names")
    items = v.value if isinstance(v.value, list) else [v.value]
    for n in items:
        if not isinstance(n, str):
            raise RuleEvaluationError("missing needs string names")
    return list(items)


def _is_answered(name: str, frame: _Frame) -> bool:
    if frame.item is not None:
        found = _walk(frame.item.value, name)
        return found is not MISSING and found is not None and found != ""
    return frame.scope.answered(name)


def _op_missing(args: Sequence[Any], frame: _Frame) -> AbstractValue:
    if len(args) == 1 and isinstance(args[0], list):
        names = _names_from(args[0], frame)
    else:
        names = [n for a in args for n in _names_from(a, frame)]
    absent = [n for n in names if not _is_answered(n, frame)]
    if not absent:
        return known([])
    return known(absent) if frame.item is not None else ANYTHING


def _op_missing_some(args: Sequence[Any], frame: _Frame) -> AbstractValue:
    need = _ev(args[0] if args else None, frame)
    if not isinstance(need, Known) or not is_num(need.value):
        raise RuleEvaluationError("missing_some needs a count")
    names = _names_from(args[1] if len(args) > 1 else None, frame)
    absent = [n for n in names if not _is_answered(n, frame)]
    if len(names) - len(absent) >= need.value:
        return known([])
    return known(absent) if frame.item is not None else ANYTHING


# ---- lifting ---------------------------------------------------------------------------------


def _product(lists: Sequence[Sequence[Any]]) -> list[list[Any]] | None:
    total = 1
    for lst in lists:
        total *= len(lst)
    if total > MAX_COMBINATIONS:
        return None
    acc: list[list[Any]] = [[]]
    for lst in lists:
        acc = [[*prefix, v] for prefix in acc for v in lst]
    return acc


def _lift_predicate(values: Sequence[AbstractValue], predicate: Callable[[list[Any]], bool]) -> int:
    lists = [finite_values(v) for v in values]
    if any(lst is None for lst in lists):
        return UNKNOWN
    combos = _product(lists)  # type: ignore[arg-type]
    if combos is None:
        return UNKNOWN
    saw_true = False
    saw_false = False
    for combo in combos:
        if predicate(combo):
            saw_true = True
        else:
            saw_false = True
    if saw_true and saw_false:
        return UNKNOWN
    return YES if saw_true else NO


def _lift_value(values: Sequence[AbstractValue], fn: Callable[[list[Any]], Any]) -> AbstractValue:
    lists = [finite_values(v) for v in values]
    if any(lst is None for lst in lists):
        return ANYTHING
    combos = _product(lists)  # type: ignore[arg-type]
    if combos is None:
        return ANYTHING
    results = [fn(c) for c in combos]
    if len(results) == 1:
        return known(results[0])
    if all(is_primitive(r) for r in results):
        return one_of(results)
    return reduce(lambda acc, r: join(acc, known(r)), results[1:], known(results[0]))


# ---- comparison ------------------------------------------------------------------------------


def _concrete_compare(op: str, a: Any, b: Any) -> bool:
    both_numbers = is_num(a) and is_num(b)
    both_strings = isinstance(a, str) and isinstance(b, str)
    if not both_numbers and not both_strings:
        raise RuleEvaluationError(f"cannot compare {js_type(a)} with {js_type(b)}")
    if op == "<":
        return a < b
    if op == "<=":
        return a <= b
    if op == ">":
        return a > b
    return a >= b


def _concrete_equals(a: Any, b: Any) -> bool:
    if not is_primitive(a) or not is_primitive(b):
        raise RuleEvaluationError("== compares primitives only")
    return strict_eq(a, b)


@dataclass(frozen=True)
class _Interval:
    lo: float
    hi: float
    lo_open: bool
    hi_open: bool


def _to_interval(v: AbstractValue) -> _Interval:
    if isinstance(v, RangeValue):
        return _Interval(v.lo, v.hi, v.lo_open, v.hi_open)
    values = finite_values(v)
    if values is None:
        raise RuleEvaluationError("interval of an unknown value")
    if not all(is_num(x) for x in values):
        raise RuleEvaluationError("cannot compare a number range with " + "/".join(js_type(x) for x in values))
    return _Interval(min(values), max(values), False, False)


def _less_all(x: _Interval, y: _Interval, strict: bool) -> bool:
    if not strict:
        return x.hi <= y.lo
    return x.hi < y.lo or (x.hi == y.lo and (x.hi_open or y.lo_open))


def _compare_intervals(op: str, x: _Interval, y: _Interval) -> int:
    if op == "<":
        return YES if _less_all(x, y, True) else NO if _less_all(y, x, False) else UNKNOWN
    if op == "<=":
        return YES if _less_all(x, y, False) else NO if _less_all(y, x, True) else UNKNOWN
    if op == ">":
        return _compare_intervals("<", y, x)
    return _compare_intervals("<=", y, x)


def _compare_abstract(op: str, a: AbstractValue, b: AbstractValue) -> int:
    if isinstance(a, Unknown) or isinstance(b, Unknown):
        return UNKNOWN
    if isinstance(a, RangeValue) or isinstance(b, RangeValue):
        return _compare_intervals(op, _to_interval(a), _to_interval(b))
    return _lift_predicate([a, b], lambda xs: _concrete_compare(op, xs[0], xs[1]))


def _equals_abstract(a: AbstractValue, b: AbstractValue) -> int:
    if isinstance(a, Unknown) or isinstance(b, Unknown):
        return UNKNOWN
    if isinstance(a, RangeValue) or isinstance(b, RangeValue):
        x = _to_interval(a)
        y = _to_interval(b)
        if _less_all(x, y, True) or _less_all(y, x, True):
            return NO

        def point(i: _Interval) -> bool:
            return i.lo == i.hi and not i.lo_open and not i.hi_open

        return YES if point(x) and point(y) and x.lo == y.lo else UNKNOWN
    return _lift_predicate([a, b], lambda xs: _concrete_equals(xs[0], xs[1]))


def _comparison(op: str) -> Handler:
    def handler(args: Sequence[Any], frame: _Frame) -> AbstractValue:
        if len(args) < 2 or len(args) > 3:
            raise RuleEvaluationError(f"{op} takes 2 or 3 arguments")
        vals = [_ev(a, frame) for a in args]
        if len(vals) == 2:
            return from_tri(_compare_abstract(op, vals[0], vals[1]))
        if op in (">", ">="):
            raise RuleEvaluationError(f"{op} takes 2 arguments")
        a, b, c = vals
        middle = finite_values(b)
        if middle is not None and not isinstance(a, Unknown) and not isinstance(c, Unknown):
            per_value = [and3([_compare_abstract(op, a, known(m)), _compare_abstract(op, known(m), c)]) for m in middle]
            if all(t == YES for t in per_value):
                return known(True)
            if all(t == NO for t in per_value):
                return known(False)
            return ANYTHING
        return from_tri(and3([_compare_abstract(op, a, b), _compare_abstract(op, b, c)]))

    return handler


def _equality(negate: bool) -> Handler:
    def handler(args: Sequence[Any], frame: _Frame) -> AbstractValue:
        if len(args) != 2:
            raise RuleEvaluationError("equality takes 2 arguments")
        t = _equals_abstract(_ev(args[0], frame), _ev(args[1], frame))
        return from_tri(not3(t) if negate else t)

    return handler


# ---- logic -----------------------------------------------------------------------------------


def _op_not(args: Sequence[Any], frame: _Frame) -> AbstractValue:
    return from_tri(not3(truthy(_ev(args[0] if args else None, frame))))


def _op_not_not(args: Sequence[Any], frame: _Frame) -> AbstractValue:
    return from_tri(truthy(_ev(args[0] if args else None, frame)))


def _op_and(args: Sequence[Any], frame: _Frame) -> AbstractValue:
    if not args:
        raise RuleEvaluationError("and needs operands")
    return from_tri(and3([truthy(_ev(a, frame)) for a in args]))


def _op_or(args: Sequence[Any], frame: _Frame) -> AbstractValue:
    if not args:
        raise RuleEvaluationError("or needs operands")
    return from_tri(or3([truthy(_ev(a, frame)) for a in args]))


def _op_if(args: Sequence[Any], frame: _Frame) -> AbstractValue:
    def branch(i: int) -> AbstractValue:
        if i >= len(args):
            return known(None)
        if i == len(args) - 1:
            return _ev(args[i], frame)
        cond = truthy(_ev(args[i], frame))
        if cond == YES:
            return _ev(args[i + 1], frame)
        if cond == NO:
            return branch(i + 2)
        return join(_ev(args[i + 1], frame), branch(i + 2))

    return branch(0)


# ---- arrays and strings ----------------------------------------------------------------------


def _concrete_in(needle: Any, haystack: Any) -> bool:
    if isinstance(haystack, str):
        if not isinstance(needle, str):
            raise RuleEvaluationError("in on a string needs a string")
        return needle in haystack
    if isinstance(haystack, list):
        if not is_primitive(needle):
            raise RuleEvaluationError("in compares primitives only")
        return any(is_primitive(h) and strict_eq(h, needle) for h in haystack)
    raise RuleEvaluationError("in needs an array or string")


def _op_in(args: Sequence[Any], frame: _Frame) -> AbstractValue:
    if len(args) != 2:
        raise RuleEvaluationError("in takes 2 arguments")
    needle = _ev(args[0], frame)
    haystack = _ev(args[1], frame)
    if isinstance(needle, Unknown) or isinstance(haystack, Unknown):
        return ANYTHING
    if isinstance(needle, RangeValue):
        lst = haystack.value if isinstance(haystack, Known) and isinstance(haystack.value, list) else None
        if lst is None:
            return ANYTHING
        inside = [h for h in lst if is_num(h) and range_contains(needle, h)]
        return known(False) if not inside else ANYTHING
    if isinstance(haystack, RangeValue):
        raise RuleEvaluationError("in needs an array or string")
    return from_tri(_lift_predicate([needle, haystack], lambda xs: _concrete_in(xs[0], xs[1])))


def _quantifier(kind: str) -> Handler:
    def handler(args: Sequence[Any], frame: _Frame) -> AbstractValue:
        if len(args) != 2:
            raise RuleEvaluationError(f"{kind} takes 2 arguments")
        lst = _ev(args[0], frame)
        if not isinstance(lst, Known):
            return ANYTHING
        if not isinstance(lst.value, list):
            raise RuleEvaluationError(f"{kind} needs an array")
        items = lst.value
        verdicts = [truthy(_ev(args[1], _Frame(frame.scope, _Item(item)))) for item in items]
        if kind == "all":
            return known(False) if not items else from_tri(and3(verdicts))
        some = or3(verdicts)
        return from_tri(some if kind == "some" else not3(some))

    return handler


def _op_merge(args: Sequence[Any], frame: _Frame) -> AbstractValue:
    parts = [_ev(a, frame) for a in args]
    if not all(isinstance(p, Known) for p in parts):
        return ANYTHING
    out: list[Any] = []
    for p in parts:
        value = p.value  # type: ignore[union-attr]
        if isinstance(value, list):
            out.extend(value)
        else:
            out.append(value)
    return known(out)


def _cat_part(x: Any) -> str:
    if isinstance(x, str):
        return x
    if is_num(x):
        return js_number_text(x)
    raise RuleEvaluationError("cat joins strings and numbers only")


def _op_cat(args: Sequence[Any], frame: _Frame) -> AbstractValue:
    return _lift_value([_ev(a, frame) for a in args], lambda xs: "".join(_cat_part(x) for x in xs))


def _substr(xs: list[Any]) -> str:
    s = xs[0] if xs else None
    start = xs[1] if len(xs) > 1 else None
    length = xs[2] if len(xs) > 2 else None
    if not isinstance(s, str) or not is_num(start):
        raise RuleEvaluationError("substr needs a string and a start")
    begin = max(0, len(s) + int(start)) if start < 0 else int(start)
    if length is None:
        return s[begin:]
    if not is_num(length):
        raise RuleEvaluationError("substr length must be a number")
    if length < 0:
        # Like String.prototype.slice: a negative end counts from the end again.
        return s[begin : len(s) + int(length)]
    return s[begin : begin + int(length)]


def _op_substr(args: Sequence[Any], frame: _Frame) -> AbstractValue:
    return _lift_value([_ev(a, frame) for a in args], _substr)


# ---- arithmetic ------------------------------------------------------------------------------


def _num(x: Any) -> float:
    if not is_num(x):
        raise RuleEvaluationError(f"arithmetic needs numbers, got {js_type(x)}")
    return x


def _shift(r: RangeValue, by: float) -> AbstractValue:
    return make_range(r.lo + by, r.hi + by, r.lo_open, r.hi_open)


def _scale(r: RangeValue, k: float) -> AbstractValue:
    if k == 0:
        return known(0)
    if k > 0:
        return make_range(r.lo * k, r.hi * k, r.lo_open, r.hi_open)
    return make_range(r.hi * k, r.lo * k, r.hi_open, r.lo_open)


def _known_number(v: AbstractValue) -> float | None:
    return v.value if isinstance(v, Known) and is_num(v.value) else None


def _range_arithmetic(op: str, a: AbstractValue, b: AbstractValue | None) -> AbstractValue:
    if b is None:
        return _scale(a, -1) if op == "-" and isinstance(a, RangeValue) else ANYTHING
    ka = _known_number(a)
    kb = _known_number(b)
    if isinstance(a, RangeValue) and kb is not None:
        if op == "+":
            return _shift(a, kb)
        if op == "-":
            return _shift(a, -kb)
        if op == "*":
            return _scale(a, kb)
        if op == "/" and kb != 0:
            return _scale(a, 1 / kb)
    if isinstance(b, RangeValue) and ka is not None:
        if op == "+":
            return _shift(b, ka)
        if op == "*":
            return _scale(b, ka)
        if op == "-":
            negated = _scale(b, -1)
            return _shift(negated, ka) if isinstance(negated, RangeValue) else ANYTHING
    return ANYTHING


def _js_remainder(x: float, y: float) -> float:
    r = math.fmod(x, y)
    return int(r) if type(x) is int and type(y) is int else r


def _arithmetic(op: str) -> Handler:
    def compute(xs: list[Any]) -> Any:
        ns = [_num(x) for x in xs]
        if op == "-" and len(ns) == 1:
            return -ns[0]
        if op == "+":
            return sum(ns, 0)
        if op == "*":
            return reduce(lambda s, n: s * n, ns, 1)
        if len(ns) != 2:
            raise RuleEvaluationError(f"{op} takes 2 operands")
        x, y = ns
        if op in ("/", "%") and y == 0:
            raise RuleEvaluationError("division by zero")
        if op == "-":
            return x - y
        if op == "/":
            return x / y
        return _js_remainder(x, y)

    def handler(args: Sequence[Any], frame: _Frame) -> AbstractValue:
        vals = [_ev(a, frame) for a in args]
        if not vals:
            raise RuleEvaluationError(f"{op} needs operands")
        if any(isinstance(v, RangeValue) for v in vals):
            if len(vals) > 2:
                return ANYTHING
            return _range_arithmetic(op, vals[0], vals[1] if len(vals) > 1 else None)
        return _lift_value(vals, compute)

    return handler


def _extremum(pick: str) -> Handler:
    def handler(args: Sequence[Any], frame: _Frame) -> AbstractValue:
        vals = [_ev(a, frame) for a in args]
        if not vals:
            raise RuleEvaluationError(f"{pick} needs operands")
        return _lift_value(vals, lambda xs: (min if pick == "min" else max)(_num(x) for x in xs))

    return handler


OPERATORS: dict[str, Handler] = {
    "var": _op_var,
    "missing": _op_missing,
    "missing_some": _op_missing_some,
    "==": _equality(False),
    "===": _equality(False),
    "!=": _equality(True),
    "!==": _equality(True),
    "<": _comparison("<"),
    "<=": _comparison("<="),
    ">": _comparison(">"),
    ">=": _comparison(">="),
    "!": _op_not,
    "!!": _op_not_not,
    "and": _op_and,
    "or": _op_or,
    "if": _op_if,
    "?:": _op_if,
    "in": _op_in,
    "all": _quantifier("all"),
    "some": _quantifier("some"),
    "none": _quantifier("none"),
    "merge": _op_merge,
    "+": _arithmetic("+"),
    "-": _arithmetic("-"),
    "*": _arithmetic("*"),
    "/": _arithmetic("/"),
    "%": _arithmetic("%"),
    "min": _extremum("min"),
    "max": _extremum("max"),
    "cat": _op_cat,
    "substr": _op_substr,
}

SUPPORTED_OPERATORS: tuple[str, ...] = tuple(OPERATORS)


def inspect_json_logic(expr: Any) -> tuple[list[str], list[str]]:
    """Variable names (in first-seen order) and disallowed operators, like inspectJsonLogic."""
    from .catalogue import CATALOGUE

    allowed = set(CATALOGUE.operators)
    found: dict[str, None] = {}
    bad: dict[str, None] = {}

    def visit(node: Any) -> None:
        if isinstance(node, list):
            for n in node:
                visit(n)
            return
        if not isinstance(node, dict):
            return
        if len(node) != 1:
            bad["{" + ",".join(node.keys()) + "}"] = None
            return
        op, arg = next(iter(node.items()))
        if op not in allowed:
            bad[op] = None
        if op == "var":
            name = arg[0] if isinstance(arg, list) and arg else (None if isinstance(arg, list) else arg)
            if isinstance(name, str) and name != "":
                found[name] = None
            if isinstance(arg, list):
                for a in arg[1:]:
                    visit(a)
            return
        if op in ("missing", "missing_some"):
            lst = arg if op == "missing" else (arg[1] if isinstance(arg, list) and len(arg) > 1 else [])
            for n in lst if isinstance(lst, list) else [lst]:
                if isinstance(n, str):
                    found[n] = None
            return
        if op in ("all", "some", "none"):
            if isinstance(arg, list) and arg:
                visit(arg[0])
            return
        visit(arg)

    visit(expr)
    return list(found), list(bad)


# Silence "imported but unused" for names re-exported for callers and tests.
__all__ = ["RuleEvaluationError", "LogicScope", "evaluate_logic", "evaluate_logic_tri", "inspect_json_logic", "SUPPORTED_OPERATORS", "SetValue"]
