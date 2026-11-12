import {
  ANYTHING,
  concreteTruthy,
  finiteValues,
  fromTri,
  isPrimitive,
  join,
  known,
  oneOf,
  range,
  rangeContains,
  truthy,
  type AbstractValue,
  type Json,
  type Primitive,
  type RangeValue,
} from "./abstract";
import { and3, not3, or3, NO, UNKNOWN, YES, type Tri } from "./kleene";

/**
 * A tri-state interpreter for the JsonLogic subset the rule sets use (JSON_LOGIC_OPERATORS in
 * shared/contracts/eligibility.ts). It is written here instead of calling json-logic-js because
 * json-logic-js is two-valued and coercive: `{"<=": [{"var": "gpa"}, 3]}` on `{}` is true and
 * `{"!": {"var": "x"}}` is true, so a missing answer would become a "yes".
 *
 * Differences from JsonLogic, all deliberate:
 * - Missing inputs are abstract values (see abstract.ts), never null.
 * - No type coercion: `==` is strict, comparisons need two numbers or two strings, `+` needs
 *   numbers. A type mismatch is a rule bug and raises RuleEvaluationError.
 * - `and`, `or`, `!`, `!!` return booleans (Kleene), not operand values, and never short-circuit,
 *   so every operand is evaluated and order cannot matter.
 * - A `var` default at the top level is ignored: a default would turn missing data into a value.
 * - `missing` and `missing_some` return UNKNOWN when a listed field is unanswered rather than a
 *   list of names, so "not answered" can never decide a rule.
 */

export class RuleEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleEvaluationError";
  }
}

export interface LogicScope {
  /** Value of a top-level catalogue field. Must throw for names outside the catalogue. */
  readonly lookup: (name: string) => AbstractValue;
  /** Whether a top-level field has an answer (used by `missing`). */
  readonly answered: (name: string) => boolean;
}

interface Frame {
  readonly scope: LogicScope;
  /** The current array item inside all/some/none; undefined at the top level. */
  readonly item?: { readonly value: Json };
}

/** Cartesian products larger than this give up and return UNKNOWN (sound, never wrong). */
const MAX_COMBINATIONS = 4096;

export function evaluateLogic(logic: unknown, scope: LogicScope): AbstractValue {
  return ev(logic, { scope });
}

/** Evaluates a rule's logic to a tri-state verdict through JsonLogic truthiness. */
export function evaluateLogicTri(logic: unknown, scope: LogicScope): Tri {
  return truthy(evaluateLogic(logic, scope));
}

function ev(node: unknown, frame: Frame): AbstractValue {
  if (Array.isArray(node)) return evArray(node, frame);
  if (node === null || typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    if (typeof node === "number" && !Number.isFinite(node)) throw new RuleEvaluationError("non-finite number");
    return known(node);
  }
  if (typeof node !== "object") throw new RuleEvaluationError(`unsupported literal ${typeof node}`);
  const keys = Object.keys(node);
  if (keys.length !== 1) throw new RuleEvaluationError("an expression has exactly one operator");
  const op = keys[0] as string;
  const raw = (node as Record<string, unknown>)[op];
  const args: readonly unknown[] = Array.isArray(raw) ? raw : [raw];
  const handler = OPERATORS[op];
  if (!handler) throw new RuleEvaluationError(`unsupported operator ${op}`);
  return handler(args, frame);
}

function evArray(nodes: readonly unknown[], frame: Frame): AbstractValue {
  const values = nodes.map((n) => ev(n, frame));
  if (values.every((v) => v.kind === "known")) return known(values.map((v) => (v as { value: Json }).value));
  return ANYTHING;
}

type Handler = (args: readonly unknown[], frame: Frame) => AbstractValue;

// ---------------------------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------------------------

function literalPath(arg: unknown, frame: Frame): string | number {
  if (typeof arg === "string" || typeof arg === "number") return arg;
  if (arg === undefined || arg === null) return "";
  const v = ev(arg, frame);
  if (v.kind === "known" && (typeof v.value === "string" || typeof v.value === "number")) return v.value;
  throw new RuleEvaluationError("var path must be a known string or number");
}

function walk(data: Json, path: string | number): Json | undefined {
  if (path === "") return data;
  const parts = String(path).split(".");
  let cur: Json | undefined = data;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = Array.isArray(cur) ? (cur as readonly Json[])[Number(part)] : (cur as { readonly [k: string]: Json })[part];
  }
  return cur;
}

