import { NO, UNKNOWN, YES, type Tri } from "./kleene";

/**
 * Abstract values: what the evaluator knows about an input. Instead of coercing a missing value
 * to null or 0 (the JsonLogic behaviour that turns missing data into a false "yes"), every input
 * is the set of values it could possibly be:
 *
 * - `known`: exactly one value.
 * - `set`: one of a finite list of primitives (an unanswered enum, an age that depends on the
 *   day of a birth month).
 * - `range`: any number in an interval (a GPA band, a term count converted from quarters).
 * - `unknown`: anything at all.
 *
 * A predicate over an abstract value is YES when every possible value satisfies it, NO when none
 * does, and UNKNOWN otherwise.
 */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Primitive = null | boolean | number | string;

export interface KnownValue {
  readonly kind: "known";
  readonly value: Json;
}
export interface SetValue {
  readonly kind: "set";
  /** At least two distinct primitives. */
  readonly values: readonly Primitive[];
}
export interface RangeValue {
  readonly kind: "range";
  readonly lo: number;
  readonly hi: number;
  readonly loOpen: boolean;
  readonly hiOpen: boolean;
}
export interface UnknownValue {
  readonly kind: "unknown";
}
export type AbstractValue = KnownValue | SetValue | RangeValue | UnknownValue;

export const ANYTHING: UnknownValue = Object.freeze({ kind: "unknown" });

export function known(value: Json): KnownValue {
  return { kind: "known", value };
}

export function isPrimitive(value: Json): value is Primitive {
  return value === null || typeof value !== "object";
}

/** A finite set of possible primitives; collapses to `known` when only one value remains. */
export function oneOf(values: readonly Primitive[]): AbstractValue {
  const distinct: Primitive[] = [];
  for (const v of values) if (!distinct.some((d) => Object.is(d, v) || d === v)) distinct.push(v);
  if (distinct.length === 0) return ANYTHING;
  if (distinct.length === 1) return known(distinct[0] as Primitive);
  return { kind: "set", values: distinct };
}

export function range(lo: number, hi: number, opts: { loOpen?: boolean; hiOpen?: boolean } = {}): AbstractValue {
  const loOpen = opts.loOpen ?? false;
  const hiOpen = opts.hiOpen ?? false;
  if (lo === hi && !loOpen && !hiOpen) return known(lo);
  return { kind: "range", lo, hi, loOpen, hiOpen };
}

export function fromTri(value: Tri): AbstractValue {
  return value === UNKNOWN ? ANYTHING : known(value === YES);
}

/** JsonLogic truthiness on a concrete value: [], "", 0, null and false are falsy. */
export function concreteTruthy(value: Json): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

/** Truthiness lifted to abstract values. */
export function truthy(value: AbstractValue): Tri {
  switch (value.kind) {
    case "known":
      return concreteTruthy(value.value) ? YES : NO;
    case "set": {
      const truths = value.values.map((v) => concreteTruthy(v));
      if (truths.every(Boolean)) return YES;
      return truths.some(Boolean) ? UNKNOWN : NO;
    }
    case "range": {
      if (rangeContains(value, 0)) return value.lo === 0 && value.hi === 0 ? NO : UNKNOWN;
      return YES;
    }
    case "unknown":
      return UNKNOWN;
  }
}

export function rangeContains(r: RangeValue, x: number): boolean {
  const aboveLo = r.loOpen ? x > r.lo : x >= r.lo;
  const belowHi = r.hiOpen ? x < r.hi : x <= r.hi;
  return aboveLo && belowHi;
}

/** The finite possible values of a known or set value, or null when the value is not finite. */
export function finiteValues(value: AbstractValue): readonly Json[] | null {
  if (value.kind === "known") return [value.value];
  if (value.kind === "set") return value.values;
  return null;
}

/**
 * The union of two abstract values, used where a condition is UNKNOWN and either branch could
 * apply. Finite primitives merge into a set; anything else becomes `unknown`.
 */
export function join(a: AbstractValue, b: AbstractValue): AbstractValue {
  const fa = finiteValues(a);
  const fb = finiteValues(b);
  if (fa && fb && fa.every(isPrimitive) && fb.every(isPrimitive)) {
    return oneOf([...(fa as Primitive[]), ...(fb as Primitive[])]);
  }
  if (a.kind === "known" && b.kind === "known" && sameJson(a.value, b.value)) return a;
  if (a.kind === "range" && b.kind === "range") {
    const lo = Math.min(a.lo, b.lo);
    const hi = Math.max(a.hi, b.hi);
    return range(lo, hi, {
      loOpen: (a.lo === lo ? a.loOpen : true) && (b.lo === lo ? b.loOpen : true),
      hiOpen: (a.hi === hi ? a.hiOpen : true) && (b.hi === hi ? b.hiOpen : true),
    });
  }
  return ANYTHING;
}

export function sameJson(a: Json, b: Json): boolean {
  if (isPrimitive(a) || isPrimitive(b)) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameJson(v, b[i] as Json));
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  const oa = a as { readonly [key: string]: Json };
  const ob = b as { readonly [key: string]: Json };
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameJson(oa[k] as Json, ob[k] as Json));
}

export { NO, UNKNOWN, YES };
