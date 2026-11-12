import { describe, expect, it } from "vitest";
import { personalDisclosure } from "./personal-disclosure";
import { questionLooksPrivate } from "@/components/readiness/readiness-model";
import { checkQuestion } from "@/pages/ask/model";

describe("personalDisclosure", () => {
  it("stops first-person disclosures the old property-name matcher missed", () => {
    expect(personalDisclosure("I'm Black")).toBe("race or ethnicity");
    expect(personalDisclosure("I’m trans, is that okay to mention?")).toBe("gender or sexual orientation");
    expect(personalDisclosure("My parents never went to college, does that help?")).toBe("first-generation status");
    expect(personalDisclosure("I'm the first in my family to go to college.")).toBe("first-generation status");
    expect(personalDisclosure("Can I apply on a student visa?")).toBe("citizenship or immigration status");
    expect(personalDisclosure("I receive a Pell Grant, which ones fit?")).toBe("income or financial aid status");
    expect(personalDisclosure("My parents are undocumented. Can I still apply?")).toBe("citizenship or immigration status");
  });

  it("lets topic words through when the student is not describing themselves", () => {
    expect(personalDisclosure("Can I start my essay on race?")).toBeNull();
    expect(personalDisclosure("Does the program require US citizenship?")).toBeNull();
    expect(personalDisclosure("Is the stipend counted as income?")).toBeNull();
    expect(personalDisclosure("Which programs are for first-generation students?")).toBeNull();
    expect(personalDisclosure("I'm a sophomore. Is citizenship required?")).toBeNull();
    expect(personalDisclosure("When should I ask for letters?")).toBeNull();
  });
});

describe("the readiness assistant and Ask Novus share one check", () => {
  const phrasings = ["I'm Black", "I'm trans", "My parents never went to college, does that help?", "Can I start my essay on race?", "How long should the statement be?"];
  it("agree on every phrasing", () => {
    for (const q of phrasings) {
      const ask = checkQuestion(q);
      expect(questionLooksPrivate(q)).toBe(!ask.ok && ask.reason === "personal_status");
    }
  });

  it("blocks the disclosures and passes the harmless questions in the assistant", () => {
    expect(questionLooksPrivate("I'm Black")).toBe(true);
    expect(questionLooksPrivate("I'm trans")).toBe(true);
    expect(questionLooksPrivate("My parents never went to college, does that help?")).toBe(true);
    expect(questionLooksPrivate("Can I start my essay on race?")).toBe(false);
  });
});
