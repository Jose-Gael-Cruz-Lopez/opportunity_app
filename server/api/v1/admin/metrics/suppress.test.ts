import { describe, expect, it } from "vitest";
import { cell, HIDDEN, isSmall, K_MIN, partition, rate } from "./suppress";
import { dayStartMs, weekIndex, weekStartDate, weekStartMs } from "./weeks";

describe("cell", () => {
  it("shows 0 and counts of at least k, hides 1 to k-1", () => {
    expect(K_MIN).toBe(5);
    expect(cell(0)).toEqual({ n: 0, hidden: false });
    for (let n = 1; n < 5; n++) expect(cell(n)).toEqual(HIDDEN);
    expect(cell(5)).toEqual({ n: 5, hidden: false });
    expect(cell(1234)).toEqual({ n: 1234, hidden: false });
    expect(isSmall(0)).toBe(false);
    expect(isSmall(4)).toBe(true);
  });

  it("refuses anything that is not a count", () => {
    expect(() => cell(-1)).toThrow(RangeError);
    expect(() => cell(2.5)).toThrow(RangeError);
    expect(() => cell(Number.NaN)).toThrow(RangeError);
  });
});

describe("rate", () => {
  it("divides shown counts only", () => {
    expect(rate(cell(9), cell(12))).toBe(0.75);
    expect(rate(cell(2), cell(12))).toBeNull();
    expect(rate(cell(9), cell(3))).toBeNull();
    expect(rate(cell(0), cell(0))).toBeNull();
    expect(rate(cell(5), cell(15))).toBe(0.333);
  });
});

describe("partition", () => {
  const keys = (p: ReturnType<typeof partition>) => p.cells.filter((c) => c.count.hidden).map((c) => c.key);

  it("shows a table without small cells as is", () => {
    const p = partition([
      { key: "a", n: 10 },
      { key: "b", n: 0 },
      { key: "c", n: 7 },
    ]);
    expect(p.total).toEqual({ n: 17, hidden: false });
    expect(keys(p)).toEqual([]);
  });

  it("hides every non-zero cell when a single small cell could be recovered from the total", () => {
    const p = partition([
      { key: "a", n: 2 },
      { key: "b", n: 30 },
      { key: "c", n: 6 },
      { key: "d", n: 0 },
    ]);
    expect(p.total.n).toBe(38);
    expect(keys(p)).toEqual(["a", "b", "c"]);
    expect(p.cells[3]!.count).toEqual({ n: 0, hidden: false });
  });

  it("does the same when several small cells must all be 1 or all be k-1", () => {
    expect(keys(partition([{ key: "a", n: 1 }, { key: "b", n: 1 }, { key: "c", n: 9 }]))).toEqual(["a", "b", "c"]);
    expect(keys(partition([{ key: "a", n: 4 }, { key: "b", n: 4 }, { key: "c", n: 9 }]))).toEqual(["a", "b", "c"]);
    // 2 + 3: each could be 1-4, so the other cells stay.
    const p = partition([{ key: "a", n: 2 }, { key: "b", n: 3 }, { key: "c", n: 9 }]);
    expect(keys(p)).toEqual(["a", "b"]);
    expect(p.cells[2]!.count.n).toBe(9);
  });

  it("hides everything, zeros included, when the total itself is small", () => {
    const p = partition([{ key: "a", n: 3 }, { key: "b", n: 0 }]);
    expect(p.total).toEqual(HIDDEN);
    expect(p.cells.map((c) => c.count)).toEqual([HIDDEN, HIDDEN]);
    expect(partition([{ key: "a", n: 0 }, { key: "b", n: 0 }]).total).toEqual({ n: 0, hidden: false });
  });

  it("never shows a count between 1 and k-1", () => {
    for (let a = 0; a < 12; a++)
      for (let b = 0; b < 12; b++) {
        const p = partition([{ key: "a", n: a }, { key: "b", n: b }]);
        for (const c of [p.total, ...p.cells.map((x) => x.count)]) if (c.n !== null) expect(c.n === 0 || c.n >= 5).toBe(true);
      }
  });

  /**
   * The attacker knows the algorithm and the released table. For every count vector it collects
   * every vector that releases the same table; a hidden cell is pinned when all of them agree on
   * its value. The second pass also gives the attacker the true total, as if another table had
   * published it. Every table over three categories with a total up to 30.
   */
  function attack(totalKnown: boolean): number {
    const LIMIT = 30;
    const groups = new Map<string, number[][]>();
    for (let a = 0; a <= LIMIT; a++)
      for (let b = 0; a + b <= LIMIT; b++)
        for (let c = 0; a + b + c <= LIMIT; c++) {
          const v = [a, b, c];
          const released = partition(v.map((n, i) => ({ key: String(i), n })));
          const sig = JSON.stringify(totalKnown ? { ...released, total: a + b + c } : released);
          const g = groups.get(sig) ?? [];
          g.push(v);
          groups.set(sig, g);
        }
    let checked = 0;
    for (const [sig, vectors] of groups) {
      const total = vectors[0]!.reduce((s, n) => s + n, 0);
      // Near the enumeration limit a hidden total could also come from vectors past it.
      if (total > LIMIT - 5) continue;
      const released = JSON.parse(sig) as ReturnType<typeof partition>;
      released.cells.forEach((cellOut, i) => {
        if (!cellOut.count.hidden) return;
        const values = new Set(vectors.map((v) => v[i]));
        expect(values.size, `${sig} cell ${i}`).toBeGreaterThan(1);
        checked++;
      });
    }
    return checked;
  }

  it("leaves no hidden cell recoverable by an attacker who re-runs the algorithm", () => {
    expect(attack(false)).toBeGreaterThan(100);
  });

  it("stays safe when the total is known from another table", () => {
    expect(attack(true)).toBeGreaterThan(100);
  });
});

describe("weeks", () => {
  it("starts weeks on Monday UTC and round-trips", () => {
    const wed = Date.parse("2026-11-11T15:00:00Z");
    const w = weekIndex(wed);
    expect(weekStartDate(w)).toBe("2026-11-09");
    expect(weekIndex(weekStartMs(w))).toBe(w);
    expect(weekIndex(weekStartMs(w) - 1)).toBe(w - 1);
    expect(weekStartDate(w - 1)).toBe("2026-11-02");
    expect(dayStartMs(wed)).toBe(Date.parse("2026-11-11T00:00:00Z"));
  });
});
