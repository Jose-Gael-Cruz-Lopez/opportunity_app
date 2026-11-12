import { describe, expect, it } from "vitest";
import { IdSchema, PublicIdSchema } from "../../shared/contracts/common";
import { newPublicId, oneOf, stableId, uuidv7 } from "./columns";
import { canonicalJson, chunked, decodeCursor, encodeCursor, isoOrNull, msOrNull, rowsPerInsert, ruleSetHash, sha256Hex } from "./util";
import { chunk, inlineParams, renderStatements, sqlLiteral } from "./seed/sql";
import { humanize, lookupStatements } from "./seed/lookups";
import { text, sqliteTable } from "drizzle-orm/sqlite-core";

describe("ids", () => {
  it("uuidv7 is a valid UUID with version 7 and sorts by time", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(IdSchema.safeParse(a).success).toBe(true);
    expect(a[14]).toBe("7");
    expect(["8", "9", "a", "b"]).toContain(a[19]);
    expect(a < b).toBe(true);
  });

  it("stableId is deterministic, distinct and valid", () => {
    expect(stableId("x")).toBe(stableId("x"));
    expect(stableId("x")).not.toBe(stableId("y"));
    expect(IdSchema.safeParse(stableId("sample:program:a")).success).toBe(true);
    const many = new Set(Array.from({ length: 2000 }, (_, i) => stableId(`k${i}`)));
    expect(many.size).toBe(2000);
  });

  it("public ids are 22 base62 characters", () => {
    const id = newPublicId();
    expect(id).toHaveLength(22);
    expect(PublicIdSchema.safeParse(id).success).toBe(true);
    expect(newPublicId()).not.toBe(id);
  });
});

describe("CHECK builder", () => {
  it("refuses values that could break out of the SQL literal", () => {
    const t = sqliteTable("t", { c: text("c") });
    expect(() => oneOf("ck", t.c, ["ok", "bad'value"])).toThrow(/unsafe enum value/);
  });
});

describe("util", () => {
  it("chunks rows to respect D1's 100-parameter limit", () => {
    expect(rowsPerInsert(15)).toBe(6);
    expect(rowsPerInsert(200)).toBe(1);
    expect(chunked([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(() => chunked([1], 0)).toThrow();
  });

  it("converts instants without losing null", () => {
    expect(isoOrNull(null)).toBeNull();
    expect(isoOrNull(0)).toBe("1970-01-01T00:00:00.000Z");
    expect(msOrNull("1970-01-01T00:00:01Z")).toBe(1000);
    expect(() => msOrNull("nope")).toThrow();
  });

  it("canonical JSON sorts keys so equal values hash equally", async () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] } })).toBe('{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const body = { format: "jsonlogic-v1" as const, coverage: {}, anyOf: [], attestations: [], nomination: null };
    const h1 = await ruleSetHash({ ...body, rules: [{ id: "a", x: 1 }] } as unknown as Parameters<typeof ruleSetHash>[0]);
    const h2 = await ruleSetHash({ ...body, rules: [{ x: 1, id: "a" }] } as unknown as Parameters<typeof ruleSetHash>[0]);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cursors round-trip and malformed ones decode to null", () => {
    const c = { k: 1234, id: "abc" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor(encodeCursor({ k: "é-☃", id: "x" }))).toEqual({ k: "é-☃", id: "x" });
    expect(decodeCursor("!!!")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(encodeCursor({ k: null, id: "z" }))).toEqual({ k: null, id: "z" });
  });
});

describe("seed SQL rendering", () => {
  it("renders literals safely", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(undefined)).toBe("NULL");
    expect(sqlLiteral(true)).toBe("1");
    expect(sqlLiteral(12.5)).toBe("12.5");
    expect(sqlLiteral("it's")).toBe("'it''s'");
    expect(sqlLiteral(new Uint8Array([1, 255]))).toBe("X'01ff'");
    expect(() => sqlLiteral(Number.NaN)).toThrow();
  });

  it("inlines placeholders but not question marks inside quotes", () => {
    expect(inlineParams(`insert into "t?" ("a", "b") values (?, ?)`, ["x'y", 2])).toBe(`insert into "t?" ("a", "b") values ('x''y', 2)`);
    expect(inlineParams("select '?', ?", [1])).toBe("select '?', 1");
    expect(inlineParams("select 'a''?'", [])).toBe("select 'a''?'");
    expect(() => inlineParams("select ?", [])).toThrow(/more placeholders/);
    expect(() => inlineParams("select 1", [1])).toThrow(/unused/);
    expect(() => inlineParams("select 'open", [])).toThrow(/unterminated/);
  });

  it("renders one terminated statement per query", () => {
    expect(renderStatements([{ sql: "select ?", params: [1] }, { sql: "select 2;", params: [] }])).toBe("select 1;\nselect 2;\n");
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });

  it("lookup rows are generated from the taxonomy", () => {
    expect(humanize("campus_internal")).toBe("Campus internal");
    const stmts = lookupStatements();
    expect(stmts.filter((x) => x.includes("INTO opportunity_types"))).toHaveLength(33);
    expect(stmts.every((x) => x.startsWith("INSERT OR IGNORE"))).toBe(true);
  });
});
