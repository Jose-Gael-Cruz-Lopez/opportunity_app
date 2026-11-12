import { describe, expect, it } from "vitest";
import { OUTCOME_DECISIONS } from "../taxonomy";
import { attackPair, attackSeries, attackTable, labelBounds } from "./harness";
import { AUDIENCES, DISCLOSURE, DisclosureError, release, type Audience, type CountRow } from "./index";
import { countLabel, releaseTable, type ReleasedTable } from "./table";

const row = (n: number, categories: CountRow["categories"], over: Partial<CountRow> = {}): CountRow => ({
  period: "2027-03",
  grain: "month",
  cycleKey: "spring-2027",
  categories,
  n,
  ...over,
});
const decisions = (counts: Partial<Record<(typeof OUTCOME_DECISIONS)[number], number>>, over: Partial<CountRow> = {}): CountRow[] =>
  Object.entries(counts).map(([decision, n]) => row(n as number, { decision }, over));
const one = (tables: ReleasedTable[]): ReleasedTable => {
  expect(tables).toHaveLength(1);
  return tables[0] as ReleasedTable;
};

describe("release(): plan fixtures", () => {
  it("{accepted: 3, rejected: 40} shows the large cell and hides the small ones alike", () => {
    const t = one(release(decisions({ accepted: 3, rejected: 40 }), { audience: "public", grain: "month", dims: ["decision"] }));
    expect(t).toEqual({
      period: "2027-03",
      suppressed: false,
      total: "45",
      cells: [
        { key: "accepted", label: "fewer than 10" },
        { key: "rejected", label: "40" },
        { key: "withdrew", label: "fewer than 10" },
        { key: "declined_offer", label: "fewer than 10" },
        { key: "no_response", label: "fewer than 10" },
      ],
    });
    expect(attackTable(t)).toEqual([]);
  });

  it("a lone {accepted: 7} row is suppressed whole", () => {
    expect(one(release(decisions({ accepted: 7 }), { audience: "public", grain: "month", dims: ["decision"] }))).toMatchObject({ suppressed: true, reason: "single_category" });
    expect(one(release(decisions({ accepted: 3 }), { audience: "public", grain: "month", dims: ["decision"] }))).toMatchObject({ suppressed: true, reason: "below_min_total" });
  });

  it("a total-only release bands small totals and suppresses tiny ones", () => {
    expect(one(release(decisions({ accepted: 3, rejected: 4 }), { audience: "public", grain: "month", dims: [] }))).toEqual({ period: "2027-03", suppressed: false, total: "5-9", cells: [] });
    expect(one(release(decisions({ accepted: 2, rejected: 2 }), { audience: "public", grain: "month", dims: [] }))).toMatchObject({ suppressed: true });
    expect(one(release(decisions({ accepted: 33, rejected: 4 }), { audience: "public", grain: "month", dims: [] }))).toMatchObject({ total: "35" });
  });
});

