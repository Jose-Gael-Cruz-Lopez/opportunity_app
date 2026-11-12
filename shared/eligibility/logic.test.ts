import * as jsonLogicModule from "json-logic-js";
import { describe, expect, it } from "vitest";
import { JSON_LOGIC_OPERATORS } from "../contracts/eligibility";
import { ANYTHING, known, oneOf, range, type AbstractValue, type Json } from "./abstract";
import { NO, UNKNOWN, YES } from "./kleene";
import { evaluateLogic, evaluateLogicTri, RuleEvaluationError, SUPPORTED_OPERATORS, type LogicScope } from "./logic";

type JsonLogicApi = typeof jsonLogicModule;
const jsonLogic: JsonLogicApi = (jsonLogicModule as JsonLogicApi & { default?: JsonLogicApi }).default ?? jsonLogicModule;

function scope(values: Record<string, AbstractValue>): LogicScope {
  return {
    lookup: (name) => {
      if (!(name in values)) throw new RuleEvaluationError(`unknown field ${name}`);
      return values[name] as AbstractValue;
    },
    answered: (name) => name in values && values[name]!.kind === "known",
  };
}
const tri = (logic: unknown, values: Record<string, AbstractValue> = {}): number => evaluateLogicTri(logic, scope(values));

describe("operator coverage", () => {
  it("implements exactly the contract allowlist", () => {
    expect([...SUPPORTED_OPERATORS].sort()).toEqual([...JSON_LOGIC_OPERATORS].sort());
  });
});

describe("missing data never becomes a verdict (the json-logic-js failure)", () => {
  it("json-logic-js says yes on missing data; this interpreter says unknown", () => {
    // Documented pitfall: two-valued coercion turns a missing GPA into a pass.
    expect(jsonLogic.apply({ "<=": [{ var: "gpa" }, 3] }, {})).toBe(true);
    expect(jsonLogic.apply({ "!": { var: "x" } }, {})).toBe(true);
    expect(tri({ "<=": [{ var: "gpa" }, 3] }, { gpa: ANYTHING })).toBe(UNKNOWN);
    expect(tri({ "!": { var: "x" } }, { x: ANYTHING })).toBe(UNKNOWN);
  });

  it("does not coerce types", () => {
    expect(jsonLogic.apply({ "==": [1, "1"] }, {})).toBe(true);
    expect(tri({ "==": [1, "1"] })).toBe(NO);
    expect(() => tri({ "<": [1, "2"] })).toThrow(RuleEvaluationError);
    expect(() => tri({ "+": [1, "2"] })).toThrow(RuleEvaluationError);
  });

  it("ignores a top-level var default so a missing answer stays missing", () => {
    expect(tri({ ">=": [{ var: ["gpa", 4] }, 3] }, { gpa: ANYTHING })).toBe(UNKNOWN);
  });

  it("missing/missing_some never decide on unanswered fields", () => {
    expect(tri({ missing: ["a"] }, { a: ANYTHING })).toBe(UNKNOWN);
    expect(tri({ "!": { missing: ["a"] } }, { a: ANYTHING })).toBe(UNKNOWN);
    expect(evaluateLogic({ missing: ["a"] }, scope({ a: known("x") }))).toEqual(known([]));
    expect(tri({ missing_some: [1, ["a", "b"]] }, { a: known(1), b: ANYTHING })).toBe(NO);
    expect(tri({ missing_some: [2, ["a", "b"]] }, { a: known(1), b: ANYTHING })).toBe(UNKNOWN);
  });
});

