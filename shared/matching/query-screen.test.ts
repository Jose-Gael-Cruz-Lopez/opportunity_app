import { describe, expect, it } from "vitest";
import { PARAPHRASE_QUERIES } from "./fixtures/hybrid-queries";
import { PROVISIONAL_QUERIES } from "./fixtures/queries";
import { screenQueryForEmbedding } from "./query-screen";

const reason = (q: string) => {
  const r = screenQueryForEmbedding(q);
  return r.ok ? "ok" : r.reason;
};

describe("screenQueryForEmbedding", () => {
  it("passes short topical queries and returns the normalized text", () => {
    expect(screenQueryForEmbedding("  Ocean   Science Summer ")).toEqual({ ok: true, text: "ocean science summer" });
    expect(reason("machine learning fellowship")).toBe("ok");
    expect(reason("software apprenticeship")).toBe("ok");
  });

  it("passes every labelled paraphrase query (the fixture eval would be meaningless otherwise)", () => {
    for (const q of PARAPHRASE_QUERIES) expect([q.id, reason(q.query)]).toEqual([q.id, "ok"]);
  });

  it("refuses empty, too short, too long and too wordy queries", () => {
    expect(reason("   ")).toBe("empty");
    expect(reason("ml")).toBe("too_short");
    expect(reason("x".repeat(81))).toBe("too_long");
    expect(reason("one two three four five six seven eight nine")).toBe("too_many_words");
  });

  it("refuses contact details, links and id-like numbers", () => {
    expect(reason("jo@example.org internships")).toBe("contact_or_id");
    expect(reason("www.example.org")).toBe("contact_or_id");
    expect(reason("call 555 123 4567")).toBe("contact_or_id");
    expect(reason("internships 2027")).toBe("contact_or_id");
  });

  it("refuses first-person disclosure", () => {
    expect(reason("internships for me")).toBe("first_person");
    expect(reason("I'm a sophomore in biology")).toBe("first_person");
    expect(reason("my major is chemistry")).toBe("first_person");
  });

  it("refuses status and identity vocabulary, including stems, hyphens and case", () => {
    for (const q of [
      "DACA scholarships",
      "undocumented students research",
      "first-gen fellowship",
      "first generation programs",
      "low-income summer programs",
      "Pell grant programs",
      "immigrant leadership",
      "scholarships for women",
      "LGBTQ+ internships",
      "veterans in tech",
      "foster youth grants",
      "disabled students fellowship",
      "Hispanic serving programs",
      "F1 visa internships",
      "green card internships",
      "citizenship required jobs",
    ]) {
      expect([q, reason(q)]).toEqual([q, "sensitive_term"]);
    }
  });

  it("never throws on odd input", () => {
    for (const q of ["'''", "—", "🙂🙂🙂", "a\u0000b c", "ＤＡＣＡ scholarships"]) expect(() => screenQueryForEmbedding(q)).not.toThrow();
    expect(reason("ＤＡＣＡ scholarships")).toBe("sensitive_term");
  });

  it("only affects the embeddings leg: provisional queries that it refuses still have lexical answers", () => {
    const refused = PROVISIONAL_QUERIES.filter((q) => !screenQueryForEmbedding(q.query).ok).map((q) => q.id);
    // "ml" is too short to embed; the lexical leg and the alias table handle it.
    expect(refused).toEqual(expect.arrayContaining(["p06"]));
  });
});