describe("release(): rules R1-R8", () => {
  it("R1 refuses anything shaped like an Outcome row", () => {
    const bad = { ...row(1, { decision: "accepted" }), userId: "u1" } as unknown as CountRow;
    expect(() => release([bad], { audience: "public", grain: "month", dims: ["decision"] })).toThrow(DisclosureError);
    expect(() => release([row(-1, { decision: "accepted" })], { audience: "public", grain: "month", dims: ["decision"] })).toThrow(DisclosureError);
  });

  it("R4 and R8: declared categories, at most two dims, one grain, two-way gated", () => {
    expect(() => release([row(5, { decision: "maybe" })], { audience: "public", grain: "month", dims: ["decision"] })).toThrow(/not declared/);
    expect(() => release([], { audience: "public", grain: "month", dims: ["decision", "stage", "gpa_band"] })).toThrow(/at most two/);
    expect(() => release([row(5, { decision: "accepted" }, { grain: "term" })], { audience: "public", grain: "month", dims: ["decision"] })).toThrow(/one time grain/);
    expect(DISCLOSURE.twoWayEnabled).toBe(false);
    expect(() => release([], { audience: "public", grain: "month", dims: ["decision", "stage"] })).toThrow(/two-way/);
  });

  it("R6 holds applicant-context breakdowns until 14 days after decisions", () => {
    const rows = [row(30, { gpa_band: "3_5_to_3_74" }), row(25, { gpa_band: "3_75_plus" })];
    const o = { audience: "public" as const, grain: "month" as const, dims: ["gpa_band" as const], decisionsCompletedOn: "2027-04-01" };
    expect(one(release(rows, { ...o, asOf: "2027-04-14" }))).toMatchObject({ suppressed: true, reason: "context_delay" });
    expect(one(release(rows, { ...o, asOf: "2027-04-15" }))).toMatchObject({ suppressed: false });
    expect(one(release(rows, { ...o, asOf: "2027-04-20", decisionsCompletedOn: null }))).toMatchObject({ reason: "context_delay" });
  });

  it("R8 suppresses first-generation splits below a table total of 20", () => {
    const o = { audience: "public" as const, grain: "month" as const, dims: ["first_gen" as const], asOf: "2027-06-01", decisionsCompletedOn: "2027-04-01" };
    expect(one(release([row(10, { first_gen: "yes" }), row(9, { first_gen: "no" })], o))).toMatchObject({ reason: "first_gen_total" });
    expect(one(release([row(10, { first_gen: "yes" }), row(12, { first_gen: "no" })], o))).toMatchObject({ suppressed: false });
  });

  it("R7 needs 10 accepted and 10 not accepted per institution over two cycles", () => {
    const o = { audience: "institution" as const, grain: "cycle" as const, dims: ["institution" as const], asOf: "2028-06-01", decisionsCompletedOn: "2028-04-01", institutionIds: ["inst-a", "inst-b"] };
    const at = (inst: string, decision: string, n: number, cycleKey: string): CountRow => row(n, { institution: inst, decision }, { grain: "cycle", period: "all", cycleKey });
    const oneCycle = [at("inst-a", "accepted", 12, "spring-2027"), at("inst-a", "rejected", 30, "spring-2027"), at("inst-b", "accepted", 11, "spring-2027"), at("inst-b", "rejected", 40, "spring-2027")];
    expect(one(release(oneCycle, o))).toMatchObject({ reason: "institution_split" });
    const twoCycles = [...oneCycle, at("inst-a", "rejected", 5, "spring-2028"), at("inst-b", "accepted", 1, "spring-2028")];
    expect(one(release(twoCycles, o))).toMatchObject({ suppressed: false });
  });

  it("splits periods and zero-fills each one", () => {
    const rows = [...decisions({ accepted: 12, rejected: 30 }), ...decisions({ accepted: 15, rejected: 31 }, { period: "2027-04" })];
    const out = release(rows, { audience: "public", grain: "month", dims: ["decision"] });
    expect(out.map((t) => t.period)).toEqual(["2027-03", "2027-04"]);
    for (const t of out) if (!t.suppressed) expect(t.cells.map((c) => c.key)).toEqual([...OUTCOME_DECISIONS]);
  });
});

describe("releaseTable (internal) and labels", () => {
  it("bands below 20 and rounds to 5 above", () => {
    expect([5, 9, 10, 19, 20, 22, 23, 47].map(countLabel)).toEqual(["5-9", "5-9", "10-19", "10-19", "20", "20", "25", "45"]);
  });

  it("withholds a table whose shown total would prove every small cell non-zero", () => {
    // Plan sketch would print total "5-9" with both cells "fewer than 5": each is then >= 1.
    expect(releaseTable("p", [{ key: "a", n: 3 }, { key: "b", n: 4 }], "advisor", false)).toMatchObject({ suppressed: true, reason: "unsafe_small_cells" });
    expect(releaseTable("p", [{ key: "a", n: 9 }, { key: "b", n: 8 }], "public", false)).toMatchObject({ suppressed: true, reason: "unsafe_small_cells" });
    // With a zero-filled third category the mass can sit anywhere, so the table is safe to show.
    expect(releaseTable("p", [{ key: "a", n: 9 }, { key: "b", n: 8 }, { key: "c", n: 0 }], "public", false)).toMatchObject({ suppressed: false });
  });

  it("adds a complementary 'not shown' cell when exactly one cell is small", () => {
    const t = releaseTable("p", [{ key: "a", n: 5 }, { key: "b", n: 19 }, { key: "c", n: 40 }], "public", false);
    expect(t).toMatchObject({ suppressed: false, cells: [{ key: "a", label: "fewer than 10" }, { key: "b", label: "not shown" }, { key: "c", label: "40" }] });
    expect(attackTable(t)).toEqual([]);
  });

  it("two-way tables need every cell to pass", () => {
    expect(releaseTable("p", [{ key: "a|x", n: 12 }, { key: "a|y", n: 9 }, { key: "b|x", n: 30 }, { key: "b|y", n: 11 }], "public", true)).toMatchObject({ reason: "two_way_small_cell" });
    expect(releaseTable("p", [{ key: "a|x", n: 12 }, { key: "a|y", n: 10 }, { key: "b|x", n: 30 }, { key: "b|y", n: 11 }], "public", true)).toMatchObject({ suppressed: false });
  });
});

