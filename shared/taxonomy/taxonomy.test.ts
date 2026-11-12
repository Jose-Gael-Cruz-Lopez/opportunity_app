import { describe, expect, it } from "vitest";
import {
  canTransitionCycle,
  CycleKeySchema,
  majorFamilyForCip,
  cipMatchesPrefix,
  OPPORTUNITY_CATEGORIES,
  OPPORTUNITY_TYPES,
  OpportunityTypeSlugSchema,
  CYCLE_STATUSES,
  DEADLINE_KINDS,
  REQUIREMENT_KINDS,
  REVIEW_TASK_KINDS,
  IDENTITY_CATEGORIES,
  IDENTITY_VALUES,
} from "./index";

const SNAKE = /^[a-z0-9_]+$/;

describe("taxonomy", () => {
  it("has 33 opportunity types with unique ordinals and slugs", () => {
    expect(OPPORTUNITY_TYPES).toHaveLength(33);
    expect(new Set(OPPORTUNITY_TYPES.map((t) => t.ordinal)).size).toBe(33);
    expect(new Set(OPPORTUNITY_TYPES.map((t) => t.slug)).size).toBe(33);
    expect(OPPORTUNITY_TYPES.map((t) => t.ordinal)).toEqual(Array.from({ length: 33 }, (_, i) => i + 1));
    expect(OPPORTUNITY_TYPES.filter((t) => !t.inScope).map((t) => t.ordinal)).toEqual([32, 33]);
  });

  it("maps every category to known slugs", () => {
    for (const slugs of Object.values(OPPORTUNITY_CATEGORIES)) {
      for (const slug of slugs) expect(OpportunityTypeSlugSchema.safeParse(slug).success, slug).toBe(true);
    }
  });

  it("uses CHECK-safe values", () => {
    for (const list of [CYCLE_STATUSES, DEADLINE_KINDS, REQUIREMENT_KINDS, REVIEW_TASK_KINDS, IDENTITY_CATEGORIES]) {
      for (const v of list) expect(SNAKE.test(v), v).toBe(true);
    }
    for (const t of OPPORTUNITY_TYPES) expect(SNAKE.test(t.slug)).toBe(true);
    for (const c of IDENTITY_CATEGORIES) expect(IDENTITY_VALUES[c].length).toBeGreaterThan(0);
  });

  it("follows the cycle state machine", () => {
    expect(canTransitionCycle("open", "closed")).toBe(true);
    expect(canTransitionCycle("closed", "expected")).toBe(false);
    expect(canTransitionCycle("ended", "open")).toBe(false);
  });

  it("validates cycle keys", () => {
    expect(CycleKeySchema.safeParse("summer-2027").success).toBe(true);
    expect(CycleKeySchema.safeParse("ay-2027-28").success).toBe(true);
    expect(CycleKeySchema.safeParse("ay-2027-29").success).toBe(false);
    expect(CycleKeySchema.safeParse("2027-summer").success).toBe(false);
  });

  it("crosswalks CIP codes", () => {
    expect(majorFamilyForCip("11.0701")).toBe("computing");
    expect(majorFamilyForCip("26.0101")).toBe("life_sciences");
    expect(majorFamilyForCip("30.0101")).toBeNull();
    expect(cipMatchesPrefix("11.0701", "11")).toBe(true);
    expect(cipMatchesPrefix("14.0901", "11")).toBe(false);
  });
});