describe("agrees with json-logic-js when every input is known and well typed", () => {
  const data = { classYear: "second_year", gpa: 3.4, terms: 4, state: "CA", cip: "11.0701", tags: ["a", "b"], flag: true };
  const cases: unknown[] = [
    { "==": [{ var: "classYear" }, "second_year"] },
    { "!=": [{ var: "state" }, "TX"] },
    { "<=": [1, { var: "terms" }, 4] },
    { "<": [1, { var: "terms" }, 4] },
    { ">=": [{ var: "gpa" }, 3.3] },
    { in: [{ var: "state" }, ["CA", "OR", "WA"]] },
    { in: ["b", { var: "tags" }] },
    { in: [{ substr: [{ var: "cip" }, 0, 2] }, ["11", "14"]] },
    { and: [{ var: "flag" }, { ">": [{ var: "gpa" }, 3] }] },
    { or: [{ "==": [{ var: "state" }, "TX"] }, { "==": [{ var: "terms" }, 4] }] },
    { if: [{ ">": [{ var: "gpa" }, 3.5] }, true, { "==": [{ var: "state" }, "CA"] }] },
    { some: [{ var: "tags" }, { "==": [{ var: "" }, "a"] }] },
    { all: [{ var: "tags" }, { in: [{ var: "" }, ["a", "b"]] }] },
    { none: [{ var: "tags" }, { "==": [{ var: "" }, "z"] }] },
    { "==": [{ cat: [{ var: "state" }, "-", { var: "terms" }] }, "CA-4"] },
    { "==": [{ "+": [{ var: "terms" }, 1] }, 5] },
    { "==": [{ "%": [{ var: "terms" }, 3] }, 1] },
    { ">": [{ max: [{ var: "terms" }, 2, 7] }, 6] },
    { in: ["a", { merge: [["z"], { var: "tags" }] }] },
    { "!!": [{ var: "tags" }] },
  ];
  it.each(cases.map((c, i) => [i, c] as const))("expression %i", (_i, logic) => {
    const values = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, known(v as Json)]));
    const ours = tri(logic, values);
    const theirs = Boolean(jsonLogic.apply(logic as Parameters<JsonLogicApi["apply"]>[0], data)) ? YES : NO;
    expect(ours).toBe(theirs);
  });
});

describe("interval reasoning", () => {
  const gpa = range(3.25, 3.5, { hiOpen: true });
  it("decides a floor below, above or inside a band", () => {
    expect(tri({ ">=": [{ var: "g" }, 3.25] }, { g: gpa })).toBe(YES);
    expect(tri({ ">=": [{ var: "g" }, 3.3] }, { g: gpa })).toBe(UNKNOWN);
    expect(tri({ ">=": [{ var: "g" }, 3.5] }, { g: gpa })).toBe(NO); // max is exclusive
    expect(tri({ "<": [{ var: "g" }, 3.5] }, { g: gpa })).toBe(YES);
    expect(tri({ ">": [3.0, { var: "g" }] }, { g: gpa })).toBe(NO);
    expect(tri({ "==": [{ var: "g" }, 3.0] }, { g: gpa })).toBe(NO);
    expect(tri({ "==": [{ var: "g" }, 3.3] }, { g: gpa })).toBe(UNKNOWN);
  });

  it("three-argument between is exact for ranges and sets", () => {
    expect(tri({ "<=": [1, { var: "t" }, 4] }, { t: range(1.33, 2.0) })).toBe(YES);
    expect(tri({ "<=": [1, { var: "t" }, 4] }, { t: range(3.67, 4.33) })).toBe(UNKNOWN);
    expect(tri({ "<=": [1, { var: "t" }, 4] }, { t: range(5.67, 6.33) })).toBe(NO);
    // Correlated reads of a set: neither 1 nor 5 lies in (2, 4).
    expect(tri({ "<": [2, { var: "s" }, 4] }, { s: oneOf([1, 5]) })).toBe(NO);
  });

  it("range arithmetic shifts and scales", () => {
    expect(tri({ ">=": [{ "*": [{ var: "g" }, 2] }, 6.5] }, { g: gpa })).toBe(YES);
    expect(tri({ "<": [{ "-": [{ var: "g" }, 1] }, 2.5] }, { g: gpa })).toBe(YES);
    expect(tri({ ">": [{ "-": [{ var: "g" }] }, -3] }, { g: gpa })).toBe(NO);
  });

  it("range truthiness and membership", () => {
    expect(tri({ "!!": [{ var: "g" }] }, { g: gpa })).toBe(YES);
    expect(tri({ "!!": [{ var: "z" }] }, { z: range(-1, 1) })).toBe(UNKNOWN);
    expect(tri({ in: [{ var: "g" }, [1, 2]] }, { g: gpa })).toBe(NO);
    expect(tri({ in: [{ var: "g" }, [3.3]] }, { g: gpa })).toBe(UNKNOWN);
  });
});

