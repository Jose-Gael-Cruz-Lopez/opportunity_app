import { describe, expect, it } from "vitest";
import { agree3, and3, not3, or3, triToVerdict, verdictToTri, NO, UNKNOWN, YES, type Tri } from "./kleene";

const V: readonly Tri[] = [NO, UNKNOWN, YES];
const name = (t: Tri): string => ({ [-1]: "N", 0: "U", 1: "Y" })[t];

describe("strong Kleene truth tables", () => {
  // Rows: a, columns: b. Strong Kleene AND/OR as published (Kleene 1938).
  const AND: Record<string, string> = { NN: "N", NU: "N", NY: "N", UN: "N", UU: "U", UY: "U", YN: "N", YU: "U", YY: "Y" };
  const OR: Record<string, string> = { NN: "N", NU: "U", NY: "Y", UN: "U", UU: "U", UY: "Y", YN: "Y", YU: "Y", YY: "Y" };

  it.each(V.flatMap((a) => V.map((b) => [a, b] as const)))("and/or(%i, %i)", (a, b) => {
    expect(name(and3([a, b]))).toBe(AND[name(a) + name(b)]);
    expect(name(or3([a, b]))).toBe(OR[name(a) + name(b)]);
  });

  it("negation swaps yes and no and keeps unknown", () => {
    expect(V.map((v) => name(not3(v)))).toEqual(["Y", "U", "N"]);
    for (const v of V) expect(Object.is(not3(v), -0)).toBe(false);
  });

  it("identities: empty and is yes, empty or is no", () => {
    expect(and3([])).toBe(YES);
    expect(or3([])).toBe(NO);
  });

  it("is commutative and associative over every triple (order of rules never matters)", () => {
    for (const a of V) for (const b of V) for (const c of V) {
      expect(and3([a, b, c])).toBe(and3([c, a, b]));
      expect(and3([and3([a, b]), c])).toBe(and3([a, and3([b, c])]));
      expect(or3([or3([a, b]), c])).toBe(or3([a, or3([b, c])]));
      expect(or3([a, b, c])).toBe(or3([b, c, a]));
    }
  });

  it("satisfies De Morgan", () => {
    for (const a of V) for (const b of V) {
      expect(not3(and3([a, b]))).toBe(or3([not3(a), not3(b)]));
      expect(not3(or3([a, b]))).toBe(and3([not3(a), not3(b)]));
    }
  });

  it("is monotone in information: refining an unknown input never flips yes and no", () => {
    // For every position holding U, replacing it with Y or N may only move the result from U.
    const ops = [and3, or3];
    for (const op of ops) for (const a of V) for (const b of V) {
      const before = op([a, b]);
      for (const refined of [YES, NO]) {
        const after = op([a === UNKNOWN ? refined : a, b]);
        if (before !== UNKNOWN) expect(after).toBe(before);
      }
    }
  });
});

describe("agree3 (possible-worlds fold)", () => {
  it("is yes or no only when every world agrees", () => {
    expect(agree3([YES, YES])).toBe(YES);
    expect(agree3([NO, NO, NO])).toBe(NO);
    expect(agree3([YES, NO])).toBe(UNKNOWN);
    expect(agree3([YES, UNKNOWN])).toBe(UNKNOWN);
    expect(agree3([])).toBe(UNKNOWN);
  });

  it("maps to contract verdicts and back", () => {
    for (const v of V) expect(verdictToTri(triToVerdict(v))).toBe(v);
    expect(triToVerdict(YES)).toBe("met");
    expect(triToVerdict(NO)).toBe("not_met");
    expect(triToVerdict(UNKNOWN)).toBe("unknown");
  });
});