describe("property tests per audience (seeded)", () => {
  function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = prng(9_06);
  const tables = Array.from({ length: 600 }, () => {
    const k = 2 + Math.floor(rand() * 5);
    return Array.from({ length: k }, (_, i) => ({ key: `c${i}`, n: rand() < 0.3 ? 0 : Math.floor(rand() * (rand() < 0.5 ? 15 : 80)) }));
  });

  it.each(AUDIENCES.map((a) => [a] as const))("%s: labels never imply a count below threshold, complements never read 'fewer than', nothing is pinned", (audience: Audience) => {
    const { minTotal, minCell } = DISCLOSURE.audiences[audience];
    for (const cells of tables) {
      const t = releaseTable("p", cells, audience, false);
      const total = cells.reduce((s, c) => s + c.n, 0);
      const nonZero = cells.filter((c) => c.n > 0).length;
      if (total < minTotal || nonZero <= 1) {
        expect(t.suppressed).toBe(true);
        continue;
      }
      if (t.suppressed) {
        // The only other withholding: every cell would have to be hidden.
        expect(t.reason).toBe("unsafe_small_cells");
        expect(cells.every((c) => c.n < minCell)).toBe(true);
        continue;
      }
      for (const [i, c] of t.cells.entries()) {
        const n = (cells[i] as { n: number }).n;
        if (n < minCell) expect(c.label).toBe(`fewer than ${minCell}`);
        else expect(c.label.startsWith("fewer than")).toBe(false);
        const b = labelBounds(c.label);
        expect(n >= b.lo && n <= b.hi, `${c.label} vs ${n}`).toBe(true);
      }
      expect(t.cells.filter((c) => c.label === "not shown").length).toBeLessThanOrEqual(1);
      expect(attackTable(t)).toEqual([]);
    }
  });
});

describe("differencing harness", () => {
  it("pins a small cell when complementary suppression is missing (the check bites)", () => {
    const unsafe: ReleasedTable = { period: "p", suppressed: false, total: "25", cells: [{ key: "a", label: "fewer than 10" }, { key: "b", label: "10-19" }] };
    expect(attackTable(unsafe)).toEqual([{ period: "p", key: "a", label: "fewer than 10", derived: { lo: 4, hi: 9 } }]);
  });

  it("uses monotone cumulative counts across releases", () => {
    const earlier: ReleasedTable = { period: "w1", suppressed: false, total: "5-9", cells: [{ key: "a", label: "5-9" }, { key: "b", label: "fewer than 5" }] };
    const later: ReleasedTable = { period: "w2", suppressed: false, total: "5-9", cells: [{ key: "a", label: "5-9" }, { key: "b", label: "fewer than 5" }] };
    expect(attackPair(earlier, later)).toEqual([]);
    const leaky: ReleasedTable = { period: "w2", suppressed: false, total: "10-19", cells: [{ key: "a", label: "not shown" }, { key: "b", label: "fewer than 10" }] };
    const prior: ReleasedTable = { period: "w1", suppressed: false, total: "10-19", cells: [{ key: "a", label: "10-19" }, { key: "b", label: "fewer than 10" }] };
    // Each table alone hides the cells; together a <= 19 and the later total bound nothing new.
    expect(attackSeries([prior, leaky])).toEqual([]);
  });

  it("a named winner reporting today cannot be pinned in weekly cumulative releases", () => {
    const weeks = [
      { accepted: 9, rejected: 30 },
      { accepted: 10, rejected: 30 },
      { accepted: 10, rejected: 34 },
    ];
    const released = weeks.map((w, i) => one(release(decisions(w, { period: `w${i}` }), { audience: "public", grain: "month", dims: ["decision"] })));
    expect(attackSeries(released)).toEqual([]);
  });
});