const opVar: Handler = (args, frame) => {
  const path = literalPath(args[0], frame);
  if (frame.item) {
    const found = walk(frame.item.value, path);
    if (found !== undefined) return known(found);
    return args.length > 1 ? ev(args[1], frame) : known(null);
  }
  if (typeof path !== "string" || path === "") throw new RuleEvaluationError("top-level var must name a catalogue field");
  // The default (args[1]) is ignored on purpose: missing answers stay missing.
  return frame.scope.lookup(path);
};

function namesFrom(arg: unknown, frame: Frame): string[] {
  const v = ev(arg, frame);
  if (v.kind !== "known") throw new RuleEvaluationError("missing needs literal names");
  const list = Array.isArray(v.value) ? v.value : [v.value];
  return list.map((n) => {
    if (typeof n !== "string") throw new RuleEvaluationError("missing needs string names");
    return n;
  });
}

function isAnswered(name: string, frame: Frame): boolean {
  if (frame.item) {
    const found = walk(frame.item.value, name);
    return found !== undefined && found !== null && found !== "";
  }
  return frame.scope.answered(name);
}

const opMissing: Handler = (args, frame) => {
  const names = args.length === 1 && Array.isArray(args[0]) ? namesFrom(args[0], frame) : args.flatMap((a) => namesFrom(a, frame));
  const absent = names.filter((n) => !isAnswered(n, frame));
  if (absent.length === 0) return known([]);
  return frame.item ? known(absent) : ANYTHING;
};

const opMissingSome: Handler = (args, frame) => {
  const need = ev(args[0], frame);
  if (need.kind !== "known" || typeof need.value !== "number") throw new RuleEvaluationError("missing_some needs a count");
  const names = namesFrom(args[1], frame);
  const absent = names.filter((n) => !isAnswered(n, frame));
  if (names.length - absent.length >= need.value) return known([]);
  return frame.item ? known(absent) : ANYTHING;
};

// ---------------------------------------------------------------------------------------------
// Lifting concrete operations over finite possibilities
// ---------------------------------------------------------------------------------------------

function product(lists: readonly (readonly Json[])[]): Json[][] | null {
  let total = 1;
  for (const l of lists) total *= l.length;
  if (total > MAX_COMBINATIONS) return null;
  let acc: Json[][] = [[]];
  for (const list of lists) {
    const next: Json[][] = [];
    for (const prefix of acc) for (const v of list) next.push([...prefix, v]);
    acc = next;
  }
  return acc;
}

/** Applies a concrete predicate to every combination of finite inputs and folds the answers. */
function liftPredicate(values: readonly AbstractValue[], predicate: (xs: Json[]) => boolean): Tri {
  const lists = values.map(finiteValues);
  if (lists.some((l) => l === null)) return UNKNOWN;
  const combos = product(lists as Json[][]);
  if (!combos) return UNKNOWN;
  let sawTrue = false;
  let sawFalse = false;
  for (const combo of combos) {
    if (predicate(combo)) sawTrue = true;
    else sawFalse = true;
  }
  if (sawTrue && sawFalse) return UNKNOWN;
  return sawTrue ? YES : NO;
}

/** Applies a concrete function to every combination of finite inputs and joins the results. */
function liftValue(values: readonly AbstractValue[], fn: (xs: Json[]) => Json): AbstractValue {
  const lists = values.map(finiteValues);
  if (lists.some((l) => l === null)) return ANYTHING;
  const combos = product(lists as Json[][]);
  if (!combos) return ANYTHING;
  const results = combos.map(fn);
  if (results.length === 1) return known(results[0] as Json);
  if (results.every(isPrimitive)) return oneOf(results as Primitive[]);
  return results.slice(1).reduce<AbstractValue>((acc, r) => join(acc, known(r)), known(results[0] as Json));
}

// ---------------------------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------------------------

type CompareOp = "<" | "<=" | ">" | ">=";

function concreteCompare(op: CompareOp, a: Json, b: Json): boolean {
  const bothNumbers = typeof a === "number" && typeof b === "number";
  const bothStrings = typeof a === "string" && typeof b === "string";
  if (!bothNumbers && !bothStrings) throw new RuleEvaluationError(`cannot compare ${typeOf(a)} with ${typeOf(b)}`);
  const x = a as number | string;
  const y = b as number | string;
  switch (op) {
    case "<":
      return x < y;
    case "<=":
      return x <= y;
    case ">":
      return x > y;
    case ">=":
      return x >= y;
  }
}

function typeOf(v: Json): string {
  return v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
}

function concreteEquals(a: Json, b: Json): boolean {
  if (!isPrimitive(a) || !isPrimitive(b)) throw new RuleEvaluationError("== compares primitives only");
  return a === b;
}

