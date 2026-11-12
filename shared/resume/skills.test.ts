import { describe, expect, it } from "vitest";
import { SKILLS } from "./lexicon/skills";
import { isKnownSkillName, lookupSkill, mineSkills, normalizeSkills } from "./skills";

const names = (raw: string[]): string[] => normalizeSkills(raw).map((s) => s.name);

describe("normalizeSkills", () => {
  it("folds spellings onto one canonical name", () => {
    expect(names(["js", "JavaScript", "javascript", "JS"])).toEqual(["JavaScript"]);
    expect(names(["reactjs", "React.js", "node", "NodeJS", "py", "c sharp", "golang"])).toEqual(["React", "Node.js", "Python", "C#", "Go"]);
  });

  it("splits compounds only when every part is known", () => {
    expect(names(["HTML/CSS", "C/C++", "HTML and CSS"])).toEqual(["HTML", "CSS", "C", "C++"]);
    expect(names(["Python (NumPy, pandas)"])).toEqual(["Python", "NumPy", "pandas"]);
    expect(names(["Research and Development"])).toEqual(["Research and Development"]);
  });

  it("drops proficiency qualifiers", () => {
    expect(names(["Spanish (fluent)", "Python (3 years)", "Java - intermediate", "French (native speaker)"])).toEqual(["Spanish", "Python", "Java", "French"]);
  });

  it("keeps unknown skills for review but marks them unknown", () => {
    const [s] = normalizeSkills(["Quantum Basket Weaving"]);
    expect(s).toMatchObject({ id: "quantum-basket-weaving", name: "Quantum Basket Weaving", known: false, category: "other" });
  });

  it("keeps the raw text for the device and dedupes by id", () => {
    const out = normalizeSkills(["• python3", "Python"]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "python", name: "Python", known: true, raw: "• python3" });
  });

  it("ignores junk", () => {
    expect(normalizeSkills(["", "   ", 42 as unknown as string, "a".repeat(80), "one two three four five six seven"])).toEqual([]);
  });
});

describe("mineSkills", () => {
  it("reads known tools out of sentences, longest match first", () => {
    expect(mineSkills("Built a React Native app with Firebase and trained models in PyTorch")).toEqual(["React Native", "Firebase", "PyTorch"]);
    expect(mineSkills("Used machine learning and Node.js")).toEqual(["Machine Learning", "Node.js"]);
  });

  it("does not read ordinary words as skills", () => {
    expect(mineSkills("Learned to react quickly; will go to the spring fair; can excel under pressure; R&D")).toEqual([]);
  });
});

describe("the curated list", () => {
  it("has unique canonical names and resolvable aliases", () => {
    const seen = new Set<string>();
    for (const s of SKILLS) {
      expect(seen.has(s.name), s.name).toBe(false);
      seen.add(s.name);
      expect(lookupSkill(s.name)?.name).toBe(s.name);
      expect(isKnownSkillName(s.name)).toBe(true);
    }
    expect(SKILLS.length).toBeGreaterThan(150);
    expect(isKnownSkillName("javascript")).toBe(false);
  });
});
