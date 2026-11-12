import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { capExcerpt, citeProgram, describeDeadlineDate } from "./citation";
import { createR2RegistrySource, POINTER_TTL_MS, RELEASE_KEYS, RegistryUnavailableError, withTimeout, type R2Like } from "./registry";
import { RULED_CARD, TEST_ARTIFACT, TEST_ORIGIN } from "./testing/fixtures";

function bucket(objects: Record<string, unknown>): R2Like & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async get(key: string) {
      reads.push(key);
      if (!(key in objects)) return null;
      const value = objects[key];
      return { text: async () => (typeof value === "string" ? value : JSON.stringify(value)) };
    },
  };
}

const pointer = (release: number, sha: string) => ({ release, path: `releases/${release}/client-core.json`, sha256: sha, publishedAt: "2026-11-11T12:00:00Z" });

describe("R2 release reader", () => {
  it("loads the artifact the pointer names and caches it per isolate", async () => {
    const store = bucket({ [RELEASE_KEYS.pointer]: pointer(7, "a"), "releases/7/client-core.json": TEST_ARTIFACT });
    const load = createR2RegistrySource();
    const first = await load(store, 0);
    expect(first.release).toBe(7);
    expect(first.findCard(RULED_CARD.slug)?.name).toBe(RULED_CARD.name);
    await load(store, 1000);
    expect(store.reads).toEqual([RELEASE_KEYS.pointer, "releases/7/client-core.json"]);
  });

  it("picks up a new pointer after the TTL and keeps the last good release when R2 breaks", async () => {
    const objects: Record<string, unknown> = { [RELEASE_KEYS.pointer]: pointer(7, "a"), "releases/7/client-core.json": TEST_ARTIFACT };
    const store = bucket(objects);
    const load = createR2RegistrySource();
    await load(store, 0);
    objects[RELEASE_KEYS.pointer] = pointer(8, "b");
    objects["releases/8/client-core.json"] = { ...TEST_ARTIFACT, release: 8 };
    expect((await load(store, POINTER_TTL_MS + 1)).release).toBe(8);
    delete objects[RELEASE_KEYS.pointer];
    expect((await load(store, 3 * POINTER_TTL_MS)).release).toBe(8);
  });

  it("fails clearly when no release was ever published", async () => {
    await expect(createR2RegistrySource()(bucket({}), 0)).rejects.toBeInstanceOf(RegistryUnavailableError);
  });

  it("ignores detail JSON that does not match the contract", async () => {
    const store = bucket({
      [RELEASE_KEYS.pointer]: pointer(7, "a"),
      "releases/7/client-core.json": TEST_ARTIFACT,
      [RELEASE_KEYS.detail(7, RULED_CARD.slug)]: { not: "a detail" },
    });
    const registry = await createR2RegistrySource()(store, 0);
    expect(await registry.getDetail(RULED_CARD.slug)).toBeNull();
  });

  it("times reads out", async () => {
    await expect(withTimeout(new Promise(() => undefined), 5, "slow")).rejects.toBeInstanceOf(RegistryUnavailableError);
  });
});

describe("citations", () => {
  it("caps excerpts at 25 words", () => {
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    expect(capExcerpt(long)?.split(" ").filter((w) => w.startsWith("w"))).toHaveLength(25);
    expect(capExcerpt(null)).toBeNull();
  });

  it("labels sample data and names the verifier in citeAs", () => {
    const c = citeProgram(RULED_CARD, { origin: TEST_ORIGIN, release: 7 });
    expect(c.citeAs.startsWith("SAMPLE DATA, not a real program")).toBe(true);
    expect(c.citeAs).toContain("Verified 2026-11-01 by sample-curator against example.org");
    expect(c.recordVersion).toBe("7");
    expect(c.termsUrl.startsWith(TEST_ORIGIN)).toBe(true);
  });

  it("says when a record is being re-verified", () => {
    const card = { ...RULED_CARD, verification: { ...RULED_CARD.verification, state: "reverifying" as const } };
    expect(citeProgram(card, { origin: TEST_ORIGIN, release: 7 }).citeAs).toContain("Re-verification in progress since 2026-11-01");
  });

  it("describes applicant-local deadlines without a zone", () => {
    const local = RULED_CARD.deadlines.find((d) => d.tzMode === "applicant_local")!;
    expect(describeDeadlineDate(local)).toContain("applicant's local time");
  });
});

describe("import boundary", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !name.endsWith(".test.ts")) files.push(path);
    }
  };
  walk(fileURLToPath(new URL(".", import.meta.url)));

  it("never imports D1 repositories or device-only eligibility code", () => {
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/server\/db|@server\/db|eligibility\/sensitive|\.\.\/db\//);
      }
    }
  });
});