interface Interval {
  readonly lo: number;
  readonly hi: number;
  readonly loOpen: boolean;
  readonly hiOpen: boolean;
}

/** The closed hull of a numeric abstract value, used for interval reasoning (sound for sets). */
function toInterval(v: AbstractValue): Interval {
  if (v.kind === "range") return v;
  const values = finiteValues(v);
  if (!values) throw new RuleEvaluationError("interval of an unknown value");
  if (!values.every((x) => typeof x === "number")) {
    throw new RuleEvaluationError(`cannot compare a number range with ${values.map(typeOf).join("/")}`);
  }
  const nums = values as number[];
  return { lo: Math.min(...nums), hi: Math.max(...nums), loOpen: false, hiOpen: false };
}

/** True when every x in X is below every y in Y (strictly when `strict`). */
function lessAll(x: Interval, y: Interval, strict: boolean): boolean {
  if (!strict) return x.hi <= y.lo;
  return x.hi < y.lo || (x.hi === y.lo && (x.hiOpen || y.loOpen));
}

function compareIntervals(op: CompareOp, x: Interval, y: Interval): Tri {
  switch (op) {
    case "<":
      return lessAll(x, y, true) ? YES : lessAll(y, x, false) ? NO : UNKNOWN;
    case "<=":
      return lessAll(x, y, false) ? YES : lessAll(y, x, true) ? NO : UNKNOWN;
    case ">":
      return compareIntervals("<", y, x);
    case ">=":
      return compareIntervals("<=", y, x);
  }
}

function compareAbstract(op: CompareOp, a: AbstractValue, b: AbstractValue): Tri {
  if (a.kind === "unknown" || b.kind === "unknown") return UNKNOWN;
  if (a.kind === "range" || b.kind === "range") return compareIntervals(op, toInterval(a), toInterval(b));
  return liftPredicate([a, b], ([x, y]) => concreteCompare(op, x as Json, y as Json));
}

function equalsAbstract(a: AbstractValue, b: AbstractValue): Tri {
  if (a.kind === "unknown" || b.kind === "unknown") return UNKNOWN;
  if (a.kind === "range" || b.kind === "range") {
    const x = toInterval(a);
    const y = toInterval(b);
    if (lessAll(x, y, true) || lessAll(y, x, true)) return NO;
    const point = (i: Interval): boolean => i.lo === i.hi && !i.loOpen && !i.hiOpen;
    return point(x) && point(y) && x.lo === y.lo ? YES : UNKNOWN;
  }
  return liftPredicate([a, b], ([x, y]) => concreteEquals(x as Json, y as Json));
}

/**
 * `<` and `<=` take two or three arguments (`{"<=": [1, x, 4]}` means 1 <= x <= 4). With three,
 * a finite middle value is checked value by value so correlated bounds stay exact; for ranges,
 * the conjunction of two half-line tests is already exact because intervals are convex.
 */
function comparison(op: CompareOp): Handler {
  return (args, frame) => {
    if (args.length < 2 || args.length > 3) throw new RuleEvaluationError(`${op} takes 2 or 3 arguments`);
    const vals = args.map((a) => ev(a, frame));
    if (vals.length === 2) return fromTri(compareAbstract(op, vals[0] as AbstractValue, vals[1] as AbstractValue));
    if (op === ">" || op === ">=") throw new RuleEvaluationError(`${op} takes 2 arguments`);
    const [a, b, c] = vals as [AbstractValue, AbstractValue, AbstractValue];
    const middle = finiteValues(b);
    if (middle && a.kind !== "unknown" && c.kind !== "unknown") {
      const perValue = middle.map((m) => and3([compareAbstract(op, a, known(m)), compareAbstract(op, known(m), c)]));
      if (perValue.every((t) => t === YES)) return known(true);
      if (perValue.every((t) => t === NO)) return known(false);
      return ANYTHING;
    }
    return fromTri(and3([compareAbstract(op, a, b), compareAbstract(op, b, c)]));
  };
}

function equality(negate: boolean): Handler {
  return (args, frame) => {
    if (args.length !== 2) throw new RuleEvaluationError("equality takes 2 arguments");
    const t = equalsAbstract(ev(args[0], frame), ev(args[1], frame));
    return fromTri(negate ? not3(t) : t);
  };
}

// ---------------------------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------------------------

const opNot: Handler = (args, frame) => fromTri(not3(truthy(ev(args[0], frame))));
const opNotNot: Handler = (args, frame) => fromTri(truthy(ev(args[0], frame)));

