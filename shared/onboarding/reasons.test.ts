import { describe, expect, it } from "vitest";
import { pickReasons, reason } from "./reasons";

const fits = [reason.interest("climate"), reason.noExperience(), reason.preferences(["Paid", "Remote OK"]), reason.type("scholarships")];

describe("pickReasons", () => {
  it("shows up to three fit reasons, strongest first", () => {
    expect(pickReasons(fits, false).map((r) => r.code)).toEqual(["INTEREST_MATCH", "NO_EXPERIENCE_NEEDED", "PREFERENCE_MATCH"]);
  });

  it("keeps one caveat on a stretch so the student sees why", () => {
    const shown = pickReasons([...fits, reason.tight("Tight timeline: needs 2 letters · due Dec 1")], true);
    expect(shown.map((r) => r.code)).toEqual(["INTEREST_MATCH", "NO_EXPERIENCE_NEEDED", "TIGHT_TIMELINE"]);
  });

  it("never lets fit reasons crowd out the community note", () => {
    const shown = pickReasons([...fits, reason.community()], false);
    expect(shown).toHaveLength(3);
    expect(shown.map((r) => r.code)).toEqual(["INTEREST_MATCH", "NO_EXPERIENCE_NEEDED", "COMMUNITY_PROGRAM"]);
    const stretch = pickReasons([...fits, reason.tight("Tight timeline · due Dec 1"), reason.community()], true);
    expect(stretch.map((r) => r.code)).toEqual(["INTEREST_MATCH", "TIGHT_TIMELINE", "COMMUNITY_PROGRAM"]);
  });

  it("uses a caveat only when there is too little fit evidence", () => {
    expect(pickReasons([reason.notFullyChecked()], false).map((r) => r.code)).toEqual(["NOT_FULLY_CHECKED"]);
    expect(pickReasons([], false)).toEqual([]);
  });

  it("words every reason as a fact about the program or the student's own answers, never a number about the student", () => {
    const all = [...fits, reason.skills(["Python", "data analysis"], true), reason.explore(false), reason.explore(true), reason.privateCheck(2), reason.campusUncertain()];
    for (const r of all) expect(r.text).not.toMatch(/%|score|rating|\d+ ?\/ ?\d+/i);
    expect(reason.skills(["Python", "data analysis"], true).text).toBe("Uses Python and data analysis from your resume");
  });
});