describe("finite sets and Kleene connectives", () => {
  const year = oneOf(["first_year", "second_year"]);
  it("lifts predicates over every possible value", () => {
    expect(tri({ in: [{ var: "y" }, ["first_year", "second_year"]] }, { y: year })).toBe(YES);
    expect(tri({ "==": [{ var: "y" }, "first_year"] }, { y: year })).toBe(UNKNOWN);
    expect(tri({ "==": [{ var: "y" }, "third_year"] }, { y: year })).toBe(NO);
  });

  it("and/or follow strong Kleene and evaluate every operand", () => {
    expect(tri({ and: [false, { var: "u" }] }, { u: ANYTHING })).toBe(NO);
    expect(tri({ or: [true, { var: "u" }] }, { u: ANYTHING })).toBe(YES);
    expect(tri({ and: [true, { var: "u" }] }, { u: ANYTHING })).toBe(UNKNOWN);
    // No short-circuit: a type error in a later operand is still reported.
    expect(() => tri({ and: [false, { "<": [1, "x"] }] })).toThrow(RuleEvaluationError);
  });

  it("if joins both branches under an unknown condition", () => {
    expect(tri({ if: [{ var: "u" }, true, true] }, { u: ANYTHING })).toBe(YES);
    expect(tri({ if: [{ var: "u" }, true, false] }, { u: ANYTHING })).toBe(UNKNOWN);
    expect(tri({ "?:": [{ var: "u" }, false, false] }, { u: ANYTHING })).toBe(NO);
    expect(evaluateLogic({ if: [false, 1] }, scope({}))).toEqual(known(null));
  });

  it("quantifiers follow JsonLogic (all of [] is false) and stay unknown on unknown arrays", () => {
    expect(tri({ all: [[], true] })).toBe(NO);
    expect(tri({ some: [{ var: "l" }, true] }, { l: ANYTHING })).toBe(UNKNOWN);
    const items = { l: known([{ a: 1 }, { a: 2 }]) };
    expect(tri({ all: [{ var: "l" }, { ">": [{ var: "a" }, 0] }] }, items)).toBe(YES);
    expect(tri({ some: [{ var: "l" }, { "==": [{ var: ["b", 1] }, 1] }] }, items)).toBe(YES);
  });

  it("strings: in, cat and substr", () => {
    expect(tri({ in: ["11", "11.0701"] })).toBe(YES);
    expect(evaluateLogic({ substr: ["11.0701", -4] }, scope({}))).toEqual(known("0701"));
    expect(evaluateLogic({ substr: ["11.0701", 0, -5] }, scope({}))).toEqual(known("11"));
    expect(evaluateLogic({ cat: ["a", 1] }, scope({}))).toEqual(known("a1"));
  });
});

describe("rule bugs raise RuleEvaluationError", () => {
  it.each([
    [{ nope: [1] }],
    [{ "==": [1, 2], "!=": [1, 2] }],
    [{ "/": [1, 0] }],
    [{ in: [1, 2] }],
    [{ "<": [1] }],
    [{ ">": [1, 2, 3] }],
    [{ and: [] }],
    [{ var: "" }],
    [{ "==": [[1], [1]] }],
  ])("%j", (logic) => {
    expect(() => tri(logic)).toThrow(RuleEvaluationError);
  });

  it("unknown top-level fields are refused", () => {
    expect(() => tri({ var: "notAField" })).toThrow(RuleEvaluationError);
  });
});