const opAnd: Handler = (args, frame) => {
  if (args.length === 0) throw new RuleEvaluationError("and needs operands");
  return fromTri(and3(args.map((a) => truthy(ev(a, frame)))));
};

const opOr: Handler = (args, frame) => {
  if (args.length === 0) throw new RuleEvaluationError("or needs operands");
  return fromTri(or3(args.map((a) => truthy(ev(a, frame)))));
};

/** if/?: : [cond1, then1, cond2, then2, ..., else]. An UNKNOWN condition joins both branches. */
const opIf: Handler = (args, frame) => {
  const branch = (i: number): AbstractValue => {
    if (i >= args.length) return known(null);
    if (i === args.length - 1) return ev(args[i], frame);
    const cond = truthy(ev(args[i], frame));
    if (cond === YES) return ev(args[i + 1], frame);
    if (cond === NO) return branch(i + 2);
    return join(ev(args[i + 1], frame), branch(i + 2));
  };
  return branch(0);
};

// ---------------------------------------------------------------------------------------------
// Arrays and strings
// ---------------------------------------------------------------------------------------------

function concreteIn(needle: Json, haystack: Json): boolean {
  if (typeof haystack === "string") {
    if (typeof needle !== "string") throw new RuleEvaluationError("in on a string needs a string");
    return haystack.includes(needle);
  }
  if (Array.isArray(haystack)) {
    if (!isPrimitive(needle)) throw new RuleEvaluationError("in compares primitives only");
    return haystack.some((h: Json) => h === needle);
  }
  throw new RuleEvaluationError("in needs an array or string");
}

const opIn: Handler = (args, frame) => {
  if (args.length !== 2) throw new RuleEvaluationError("in takes 2 arguments");
  const needle = ev(args[0], frame);
  const haystack = ev(args[1], frame);
  if (needle.kind === "unknown" || haystack.kind === "unknown") return ANYTHING;
  if (needle.kind === "range") {
    const list = haystack.kind === "known" && Array.isArray(haystack.value) ? (haystack.value as readonly Json[]) : null;
    if (!list) return ANYTHING;
    const inside = list.filter((h) => typeof h === "number" && rangeContains(needle, h));
    return inside.length === 0 ? known(false) : ANYTHING;
  }
  if (haystack.kind === "range") throw new RuleEvaluationError("in needs an array or string");
  return fromTri(liftPredicate([needle, haystack], ([n, h]) => concreteIn(n as Json, h as Json)));
};

function quantifier(kind: "all" | "some" | "none"): Handler {
  return (args, frame) => {
    if (args.length !== 2) throw new RuleEvaluationError(`${kind} takes 2 arguments`);
    const list = ev(args[0], frame);
    if (list.kind !== "known") return ANYTHING;
    if (!Array.isArray(list.value)) throw new RuleEvaluationError(`${kind} needs an array`);
    const items = list.value as readonly Json[];
    const verdicts = items.map((item) => truthy(ev(args[1], { scope: frame.scope, item: { value: item } })));
    if (kind === "all") return items.length === 0 ? known(false) : fromTri(and3(verdicts));
    const some = or3(verdicts);
    return fromTri(kind === "some" ? some : not3(some));
  };
}

const opMerge: Handler = (args, frame) => {
  const parts = args.map((a) => ev(a, frame));
  if (!parts.every((p) => p.kind === "known")) return ANYTHING;
  const out: Json[] = [];
  for (const p of parts as { value: Json }[]) {
    if (Array.isArray(p.value)) out.push(...(p.value as readonly Json[]));
    else out.push(p.value);
  }
  return known(out);
};

const opCat: Handler = (args, frame) =>
  liftValue(
    args.map((a) => ev(a, frame)),
    (xs) =>
      xs
        .map((x) => {
          if (typeof x === "string" || typeof x === "number") return String(x);
          throw new RuleEvaluationError("cat joins strings and numbers only");
        })
        .join(""),
  );

const opSubstr: Handler = (args, frame) =>
  liftValue(
    args.map((a) => ev(a, frame)),
    ([s, start, len]) => {
      if (typeof s !== "string" || typeof start !== "number") throw new RuleEvaluationError("substr needs a string and a start");
      const from = start < 0 ? Math.max(0, s.length + start) : start;
      if (len === undefined || len === null) return s.slice(from);
      if (typeof len !== "number") throw new RuleEvaluationError("substr length must be a number");
      return len < 0 ? s.slice(from, s.length + len) : s.slice(from, from + len);
    },
  );

