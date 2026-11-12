import { describe, expect, it } from "vitest";
import { attackTable } from "@shared/disclosure/harness";
import { buildProgressView, stageFor, type StatusCount } from "./aggregate";
import { csvCell, exportFileName, neutralizeFormula, toCsv } from "./csv";
import { isFuturePeriod, monthOf, parsePeriod } from "./period";
import { parseIfMatch, publicView } from "./routes";

const LISTED = [
  { slug: "a", name: "Sample A", restricted: false },
  { slug: "b", name: "Sample B", restricted: false },
  { slug: "c", name: "Sample C", restricted: false },
  { slug: "r", name: "Sample Restricted", restricted: true },
];

describe("buildProgressView", () => {
  it("drops restricted programs and not_applying rows before counting", () => {
    const counts: StatusCount[] = [
      { programSlug: "a", status: "interested", n: 8 },
      { programSlug: "b", status: "applying", n: 7 },
      { programSlug: "r", status: "interested", n: 50 },
      { programSlug: "a", status: "not_applying", n: 40 },
    ];
    const view = buildProgressView("2026-11", LISTED, counts);
    expect(view.excluded).toEqual([{ slug: "r", name: "Sample Restricted" }]);
    expect(view.byProgram).toMatchObject({ suppressed: false, total: "10-19" });
    expect(stageFor("not_applying")).toBeNull();
    expect(stageFor("decided")).toBe("submitted");
  });

  it("withholds groups under 5 and never shows a single non-zero category", () => {
    expect(buildProgressView("2026-11", LISTED, [{ programSlug: "a", status: "interested", n: 4 }]).byProgram).toMatchObject({ suppressed: true, reason: "below_min_total" });
    expect(buildProgressView("2026-11", LISTED, [{ programSlug: "a", status: "interested", n: 30 }]).byProgram).toMatchObject({ suppressed: true, reason: "single_category" });
  });

  it("releases tables the differencing attack cannot pin, across many count mixes", () => {
    for (let a = 0; a <= 14; a++) {
      for (let b = 0; b <= 14; b += 3) {
        for (let c = 0; c <= 8; c += 2) {
          const view = buildProgressView("2026-11", LISTED, [
            { programSlug: "a", status: "interested", n: a },
            { programSlug: "b", status: "applying", n: b },
            { programSlug: "c", status: "submitted", n: c },
          ]);
          for (const table of [view.byProgram, view.byStage]) {
            // Every pinned cell is a small one recovered exactly: the harness must find none.
            expect(attackTable(table), `a=${a} b=${b} c=${c}`).toEqual([]);
          }
        }
      }
    }
  });
});

describe("csv", () => {
  it("neutralizes formula starters and quotes separators", () => {
    for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) expect(neutralizeFormula(bad).startsWith("'")).toBe(true);
    expect(neutralizeFormula("Sample program")).toBe("Sample program");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell(null)).toBe("");
    expect(toCsv(["h1", "h2"], [[1, "x\ny"]])).toBe('h1,h2\r\n1,"x\ny"\r\n');
    expect(exportFileName("Sample Pilot: Fall!", "list")).toBe("sample-pilot-fall-list.csv");
  });
});

describe("period", () => {
  it("parses months and quarters as UTC ranges", () => {
    expect(parsePeriod("2026-11")).toEqual({ period: "2026-11", startMs: Date.UTC(2026, 10, 1), endMs: Date.UTC(2026, 11, 1) });
    expect(parsePeriod("2026-Q4")).toEqual({ period: "2026-Q4", startMs: Date.UTC(2026, 9, 1), endMs: Date.UTC(2027, 0, 1) });
    expect(parsePeriod("2026-13")).toBeNull();
    expect(parsePeriod("26-11")).toBeNull();
    expect(monthOf(Date.UTC(2026, 0, 31, 23))).toBe("2026-01");
    expect(isFuturePeriod(parsePeriod("2026-12")!, Date.UTC(2026, 10, 11))).toBe(true);
  });
});

describe("route helpers", () => {
  it("reads If-Match versions", () => {
    expect(parseIfMatch('"3"')).toBe(3);
    expect(parseIfMatch('W/"12"')).toBe(12);
    expect(parseIfMatch("4")).toBe(4);
    expect(parseIfMatch("*")).toBeNull();
    expect(parseIfMatch(undefined)).toBeNull();
  });

  it("strips the workspace id from public list views", () => {
    const view = publicView({
      id: "01900000-0000-7000-8000-000000000001",
      workspaceId: "01900000-0000-7000-8000-000000000002",
      title: "Sample",
      description: null,
      visibility: "public",
      slug: "sample",
      token: null,
      restricted: false,
      items: [],
      updatedAt: "2026-11-11T00:00:00.000Z",
    });
    expect("workspaceId" in view).toBe(false);
  });
});