// ---------------------------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------------------------

function num(x: Json): number {
  if (typeof x !== "number") throw new RuleEvaluationError(`arithmetic needs numbers, got ${typeOf(x)}`);
  return x;
}

function shiftRange(r: RangeValue, by: number): AbstractValue {
  return range(r.lo + by, r.hi + by, { loOpen: r.loOpen, hiOpen: r.hiOpen });
}

function scaleRange(r: RangeValue, k: number): AbstractValue {
  if (k === 0) return known(0);
  if (k > 0) return range(r.lo * k, r.hi * k, { loOpen: r.loOpen, hiOpen: r.hiOpen });
  return range(r.hi * k, r.lo * k, { loOpen: r.hiOpen, hiOpen: r.loOpen });
}

function knownNumber(v: AbstractValue): number | null {
  return v.kind === "known" && typeof v.value === "number" ? v.value : null;
}

/** Range arithmetic only for a range combined with one known number; anything else is UNKNOWN. */
function rangeArithmetic(op: string, a: AbstractValue, b: AbstractValue | undefined): AbstractValue {
  if (b === undefined) return op === "-" && a.kind === "range" ? scaleRange(a, -1) : ANYTHING;
  const ka = knownNumber(a);
  const kb = knownNumber(b);
  if (a.kind === "range" && kb !== null) {
    if (op === "+") return shiftRange(a, kb);
    if (op === "-") return shiftRange(a, -kb);
    if (op === "*") return scaleRange(a, kb);
    if (op === "/" && kb !== 0) return scaleRange(a, 1 / kb);
  }
  if (b.kind === "range" && ka !== null) {
    if (op === "+") return shiftRange(b, ka);
    if (op === "*") return scaleRange(b, ka);
    if (op === "-") return shiftRange(scaleRange(b, -1) as RangeValue, ka);
  }
  return ANYTHING;
}

function arithmetic(op: "+" | "-" | "*" | "/" | "%"): Handler {
  return (args, frame) => {
    const vals = args.map((a) => ev(a, frame));
    if (vals.length === 0) throw new RuleEvaluationError(`${op} needs operands`);
    if (vals.some((v) => v.kind === "range")) {
      if (vals.length > 2) return ANYTHING;
      return rangeArithmetic(op, vals[0] as AbstractValue, vals[1]);
    }
    return liftValue(vals, (xs) => {
      const ns = xs.map(num);
      if (op === "-" && ns.length === 1) return -(ns[0] as number);
      if (op === "+") return ns.reduce((s, n) => s + n, 0);
      if (op === "*") return ns.reduce((s, n) => s * n, 1);
      if (ns.length !== 2) throw new RuleEvaluationError(`${op} takes 2 operands`);
      const [x, y] = ns as [number, number];
      if ((op === "/" || op === "%") && y === 0) throw new RuleEvaluationError("division by zero");
      return op === "-" ? x - y : op === "/" ? x / y : x % y;
    });
  };
}

function extremum(pick: "min" | "max"): Handler {
  return (args, frame) => {
    const vals = args.map((a) => ev(a, frame));
    if (vals.length === 0) throw new RuleEvaluationError(`${pick} needs operands`);
    return liftValue(vals, (xs) => {
      const ns = xs.map(num);
      return pick === "min" ? Math.min(...ns) : Math.max(...ns);
    });
  };
}

const OPERATORS: Readonly<Record<string, Handler>> = {
  var: opVar,
  missing: opMissing,
  missing_some: opMissingSome,
  "==": equality(false),
  "===": equality(false),
  "!=": equality(true),
  "!==": equality(true),
  "<": comparison("<"),
  "<=": comparison("<="),
  ">": comparison(">"),
  ">=": comparison(">="),
  "!": opNot,
  "!!": opNotNot,
  and: opAnd,
  or: opOr,
  if: opIf,
  "?:": opIf,
  in: opIn,
  all: quantifier("all"),
  some: quantifier("some"),
  none: quantifier("none"),
  merge: opMerge,
  "+": arithmetic("+"),
  "-": arithmetic("-"),
  "*": arithmetic("*"),
  "/": arithmetic("/"),
  "%": arithmetic("%"),
  min: extremum("min"),
  max: extremum("max"),
  cat: opCat,
  substr: opSubstr,
};

/** Operators this interpreter implements (kept equal to the contract allowlist by a test). */
export const SUPPORTED_OPERATORS: readonly string[] = Object.keys(OPERATORS);

/** Exposed for tests: JsonLogic truthiness of a concrete value. */
export { concreteTruthy };
